//
//  NativeLoginSwiftUI.swift
//  ALMA ERP — native sign-in (web /login parity, owner request 2026-07-11).
//
//  Speaks the NextAuth credentials flow directly:
//    GET  /api/auth/csrf                        → { csrfToken } (+ csrf cookie)
//    POST /api/auth/callback/credentials        → form-encoded csrfToken/identifier/
//                                                 password/redirect=false/json=true
//    GET  /api/auth/session                     → { user } = success
//  Cookies land in HTTPCookieStorage.shared (same store AlmaAPI's URLSession reads),
//  then get pushed into WKWebsiteDataStore.default() so every WebView is signed in
//  too — the exact REVERSE of AlmaAPI.syncCookies().
//
//  The password is never logged or persisted — fields use textContentType so the
//  iOS password manager autofills; nothing touches UserDefaults.
//

import SwiftUI
import WebKit

// MARK: - NextAuth wire flow

private enum NativeLoginFlow {
    struct CsrfResponse: Decodable { let csrfToken: String? }
    struct SessionResponse: Decodable {
        struct User: Decodable { let name: String?, email: String? }
        let user: User?
    }

    enum LoginError: Error { case badCredentials, transport }

    /// Full credentials round-trip. Returns the signed-in display name (if any).
    /// Throws .badCredentials on a NextAuth error, .transport on anything else.
    static func signIn(identifier: String, password: String) async throws -> String? {
        // Default config → HTTPCookieStorage.shared, the same store AlmaAPI reads.
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.httpShouldSetCookies = true
        let session = URLSession(configuration: config)
        let base = AlmaAPI.baseURL

        // 1. CSRF token (sets the next-auth.csrf-token cookie in the shared store).
        var csrfReq = URLRequest(url: base.appendingPathComponent("/api/auth/csrf"))
        csrfReq.setValue("application/json", forHTTPHeaderField: "Accept")
        let (csrfData, csrfResp) = try await session.data(for: csrfReq)
        guard (csrfResp as? HTTPURLResponse)?.statusCode == 200,
              let token = (try? JSONDecoder().decode(CsrfResponse.self, from: csrfData))?.csrfToken,
              !token.isEmpty else { throw LoginError.transport }

        // 2. Credentials callback — form-encoded, json=true → 200 with {url}.
        var req = URLRequest(url: base.appendingPathComponent("/api/auth/callback/credentials"))
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let form: [(String, String)] = [
            ("csrfToken", token),
            ("identifier", identifier),
            ("password", password),
            ("redirect", "false"),
            ("json", "true"),
            ("callbackUrl", base.absoluteString),
        ]
        req.httpBody = form
            .map { "\($0.0)=\(formEncode($0.1))" }
            .joined(separator: "&")
            .data(using: .utf8)
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw LoginError.transport }
        // NextAuth answers 200 {url:...} — a url containing error= means bad login;
        // 401 shows up too depending on version. Treat both as bad credentials.
        if http.statusCode == 401 { throw LoginError.badCredentials }
        guard http.statusCode == 200 else { throw LoginError.transport }
        if let body = String(data: data, encoding: .utf8), body.contains("error=") {
            throw LoginError.badCredentials
        }

        // 3. Confirm the session actually exists (the web page polls getSession too).
        var confirmed: SessionResponse.User? = nil
        for attemptIndex in 0..<5 {
            if attemptIndex > 0 { try? await Task.sleep(nanoseconds: 400_000_000) }
            var sReq = URLRequest(url: base.appendingPathComponent("/api/auth/session"))
            sReq.setValue("application/json", forHTTPHeaderField: "Accept")
            guard let (sData, sResp) = try? await session.data(for: sReq),
                  (sResp as? HTTPURLResponse)?.statusCode == 200 else { continue }
            if let user = (try? JSONDecoder().decode(SessionResponse.self, from: sData))?.user {
                confirmed = user
                break
            }
        }
        guard let confirmed else { throw LoginError.badCredentials }

