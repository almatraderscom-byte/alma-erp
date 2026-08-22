//
//  AlmaSession.swift
//  ALMA ERP — ONE shared identity for the native shell (role · owner flag ·
//  business access · current business). Mirrors the web's ActorContext +
//  BusinessContext: every tab, More row, deep link and write button asks THIS
//  object, never its own ad-hoc `/api/users/me` fetch.
//
//  Source of truth: GET /api/users/me → { user: { id, name, role, isSystemOwner,
//  businessAccess } } (the same route the web's drawer trusts). Loaded at launch,
//  re-loaded after a native sign-in and on foreground, cleared on sign-out.
//
//  Fail CLOSED: until the server answers, `effectiveRole` is VIEWER (the web's own
//  normalisation of an unknown role) and the shell offers only what a VIEWER may
//  see — nothing privileged ever flashes. To avoid a visible rebuild on every cold
//  start, the LAST CONFIRMED identity is cached per backend host and used
//  instantly; a server answer that differs triggers one rebuild. A 401 keeps the
//  cache (transient on cold start) — only an explicit sign-out wipes it.
//
//  Current business mirrors the web rule (BusinessContext): the stored choice if
//  the user may access it, else the first allowed business. A Trading-only staff
//  member therefore lands in Trading, never on a Lifestyle screen that 403s.
//

import Foundation
import Observation

extension Notification.Name {
    /// Posted on the main thread when role / owner / business access / user id
    /// CHANGED after a load — the tab bar rebuilds itself from the new identity.
    static let almaSessionChanged = Notification.Name("almaSessionChanged")
    /// Posted when the current business changed (switcher or access clamp).
    static let almaBusinessChanged = Notification.Name("almaBusinessChanged")
}

@available(iOS 17.0, *)
@Observable
@MainActor
final class AlmaSession {

    static let shared = AlmaSession()

    // MARK: Identity

    /// Server role string normalised, or nil until the first load completes.
    private(set) var role: AlmaRole?
    private(set) var isOwner = false
    private(set) var userId: String?
    private(set) var name: String = ""
    /// Businesses the user may switch to. Empty until loaded (→ treated as none).
    private(set) var businessAccess: [AlmaBusinessId] = []
    /// Tri-state auth: nil = not yet known / offline, true = signed in, false = 401.
    private(set) var authed: Bool?
    /// Bumps after every COMPLETED load (screens key their refetch on it).
    private(set) var authVersion = 0
    private(set) var loaded = false

    /// The role every gate uses. Owner ⇒ SUPER_ADMIN; otherwise the loaded role;
    /// not loaded ⇒ VIEWER (least privilege, same as the web's normalizer).
    var effectiveRole: AlmaRole {
        if isOwner { return .SUPER_ADMIN }
        return role ?? .VIEWER
    }

    /// Businesses the user may access — the owner always has all three
    /// (`normalizeBusinessAccessForRole`).
    var allowedBusinesses: [AlmaBusinessId] {
        AlmaBusinessId.accessForRole(businessAccess, role: effectiveRole)
    }

    var isAdmin: Bool { effectiveRole == .SUPER_ADMIN || effectiveRole == .ADMIN }

    // MARK: Current business

    private static let businessKey = "alma-business-id"   // web STORAGE_KEY

    private var storedBusiness: AlmaBusinessId? {
        AlmaBusinessId(rawValue: UserDefaults.standard.string(forKey: Self.businessKey) ?? "")
    }

    /// The business the shell is in — BusinessContext's rule: stored if allowed,
    /// else the first allowed, else Lifestyle (before access is known).
    var businessId: AlmaBusinessId {
        let allowed = allowedBusinesses
        if let stored = storedBusiness, allowed.isEmpty || allowed.contains(stored) { return stored }
        return allowed.first ?? AlmaBusinessId.default
    }

