//
//  NativeAuthRecoverySwiftUI.swift
//  ALMA ERP — NP-4: native auth recovery + wallet deep-link resolver + OAuth helper.
//
//  · ForgotPasswordScreen (AU-01): POST /api/auth/forgot-password {email} — the
//    web page's exact payload; neutral anti-enumeration success copy (never
//    reveals whether the account exists).
//  · ResetPasswordScreen (AU-02): deep-link token (…/reset-password?token=…) →
//    POST /api/auth/reset-password {token, password}. The token lives only in
//    view state, is never logged, and is cleared on success; success returns to
//    the NATIVE login via the single nav path (.almaOpenPath).
//  · PortalWalletRouteScreen (FN-01): /portal/wallet resolves the signed-in
//    employee (GET /api/users/me) and shows the existing native
//    WalletStatementScreen — the route contract no longer opens web.
//  · AlmaWebAuthSession: ASWebAuthenticationSession wrapper for OAuth flows that
//    START at an ALMA endpoint (302 → Google consent) and END on an ALMA https
//    page (Growth GSC connect, Creative Studio Drive connect). System-handoff
//    class per the parity policy (§2 H) — the ONLY sanctioned way to leave the app
//    for OAuth. Requires iOS 17.4 (https callback); callers fall back to their
//    web escape below that.
//

import SwiftUI
import AuthenticationServices

// MARK: - OAuth round-trip helper (system-handoff EX-04)

@MainActor
final class AlmaWebAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AlmaWebAuthSession()
    private var session: ASWebAuthenticationSession?

    /// `startPath` is the ALMA route that 302s to Google (e.g.
    /// "/api/assistant/growth/gsc-auth"); `callbackPath` is the ALMA page the
    /// server redirects back to (e.g. "/agent/growth"). Completion receives the
    /// final URL's query items, or nil on cancel / error / unsupported OS.
    func start(startPath: String, callbackPath: String,
               completion: @escaping ([URLQueryItem]?) -> Void) {
        guard #available(iOS 17.4, *) else { completion(nil); return }
        guard let host = AlmaAPI.baseURL.host,
              let url = URL(string: AlmaAPI.baseURL.absoluteString + startPath) else {
            completion(nil)
            return
        }
        let s = ASWebAuthenticationSession(
            url: url,
            callback: .https(host: host, path: callbackPath)
        ) { [weak self] finalURL, _ in
            self?.session = nil
            guard let finalURL else { completion(nil); return }
            completion(URLComponents(url: finalURL, resolvingAgainstBaseURL: false)?.queryItems)
        }
        s.presentationContextProvider = self
        // Shared (non-ephemeral) browser context: the ALMA start route is
        // session-gated, and Google remembers the owner's account — one login in
        // this context covers every later connect.
        s.prefersEphemeralWebBrowserSession = false
        session = s
        s.start()
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }
                .first ?? ASPresentationAnchor()
        }
    }
}

// MARK: - Shared auth backdrop (web AUTH_BG parity — dark radial wash)

@available(iOS 17.0, *)
private struct AuthRecoveryBackdrop: View {
    var body: some View {
        GeometryReader { geo in
            ZStack {
                LinearGradient(colors: [Color(red: 0.102, green: 0.102, blue: 0.125),
                                        Color(red: 0.125, green: 0.125, blue: 0.153),
                                        Color(red: 0.090, green: 0.090, blue: 0.110)],
                               startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [AlmaSwiftTheme.coral.opacity(0.18), .clear],
                               center: .init(x: 0.15, y: 0.15), startRadius: 0, endRadius: geo.size.width * 0.7)
                RadialGradient(colors: [Color(red: 0.506, green: 0.698, blue: 0.604).opacity(0.16), .clear],
                               center: .init(x: 0.85, y: 0.85), startRadius: 0, endRadius: geo.size.width * 0.7)
            }
        }
        .ignoresSafeArea()
    }
}

@available(iOS 17.0, *)
private struct AuthMonogram: View {
    var body: some View {
        VStack(spacing: 6) {
            Text("A")
                .font(.system(size: 20, weight: .black))
                .foregroundStyle(Color(red: 0.957, green: 0.635, blue: 0.549))
                .frame(width: 48, height: 48)
                .background(Color(red: 0.831, green: 0.659, blue: 0.294).opacity(0.15),
                            in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color(red: 0.769, green: 0.353, blue: 0.235).opacity(0.5), lineWidth: 1))
            Text("ALMA ERP")
                .font(.system(size: 11, weight: .black)).tracking(3.2)
                .foregroundStyle(Color(red: 0.957, green: 0.635, blue: 0.549))
        }
    }
}

