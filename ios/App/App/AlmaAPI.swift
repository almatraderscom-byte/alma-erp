//
//  AlmaAPI.swift
//  App
//
//  Native networking layer for the SwiftUI screens. The WKWebViews (Capacitor tab +
//  the plain content tabs) all share WKWebsiteDataStore.default(), which is where the
//  logged-in Supabase session cookies for alma-erp-six.vercel.app live. Native screens
//  can't read those directly through URLSession, so this class bridges them:
//
//    WKHTTPCookieStore (web login) ──copy──▶ HTTPCookieStorage.shared ──▶ URLSession
//
//  The copy is cheap but WKHTTPCookieStore is main-thread-only and async, so we sync
//  lazily (at most every 30s) instead of before every request. If the ERP answers
//  401/403 — or Next.js 307-redirects to /login, which is its real "not logged in"
//  signal — we force one re-sync and retry once before surfacing notAuthenticated.
//  Redirect following is disabled on the session so that auth redirect stays visible
//  instead of being silently followed to the login HTML page.
//

import Foundation
import WebKit

// MARK: - Errors

enum AlmaAPIError: LocalizedError {
    /// Session cookies missing/expired — the owner must log in again in the web tab.
    case notAuthenticated
    /// Server answered with a non-2xx status; body kept (truncated) for debugging.
    case http(status: Int, body: String)
    /// 2xx received but the JSON didn't match the expected shape.
    case decoding(Error)
    /// Network-level failure (offline, timeout, DNS…).
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            return "Not logged in — open the app's web tab and sign in again."
        case .http(let status, let body):
            return "Server error \(status): \(body.prefix(200))"
        case .decoding(let err):
            return "Unexpected response format: \(err.localizedDescription)"
        case .transport(let err):
            return err.localizedDescription
        }
    }
}

// MARK: - AnyEncodable

/// Type-erased Encodable so callers can pass heterogenous dictionaries as bodies,
/// e.g. `["status": AnyEncodable("done"), "qty": AnyEncodable(3)]`, without defining
/// a Codable struct for every tiny PATCH.
struct AnyEncodable: Encodable {
    private let encodeClosure: (Encoder) throws -> Void
    init<E: Encodable>(_ value: E) {
        encodeClosure = { try value.encode(to: $0) }
    }
    func encode(to encoder: Encoder) throws {
        try encodeClosure(encoder)
    }
}

// MARK: - AlmaAPI

final class AlmaAPI: NSObject {

    static let shared = AlmaAPI()

    static let baseURL = URL(string: "https://alma-erp-six.vercel.app")!

    /// Posted (on main) when a request came back unauthenticated even after a cookie
    /// re-sync — the UI should prompt the owner to log in via the web tab.
    static let authExpiredNotification = Notification.Name("almaAuthExpired")

    /// Re-sync cookies from WKWebView at most this often; a forced sync happens anyway
    /// on the retry path, so a short staleness window is harmless.
    private static let cookieSyncInterval: TimeInterval = 30

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder = JSONEncoder()

    /// Guarded by `syncLock` — requests can arrive from any task/thread.
    private var lastCookieSync: Date?
    private let syncLock = NSLock()

    private override init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        // Default config uses HTTPCookieStorage.shared — the target of syncCookies().
        config.httpShouldSetCookies = true
        config.httpAdditionalHeaders = [
            "Accept": "application/json",
            // Some Next.js middleware branches on this to answer JSON instead of HTML.
            "X-Requested-With": "XMLHttpRequest",
        ]