    /// Switch business (the More "Business" pill). Ignored when not allowed.
    func setBusiness(_ id: AlmaBusinessId) {
        guard allowedBusinesses.contains(id) else { return }
        let before = businessId
        UserDefaults.standard.set(id.rawValue, forKey: Self.businessKey)
        if before != businessId {
            NotificationCenter.default.post(name: .almaBusinessChanged, object: nil)
        }
    }

    // MARK: Gates

    /// Can this user SEE / open `path`? The web's two gates combined: the route must
    /// be valid for the business it belongs to (proxy.ts + BusinessContext) AND
    /// the user must have access to that business.
    func canSee(_ path: String) -> Bool {
        let bare = path.split(separator: "?").first.map(String.init) ?? path
        let business = AlmaAccess.business(for: bare, current: businessId)
        // Login / recovery / public share pages never need a business.
        if bare.hasPrefix("/login") || bare.hasPrefix("/forgot-password")
            || bare.hasPrefix("/reset-password") || bare.hasPrefix("/invoice/share") { return true }
        guard allowedBusinesses.contains(business) else { return false }
        return AlmaAccess.isPathAllowedForRole(bare, role: effectiveRole, business: business)
    }

    /// `can(role, capability)` for the signed-in user.
    func can(_ capability: AlmaCapability) -> Bool {
        AlmaAccess.can(effectiveRole, capability)
    }

    /// The web nav this user sees in the current business.
    var nav: [AlmaNavItem] {
        AlmaAccess.nav(role: effectiveRole, business: businessId)
    }

    /// Where the web lands this user (`roleHomePath`).
    var homePath: String {
        AlmaAccess.roleHomePath(role: effectiveRole, business: businessId)
    }

    // MARK: Loading

    private struct MeResponse: Decodable {
        struct User: Decodable {
            let id: String?
            let name: String?
            let role: String?
            let isSystemOwner: Bool?
            let businessAccess: String?
        }
        let user: User?
    }

    /// Identity tuple that decides the tab bar — a change rebuilds the shell.
    private struct Snapshot: Codable, Equatable {
        var userId: String?
        var role: AlmaRole?
        var isOwner: Bool
        var businessAccess: [AlmaBusinessId]
        var name: String
    }

    private var snapshot: Snapshot {
        Snapshot(userId: userId, role: role, isOwner: isOwner, businessAccess: businessAccess, name: name)
    }

    private static var cacheKey: String { "alma.session.cache." + (AlmaAPI.baseURL.host ?? "prod") }

    private var inflight: Task<Void, Never>?

    private init() {
        restoreCache()
    }

    /// Seed from the last confirmed identity so the first tab bar is already right
    /// for a returning user (no VIEWER → real-role flicker). Nothing is trusted
    /// beyond what the server confirmed last time on this same host.
    private func restoreCache() {
        guard let data = UserDefaults.standard.data(forKey: Self.cacheKey),
              let s = try? JSONDecoder().decode(Snapshot.self, from: data) else { return }
        apply(s)
    }

    private func apply(_ s: Snapshot) {
        userId = s.userId
        role = s.role
        isOwner = s.isOwner
        businessAccess = s.businessAccess
        name = s.name
    }

    private func persist(_ s: Snapshot) {
        if let data = try? JSONEncoder().encode(s) {
            UserDefaults.standard.set(data, forKey: Self.cacheKey)
        }
    }

    /// Load (or re-load) identity. Coalesces concurrent callers.
    func load(force: Bool = false) async {
        #if DEBUG
        if fixtureLocked { return }
        #endif
        if loaded && !force { return }
        if let inflight { await inflight.value; return }
        let task = Task { await self.fetch() }
        inflight = task
        await task.value
        inflight = nil
    }

    /// Force a fresh fetch — right after a native sign-in, or on foreground.
    func reload() async { await load(force: true) }

    private var lastLoadedAt: Date?

    /// Foreground re-confirmation, at most once a minute.
    func reloadIfStale(_ interval: TimeInterval = 60) async {
        if let last = lastLoadedAt, Date().timeIntervalSince(last) < interval { return }
        await load(force: true)
    }