// MARK: - Forgot password (AU-01)

@available(iOS 17.0, *)
struct ForgotPasswordScreen: View {
    let openWeb: (_ path: String, _ title: String) -> Void
    @State private var email = ""
    @State private var sent = false
    @State private var loading = false
    @State private var errorText: String? = nil
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                AuthMonogram().padding(.top, 40)
                Text("Forgot password").font(.title3.weight(.bold)).foregroundStyle(.white)
                Text("ইমেইল দিন — অ্যাকাউন্ট থাকলে একটা short-lived reset link তৈরি হবে।")
                    .font(.caption).foregroundStyle(.white.opacity(0.6))
                    .multilineTextAlignment(.center)

                if sent {
                    // Anti-enumeration: the SAME neutral copy whether or not the
                    // account exists (web parity).
                    VStack(spacing: 8) {
                        Text("✅").font(.title)
                        Text("ইমেইল ইনবক্স দেখুন — অথবা admin-কে বলুন Users পেজ থেকে পাসওয়ার্ড রিসেট করে দিতে।")
                            .font(.footnote).foregroundStyle(.white.opacity(0.85))
                            .multilineTextAlignment(.center)
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity)
                    .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("EMAIL").font(.system(size: 9, weight: .bold)).tracking(1.2)
                            .foregroundStyle(.white.opacity(0.5))
                        TextField("you@example.com", text: $email)
                            .keyboardType(.emailAddress)
                            .textContentType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focused)
                            .padding(12)
                            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                            .foregroundStyle(.white)
                        if let err = errorText {
                            Text(err).font(.caption2).foregroundStyle(Color(red: 0.937, green: 0.267, blue: 0.267))
                        }
                        Button {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            Task { await submit() }
                        } label: {
                            Text(loading ? "Sending…" : "Send reset")
                                .font(.footnote.weight(.bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(Color(red: 0.831, green: 0.659, blue: 0.294),
                                            in: RoundedRectangle(cornerRadius: 12))
                                .foregroundStyle(.black)
                        }
                        .buttonStyle(.plain)
                        .disabled(loading || email.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .padding(20)
                    .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
                }
                Button {
                    NotificationCenter.default.post(name: .almaOpenPath, object: nil, userInfo: ["path": "/login"])
                } label: {
                    Text("← Back to login").font(.caption)
                        .foregroundStyle(Color(red: 0.957, green: 0.635, blue: 0.549))
                }
                .buttonStyle(.plain)
                .padding(.top, 8)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 420)
            .frame(maxWidth: .infinity)
        }
        .background(AuthRecoveryBackdrop())
        .preferredColorScheme(.dark)
    }

    private func submit() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        struct Body: Encodable { let email: String }
        struct Resp: Decodable { let ok: Bool? }
        do {
            let _: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/auth/forgot-password",
                body: Body(email: email.trimmingCharacters(in: .whitespaces).lowercased()))
            sent = true
            errorText = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            // Even errors stay neutral about account existence.
            errorText = "অনুরোধ পাঠানো যায়নি — নেটওয়ার্ক দেখে আবার চেষ্টা করুন।"
        }
    }
}

// MARK: - Reset password (AU-02)

@available(iOS 17.0, *)
struct ResetPasswordScreen: View {
    /// Deep-link token (…?token=…). Never logged, never persisted — view state only.
    let token: String?
    let openWeb: (_ path: String, _ title: String) -> Void
    @State private var password = ""
    @State private var loading = false
    @State private var errorText: String? = nil
    @State private var done = false

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                AuthMonogram().padding(.top, 40)
                Text("Reset password").font(.title3.weight(.bold)).foregroundStyle(.white)