        // Delegate-based session so we can refuse redirect-following (see extension below):
        // a 307 → /login must reach our status check, not be transparently followed.
        let delegate = RedirectBlocker()
        session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)

        let d = JSONDecoder()
        d.dateDecodingStrategy = AlmaAPI.tolerantDateStrategy
        decoder = d // keys stay camelCase — the API is JS camelCase already

        super.init()
    }

    // MARK: Cookie bridge

    /// Copies every cookie from the shared WKWebsiteDataStore into HTTPCookieStorage.shared
    /// so URLSession sends the same session as the web views. WKHTTPCookieStore is a
    /// main-thread API with a completion handler — hop to main and bridge to async.
    func syncCookies() async {
        let cookies: [HTTPCookie] = await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                WKWebsiteDataStore.default().httpCookieStore.getAllCookies { all in
                    continuation.resume(returning: all)
                }
            }
        }
        let storage = HTTPCookieStorage.shared
        for cookie in cookies {
            storage.setCookie(cookie)
        }
        setLastSync(Date())
    }

    /// Forget the last sync time so the very next request re-copies cookies first.
    /// Call after anything that may have changed the web session (login, logout).
    func invalidateCookieCache() {
        setLastSync(nil)
    }

    /// Lazy sync: only hit the (main-thread) WK cookie store when the copy is stale.
    private func syncCookiesIfStale() async {
        if let last = lastSync(), Date().timeIntervalSince(last) < Self.cookieSyncInterval { return }
        await syncCookies()
    }

    // Synchronous lock helpers — NSLock must not be held across (or called from)
    // async suspension contexts, so the critical sections live in sync functions.
    private func lastSync() -> Date? {
        syncLock.lock(); defer { syncLock.unlock() }
        return lastCookieSync
    }
    private func setLastSync(_ date: Date?) {
        syncLock.lock(); defer { syncLock.unlock() }
        lastCookieSync = date
    }

    // MARK: Public requests

    /// GET a JSON endpoint. Nil query values are skipped, so callers can pass
    /// optional filters straight through: `get("/api/orders", query: ["status": filter])`.
    func get<T: Decodable>(_ path: String, query: [String: String?] = [:]) async throws -> T {
        let data = try await perform(request: makeRequest(method: "GET", path: path, query: query, bodyData: nil))
        return try decode(data)
    }

    /// POST / PATCH / DELETE with an optional JSON body.
    func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?) async throws -> T {
        var bodyData: Data?
        if let body {
            do { bodyData = try encoder.encode(body) } catch { throw AlmaAPIError.decoding(error) }
        }
        let data = try await perform(request: makeRequest(method: method, path: path, query: [:], bodyData: bodyData))
        return try decode(data)
    }

    /// Body-less variant so `send("DELETE", "/api/x")` compiles without spelling a generic.
    func send<T: Decodable>(_ method: String, _ path: String) async throws -> T {
        try await send(method, path, body: Optional<AnyEncodable>.none)
    }

    /// Raw bytes for debugging (`String(data:encoding:)` it to eyeball a payload).
    func getRaw(_ path: String) async throws -> Data {
        try await perform(request: makeRequest(method: "GET", path: path, query: [:], bodyData: nil))
    }

    // MARK: Core pipeline

    private func makeRequest(method: String, path: String, query: [String: String?], bodyData: Data?) -> URLRequest {
        var components = URLComponents(url: Self.baseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
        if !items.isEmpty { components.queryItems = items }

        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        if let bodyData {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    /// One request with the auth-retry loop: stale-cookie check → attempt →
    /// on auth failure force a fresh cookie copy and try exactly once more.
    private func perform(request: URLRequest) async throws -> Data {
        await syncCookiesIfStale()

        let (data, response) = try await attempt(request)
        if !Self.looksUnauthenticated(response) {
            return try validated(data, response)
        }

        // First attempt bounced — the URLSession copy of the cookies may simply be
        // older than the web session (Supabase rotates tokens). Re-copy and retry once.
        invalidateCookieCache()
        await syncCookies()

        let (retryData, retryResponse) = try await attempt(request)
        if Self.looksUnauthenticated(retryResponse) {
            // Genuinely logged out — tell the UI layer so it can surface the login flow.
            await MainActor.run {
                NotificationCenter.default.post(name: Self.authExpiredNotification, object: nil)
            }
            throw AlmaAPIError.notAuthenticated
        }
        return try validated(retryData, retryResponse)
    }

    /// Single wire round-trip; transport errors wrapped, non-HTTP responses rejected.
    private func attempt(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw AlmaAPIError.transport(URLError(.badServerResponse))
            }
            return (data, http)
        } catch let error as AlmaAPIError {
            throw error
        } catch {
            throw AlmaAPIError.transport(error)
        }
    }

    /// Next.js signals "not logged in" two ways: a plain 401/403 from API routes, or a
    /// 307/302 redirect to /login from middleware. Redirects are never auto-followed
    /// (RedirectBlocker), so the 3xx + Location header is visible here.
    private static func looksUnauthenticated(_ response: HTTPURLResponse) -> Bool {
        if response.statusCode == 401 || response.statusCode == 403 { return true }
        if (300..<400).contains(response.statusCode) {
            if let location = response.value(forHTTPHeaderField: "Location"),
               location.contains("/login") {
                return true
            }
            if response.url?.path.contains("/login") == true { return true }
        }
        return false
    }

    private func validated(_ data: Data, _ response: HTTPURLResponse) throws -> Data {
        guard (200..<300).contains(response.statusCode) else {
            throw AlmaAPIError.http(
                status: response.statusCode,
                body: String(data: data, encoding: .utf8) ?? "<non-utf8 body>"
            )
        }
        return data
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw AlmaAPIError.decoding(error)
        }
    }

    // MARK: Date decoding

    /// The ERP's JSON mixes date shapes (Postgres timestamps serialized by JS, some
    /// epoch-ms fields), so try in order: ISO8601 with fractional seconds → ISO8601
    /// plain → epoch milliseconds (JS Date.now()) → epoch seconds.
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let tolerantDateStrategy = JSONDecoder.DateDecodingStrategy.custom { decoder in
        let container = try decoder.singleValueContainer()
        if let string = try? container.decode(String.self) {
            if let date = isoFractional.date(from: string) { return date }
            if let date = isoPlain.date(from: string) { return date }
            if let ms = Double(string) { return dateFromEpoch(ms) }
        }
        if let number = try? container.decode(Double.self) {
            return dateFromEpoch(number)
        }
        throw DecodingError.dataCorrupted(DecodingError.Context(
            codingPath: decoder.codingPath,
            debugDescription: "Unrecognized date format"
        ))
    }

    /// Heuristic: anything past year ~5138 in seconds must be milliseconds.
    private static func dateFromEpoch(_ value: Double) -> Date {
        value > 100_000_000_000
            ? Date(timeIntervalSince1970: value / 1000)
            : Date(timeIntervalSince1970: value)
    }
}

// MARK: - Redirect blocking

/// Refuses all automatic redirect-following so a middleware 307 → /login surfaces as
/// a 3xx response (with its Location header) instead of a decoded login HTML page.
/// API JSON endpoints never legitimately redirect, so nothing is lost.
private final class RedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil) // nil = don't follow; deliver the 3xx to the caller
    }
}