        // 4. Push the fresh cookies into the WebView store (reverse of syncCookies)
        //    so web tabs/escapes are signed in without a separate web login.
        let cookies = HTTPCookieStorage.shared.cookies(for: base) ?? []
        await MainActor.run {
            let store = WKWebsiteDataStore.default().httpCookieStore
            for cookie in cookies { store.setCookie(cookie) }
        }
        // AlmaAPI's lazy sync must not overwrite the new session with stale WK state.
        AlmaAPI.shared.invalidateCookieCache()
        return confirmed.name ?? confirmed.email
    }

    private static func formEncode(_ s: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct NativeLoginScreen: View {
    let onSuccess: () -> Void
    let openWeb: (_ path: String, _ title: String) -> Void

    @State private var identifier = ""
    @State private var password = ""
    @State private var showPassword = false
    @State private var loading = false
    @State private var errorText: String? = nil
    @State private var welcome: String? = nil
    @FocusState private var focus: Field?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    private enum Field { case identifier, password }

    // Web login card golds (bg-gold/15, text-gold-lt) — the page is dark-only.
    private let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)   // #F4A28C
    private let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)  // #C45A3C

    var body: some View {
        ZStack {
            AgentAuroraBackground()
            ScrollView {
                VStack(spacing: 0) {
                    monogram.padding(.top, 70)
                    Text("ALMA ERP")
                        .font(.system(size: 11, weight: .black)).tracking(3.2)
                        .foregroundStyle(goldLt).padding(.top, 18)
                    Text("Sign in")
                        .font(.title3.weight(.bold)).padding(.top, 6)
                    Text("Secure multi-business workspace")
                        .font(.caption2).foregroundStyle(.secondary).padding(.top, 2)

                    card.padding(.top, 26)

                    Button {
                        openWeb("/forgot-password", "Password reset")
                    } label: {
                        Text("Forgot password?").font(.caption).foregroundStyle(goldLt)
                    }
                    .buttonStyle(.plain).padding(.top, 22)

                    Button {
                        openWeb("/login", "Login")
                    } label: {
                        Label("ওয়েবে লগইন", systemImage: "safari")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain).padding(.top, 10).padding(.bottom, 40)
                }
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(AlmaSwiftTheme.rootBg(scheme).ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
    }

    private var monogram: some View {
        Text("A")
            .font(.system(size: 20, weight: .black))
            .foregroundStyle(goldLt)
            .frame(width: 52, height: 52)
            .background(goldDim.opacity(0.15), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(goldDim.opacity(0.5), lineWidth: 1))
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 16) {
            field(label: "PHONE OR EMAIL") {
                TextField("+8801XXXXXXXXX or you@company.com", text: $identifier)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .identifier)
                    .submitLabel(.next)
                    .onSubmit { focus = .password }
            }
            field(label: "PASSWORD") {
                HStack(spacing: 8) {
                    Group {
                        if showPassword {
                            TextField("••••••••", text: $password)
                        } else {
                            SecureField("••••••••", text: $password)
                        }
                    }
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .password)
                    .submitLabel(.go)
                    .onSubmit { submit() }
                    Button { showPassword.toggle() } label: {
                        Image(systemName: showPassword ? "eye.slash" : "eye")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }

            if let errorText {
                Label(errorText, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color(red: 0.937, green: 0.267, blue: 0.267))
            }
            if let welcome {
                Label("স্বাগতম, \(welcome)!", systemImage: "checkmark.seal.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(red: 0.020, green: 0.588, blue: 0.412))
            }

            Button(action: submit) {
                HStack(spacing: 8) {
                    if loading { ProgressView().tint(.white) }
                    Text(loading ? "Signing in…" : "Continue")
                        .font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(canSubmit ? AlmaSwiftTheme.coral : AlmaSwiftTheme.coral.opacity(0.45),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit || loading)
        }
        .padding(22)
        .frame(maxWidth: 380)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(goldDim.opacity(0.35), lineWidth: 1))
        .padding(.horizontal, 22)
    }

    private func field(label: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.system(size: 9, weight: .bold)).tracking(1.2)
                .foregroundStyle(.secondary)
            content()
                .font(.subheadline)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Color.primary.opacity(0.06),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        }
    }

    private var canSubmit: Bool {
        !identifier.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
    }

    private func submit() {
        guard canSubmit, !loading else { return }
        loading = true; errorText = nil
        let id = identifier.trimmingCharacters(in: .whitespaces)
        let pw = password
        Task {
            defer { loading = false }
            do {
                let name = try await NativeLoginFlow.signIn(identifier: id, password: pw)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                welcome = name
                password = ""
                try? await Task.sleep(nanoseconds: 500_000_000)
                onSuccess()
                dismiss()   // pushed from a nav (router) or presented — either way, leave
            } catch NativeLoginFlow.LoginError.badCredentials {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                errorText = "Invalid phone/email or password"
            } catch {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                errorText = "Login failed — নেটওয়ার্ক চেক করে আবার চেষ্টা করুন"
            }
        }
    }
}

#Preview {
    if #available(iOS 17.0, *) {
        NativeLoginScreen(onSuccess: {}, openWeb: { _, _ in })
            .preferredColorScheme(.dark)
    }
}