                if done {
                    VStack(spacing: 8) {
                        Text("✅").font(.title)
                        Text("পাসওয়ার্ড আপডেট হয়েছে — নতুন পাসওয়ার্ড দিয়ে সাইন ইন করুন।")
                            .font(.footnote).foregroundStyle(.white.opacity(0.85))
                            .multilineTextAlignment(.center)
                        Button {
                            NotificationCenter.default.post(name: .almaOpenPath, object: nil, userInfo: ["path": "/login"])
                        } label: {
                            Text("লগইনে যান")
                                .font(.footnote.weight(.bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(Color(red: 0.831, green: 0.659, blue: 0.294),
                                            in: RoundedRectangle(cornerRadius: 12))
                                .foregroundStyle(.black)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity)
                    .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                } else if token == nil || token?.isEmpty == true {
                    Text("Invalid reset link.")
                        .font(.footnote).foregroundStyle(Color(red: 0.937, green: 0.267, blue: 0.267))
                        .padding(20)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("NEW PASSWORD").font(.system(size: 9, weight: .bold)).tracking(1.2)
                            .foregroundStyle(.white.opacity(0.5))
                        SecureField("At least 8 characters", text: $password)
                            .textContentType(.newPassword)
                            .padding(12)
                            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                            .foregroundStyle(.white)
                        if let err = errorText {
                            Text(err).font(.caption2).foregroundStyle(Color(red: 0.937, green: 0.267, blue: 0.267))
                        }
                        Button {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            Task { await submit() }
                        } label: {
                            Text(loading ? "Saving…" : "Update password")
                                .font(.footnote.weight(.bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(Color(red: 0.831, green: 0.659, blue: 0.294),
                                            in: RoundedRectangle(cornerRadius: 12))
                                .foregroundStyle(.black)
                        }
                        .buttonStyle(.plain)
                        .disabled(loading || password.count < 8)
                    }
                    .padding(20)
                    .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
                }
                Button {
                    NotificationCenter.default.post(name: .almaOpenPath, object: nil, userInfo: ["path": "/login"])
                } label: {
                    Text("← Login").font(.caption)
                        .foregroundStyle(Color(red: 0.957, green: 0.635, blue: 0.549))
                }
                .buttonStyle(.plain)
                .padding(.top, 8)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 420)
            .frame(maxWidth: .infinity)
        }
        .background(AuthRecoveryBackdrop())
        .preferredColorScheme(.dark)
    }

    private func submit() async {
        guard let token, !loading else { return }
        loading = true
        defer { loading = false }
        struct Body: Encodable { let token: String; let password: String }
        struct Resp: Decodable { let ok: Bool?; let error: String? }
        do {
            let r: Resp = try await AlmaAPI.shared.send("POST", "/api/auth/reset-password",
                                                        body: Body(token: token, password: password))
            if let err = r.error, r.ok != true {
                errorText = err
                return
            }
            password = ""       // clear sensitive state (roadmap AU-02)
            done = true
            errorText = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            errorText = "Reset ব্যর্থ — লিংকের মেয়াদ শেষ হতে পারে। নতুন লিংক নিন।"
        }
    }
}

// MARK: - /portal/wallet resolver (FN-01)

@available(iOS 17.0, *)
struct PortalWalletRouteScreen: View {
    let openWeb: (_ path: String, _ title: String) -> Void
    @State private var employeeId: String? = nil
    @State private var loading = true
    @State private var errorText: String? = nil

    /// The same business every native tab scopes to (PortalVM.businessId parity).
    private static let businessId = "ALMA_LIFESTYLE"

    var body: some View {
        Group {
            if let emp = employeeId {
                WalletStatementScreen(employeeId: emp, businessId: Self.businessId)
            } else if loading {
                ProgressView("ওয়ালেট খুলছে…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 10) {
                    Text(errorText ?? "এই অ্যাকাউন্টে HR employee লিঙ্ক নেই — ওয়ালেট স্টেটমেন্ট My Desk-এ পাওয়া যায়।")
                        .font(.footnote).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("My Desk খুলুন") {
                        NotificationCenter.default.post(name: .almaOpenPath, object: nil, userInfo: ["path": "/portal"])
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AlmaSwiftTheme.coral)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await resolve() }
    }

    private func resolve() async {
        struct Me: Decodable {
            let employeeIdGas: String?
            private enum Keys: String, CodingKey { case user }
            private enum UserKeys: String, CodingKey { case employeeIdGas }
            init(from decoder: Decoder) throws {
                let root = try decoder.container(keyedBy: Keys.self)
                let u = try? root.nestedContainer(keyedBy: UserKeys.self, forKey: .user)
                employeeIdGas = try? u?.decodeIfPresent(String.self, forKey: .employeeIdGas)
            }
        }
        defer { loading = false }
        do {
            let me: Me = try await AlmaAPI.shared.get("/api/users/me", query: ["business_id": Self.businessId])
            let emp = me.employeeIdGas?.trimmingCharacters(in: .whitespaces)
            employeeId = (emp?.isEmpty == false) ? emp : nil
        } catch {
            errorText = "প্রোফাইল লোড করা যায়নি: \(error.localizedDescription)"
        }
    }
}