    private func fetch() async {
        let before = snapshot
        let beforeBusiness = businessId
        do {
            var me: MeResponse
            do {
                me = try await AlmaAPI.shared.get("/api/users/me")
            } catch AlmaAPIError.http(let status, _) where status == 403 {
                // /users/me defaults to Lifestyle when the user has several
                // businesses — a CDIT+Trading user 403s there. Ask again for a
                // business we know (or each in turn) before giving up.
                me = try await fetchMeAnyBusiness()
            }
            guard let u = me.user else { return }
            let next = Snapshot(
                userId: u.id,
                role: AlmaRole.normalize(u.role),
                isOwner: u.isSystemOwner ?? false,
                businessAccess: AlmaBusinessId.parseAccess(u.businessAccess),
                name: (u.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
            apply(next)
            persist(next)
            authed = true
        } catch AlmaAPIError.notAuthenticated {
            authed = false
        } catch {
            // Offline / transient: keep whatever we had; authed stays unknown.
        }
        loaded = true
        lastLoadedAt = Date()
        authVersion += 1
        if snapshot != before {
            NotificationCenter.default.post(name: .almaSessionChanged, object: nil)
        }
        if businessId != beforeBusiness {
            NotificationCenter.default.post(name: .almaBusinessChanged, object: nil)
        }
    }

    private func fetchMeAnyBusiness() async throws -> MeResponse {
        var candidates = businessAccess
        for b in AlmaBusinessId.all where !candidates.contains(b) { candidates.append(b) }
        var lastError: Error = AlmaAPIError.http(status: 403, body: "")
        for b in candidates {
            do {
                return try await AlmaAPI.shared.get("/api/users/me", query: ["business_id": b.rawValue])
            } catch AlmaAPIError.http(let status, _) where status == 403 {
                lastError = AlmaAPIError.http(status: status, body: "")
                continue
            }
        }
        throw lastError
    }

    /// Explicit sign-out: wipe identity + cache, fail closed, rebuild the shell.
    func signedOut() {
        let before = snapshot
        userId = nil; role = nil; isOwner = false; businessAccess = []; name = ""
        authed = false
        loaded = false
        UserDefaults.standard.removeObject(forKey: Self.cacheKey)
        authVersion += 1
        if snapshot != before {
            NotificationCenter.default.post(name: .almaSessionChanged, object: nil)
        }
    }

    #if DEBUG
    /// Headless sim self-test hook (DEBUG only, never ships): `ALMA_ACCESS_FIXTURE=
    /// ROLE[:BUSINESS_ACCESS_CSV]` pins the identity so every role × business tab
    /// bar / More menu can be screenshot-verified without five real sign-ins.
    /// Example: SIMCTL_CHILD_ALMA_ACCESS_FIXTURE=STAFF:ALMA_TRADING
    func applyFixtureIfRequested() {
        guard let raw = ProcessInfo.processInfo.environment["ALMA_ACCESS_FIXTURE"], !raw.isEmpty else { return }
        let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
        let r = AlmaRole.normalize(parts.first)
        let access = parts.count > 1 ? AlmaBusinessId.parseAccess(parts[1]) : AlmaBusinessId.all
        apply(Snapshot(userId: "fixture", role: r, isOwner: r == .SUPER_ADMIN,
                       businessAccess: access, name: "Fixture \(r.label)"))
        authed = true
        loaded = true
        fixtureLocked = true
        authVersion += 1
        NotificationCenter.default.post(name: .almaSessionChanged, object: nil)
    }
    /// While a fixture is pinned, server loads must not overwrite it.
    private(set) var fixtureLocked = false
    #endif
}

#if DEBUG
@available(iOS 17.0, *)
extension AlmaSession {
    /// `load` honours a pinned fixture (DEBUG only).
    var isFixtureLocked: Bool { fixtureLocked }
}
#endif
