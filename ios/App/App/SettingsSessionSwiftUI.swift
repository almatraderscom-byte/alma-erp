//
//  SettingsSessionSwiftUI.swift
//  ALMA ERP — the Settings ▸ Session page as a native SwiftUI screen (read-only).
//
//  Mirrors the web /settings/session page's data — same endpoints:
//    GET /api/users/me   → signed-in identity (name, email, phone, role, business
//                          access, employee id, joining date, active flag)
//    GET /api/health     → build/backend diagnostics (frontend git, GAS stamp,
//                          clasp @NN, environment, DB/GAS probes, checked-at)
//  Native additions: a current-session hero card and a "this device" card
//  (device model / iOS version / app build) — info the web page can't show.
//  READ-ONLY by design: profile edits, photo and password changes are auth
//  territory and stay on the web escape hatch (footer → /settings/session).
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum SettingsSessionPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names the web page's fetches return)

/// GET /api/users/me → `{ user: {…} }` (resolveMyDeskProfile shape). Every field
/// decoded leniently — the profile resolver mixes system-owner / trading shapes.
struct SettingsSessionUser: Decodable, Equatable {
    let id: String
    let email: String?
    let name: String?
    let phone: String?
    let role: String?
    let active: Bool?
    let businessAccess: String?
    let employeeIdGas: String?
    let joiningDate: String?
    let salaryHint: Int?
    let profileImageUrl: String?
    let createdAt: String?
    let isSystemOwner: Bool?
    let roleTitle: String?
    let profileStatus: String?

    private enum Keys: String, CodingKey {
        case id, email, name, phone, role, active, businessAccess, employeeIdGas
        case joiningDate, salaryHint, profileImageUrl, createdAt, isSystemOwner, profile
    }
    private enum ProfileKeys: String, CodingKey { case roleTitle, status }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        role = try? c.decodeIfPresent(String.self, forKey: .role)
        active = try? c.decodeIfPresent(Bool.self, forKey: .active)
        // businessAccess arrives as a string ("ALL" / comma list) — tolerate arrays too.
        if let s = try? c.decodeIfPresent(String.self, forKey: .businessAccess) {
            businessAccess = s
        } else if let arr = try? c.decodeIfPresent([String].self, forKey: .businessAccess) {
            businessAccess = arr.joined(separator: ", ")
        } else {
            businessAccess = nil
        }
        employeeIdGas = try? c.decodeIfPresent(String.self, forKey: .employeeIdGas)
        joiningDate = try? c.decodeIfPresent(String.self, forKey: .joiningDate)
        salaryHint = Self.flexInt(c, .salaryHint)
        profileImageUrl = try? c.decodeIfPresent(String.self, forKey: .profileImageUrl)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        isSystemOwner = try? c.decodeIfPresent(Bool.self, forKey: .isSystemOwner)
        let p = try? c.nestedContainer(keyedBy: ProfileKeys.self, forKey: .profile)
        roleTitle = try? p?.decodeIfPresent(String.self, forKey: .roleTitle)
        profileStatus = try? p?.decodeIfPresent(String.self, forKey: .status)
    }

    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

struct SettingsSessionUserResponse: Decodable {
    let user: SettingsSessionUser?
    private enum Keys: String, CodingKey { case user, data }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        if let u = try? root.decodeIfPresent(SettingsSessionUser.self, forKey: .user) {
            user = u
        } else if let c = try? root.nestedContainer(keyedBy: Keys.self, forKey: .data) {
            user = try? c.decodeIfPresent(SettingsSessionUser.self, forKey: .user)
        } else {
            user = nil
        }
    }
}

/// GET /api/health — the exact slice the web page's HealthJson type reads
/// (snake_case keys, nested frontend/api/gas blocks), decoded leniently.
struct SettingsSessionHealth: Decodable, Equatable {
    let ok: Bool?
    let timestamp: String?
    let environment: String?
    let gasClaspVersion: String?
    let frontendGitCommit: String?
    let frontendCommitShort: String?
    let frontendBranch: String?
    let apiUrl: String?
    let gasDeploymentId: String?
    let gasOk: Bool?
    let gasReleaseStamp: String?
    let databaseOk: Bool?

    private enum Keys: String, CodingKey {
        case ok, timestamp, environment
        case gasClaspVersion = "gas_clasp_version"
        case frontend, api, gas, database
    }
    private enum FrontendKeys: String, CodingKey {
        case gitCommit = "git_commit"
        case commitShort = "commit_short"
        case branch
    }
    private enum ApiKeys: String, CodingKey {
        case apiUrl = "next_public_api_url"
        case gasDeploymentId = "gas_deployment_id"
    }
    private enum GasKeys: String, CodingKey {
        case ok
        case releaseStamp = "gas_release_stamp"
    }
    private enum DbKeys: String, CodingKey { case ok }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        timestamp = try? c.decodeIfPresent(String.self, forKey: .timestamp)
        environment = try? c.decodeIfPresent(String.self, forKey: .environment)
        gasClaspVersion = try? c.decodeIfPresent(String.self, forKey: .gasClaspVersion)
        let f = try? c.nestedContainer(keyedBy: FrontendKeys.self, forKey: .frontend)
        frontendGitCommit = try? f?.decodeIfPresent(String.self, forKey: .gitCommit)
        frontendCommitShort = try? f?.decodeIfPresent(String.self, forKey: .commitShort)
        frontendBranch = try? f?.decodeIfPresent(String.self, forKey: .branch)
        let a = try? c.nestedContainer(keyedBy: ApiKeys.self, forKey: .api)
        apiUrl = try? a?.decodeIfPresent(String.self, forKey: .apiUrl)
        gasDeploymentId = try? a?.decodeIfPresent(String.self, forKey: .gasDeploymentId)
        let g = try? c.nestedContainer(keyedBy: GasKeys.self, forKey: .gas)
        gasOk = try? g?.decodeIfPresent(Bool.self, forKey: .ok)
        gasReleaseStamp = try? g?.decodeIfPresent(String.self, forKey: .releaseStamp)
        let d = try? c.nestedContainer(keyedBy: DbKeys.self, forKey: .database)
        databaseOk = try? d?.decodeIfPresent(Bool.self, forKey: .ok)
    }

    /// Web apiHost(): hostname of NEXT_PUBLIC_API_URL, "—" when unparsable.
    var apiHost: String {
        guard let apiUrl, let host = URL(string: apiUrl)?.host else { return "—" }
        return host
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class SettingsSessionVM {
    var user: SettingsSessionUser? = nil
    var health: SettingsSessionHealth? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            // The web page fires both fetches on mount — mirror that concurrency.
            async let userTask: SettingsSessionUserResponse =
                AlmaAPI.shared.get("/api/users/me")
            async let healthTask: SettingsSessionHealth =
                AlmaAPI.shared.get("/api/health")
            let (userResp, healthResp) = try await (userTask, healthTask)
            user = userResp.user
            health = healthResp
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct SettingsSessionScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = SettingsSessionVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.user == nil && vm.health == nil {
                    loadingRows
                } else {
                    if let user = vm.user {
                        SettingsSessionHeroCard(user: user)
                        SettingsSessionDeviceCard()
                        SettingsSessionAccountCard(user: user)
                    } else if !vm.authExpired && vm.error == nil && !vm.loading {
                        SettingsSessionDeviceCard()
                    }
                    buildBackendCard
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(SettingsSessionAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    // ── Build / backend card (web "Build / backend" Card parity) ──

    @ViewBuilder private var buildBackendCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("BUILD / BACKEND")
                .font(.caption2.weight(.heavy))
                .tracking(1.4)
                .foregroundStyle(SettingsSessionPalette.accentText(colorScheme))
            if let h = vm.health {
                VStack(spacing: 8) {
                    kvRow("Frontend git", h.frontendCommitShort ?? h.frontendGitCommit ?? "—", mono: true)
                    if let branch = h.frontendBranch, !branch.isEmpty {
                        kvRow("Branch", branch, mono: true)
                    }
                    kvRow("GAS stamp", h.gasReleaseStamp ?? "—", mono: true,
                          valueColor: SettingsSessionPalette.goldLt)
                    kvRow("Clasp @NN", h.gasClaspVersion ?? "—", mono: true)
                    kvRow("Deployment ID", h.gasDeploymentId ?? "—", mono: true)
                    kvRow("API URL host", h.apiHost, mono: true)
                    kvRow("Environment", h.environment ?? "—")
                    probeRow("Database", ok: h.databaseOk)
                    probeRow("GAS backend", ok: h.gasOk)
                    kvRow("Checked", SettingsSessionFormat.dateTime(h.timestamp) ?? h.timestamp ?? "—", mono: true)
                }
                if h.ok == false {
                    // Web: "Backend probe returned ok:false — compare NEXT_PUBLIC_API_URL
                    // with clasp deployment."
                    Text("Backend probe returned ok:false — compare NEXT_PUBLIC_API_URL with clasp deployment.")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(SettingsSessionPalette.amber600)
                }
            } else if vm.loading {
                Color.clear.frame(height: 90)
                    .settingsSessionGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                    .settingsSessionShimmer()
            } else {
                // Web: "Could not load /api/health"
                Text("Could not load /api/health")
                    .font(.caption)
                    .foregroundStyle(SettingsSessionPalette.red500)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsSessionGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func kvRow(_ label: String, _ value: String, mono: Bool = false,
                       valueColor: Color = .primary) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value)
                .font(mono ? .caption.monospaced().weight(.semibold) : .caption.weight(.semibold))
                .foregroundStyle(valueColor)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 190, alignment: .trailing)
        }
    }

    private func probeRow(_ label: String, ok: Bool?) -> some View {
        HStack(spacing: 12) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            switch ok {
            case .some(true):
                Label("OK", systemImage: "checkmark.circle.fill")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(SettingsSessionPalette.emerald600)
            case .some(false):
                Label("FAIL", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(SettingsSessionPalette.red500)
            case .none:
                Text("—").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
    }

    // ── Shared bits ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .settingsSessionGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(SettingsSessionPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).settingsSessionGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        ForEach(0..<3, id: \.self) { _ in
            Color.clear.frame(height: 130)
                .settingsSessionGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .settingsSessionShimmer()
        }
    }

    /// Escape hatch — profile edit, photo and password change stay on the web.
    private var webEscape: some View {
        Button {
            openWeb("/settings/session", "Session")
        } label: {
            Label("প্রোফাইল এডিট ও পাসওয়ার্ড পরিবর্তন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Hero card (current session: who is signed in, as what)

@available(iOS 17.0, *)
private struct SettingsSessionHeroCard: View {
    let user: SettingsSessionUser
    @Environment(\.colorScheme) private var colorScheme

    private var displayName: String { user.name ?? user.email ?? "Account" }
    private var roleLine: String {
        let base = (user.roleTitle ?? user.role ?? "—").replacingOccurrences(of: "_", with: " ")
        return user.isSystemOwner == true ? "System Owner" : base
    }
    private var isActive: Bool { user.active ?? true }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("SIGNED-IN IDENTITY")
                .font(.caption2.weight(.heavy))
                .tracking(1.4)
                .foregroundStyle(SettingsSessionPalette.accentText(colorScheme))
            HStack(spacing: 12) {
                Text(SettingsSessionFormat.initials(displayName))
                    .font(.title3.weight(.bold))
                    .foregroundStyle(SettingsSessionPalette.accentText(colorScheme))
                    .frame(width: 52, height: 52)
                    .background(SettingsSessionPalette.coral.opacity(0.16), in: Circle())
                    .overlay(Circle().strokeBorder(SettingsSessionPalette.coral.opacity(0.35), lineWidth: 1))
                VStack(alignment: .leading, spacing: 3) {
                    Text(displayName).font(.headline)
                    Text(roleLine).font(.caption).foregroundStyle(.secondary)
                    if let email = user.email {
                        Text(email)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 4)
            }
            HStack(spacing: 8) {
                statusPill(isActive ? "ACTIVE" : "INACTIVE",
                           tint: isActive ? SettingsSessionPalette.green400 : SettingsSessionPalette.red500)
                if let access = user.businessAccess, !access.isEmpty {
                    statusPill(access.replacingOccurrences(of: "_", with: " "),
                               tint: SettingsSessionPalette.coral,
                               text: SettingsSessionPalette.accentText(colorScheme))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsSessionGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func statusPill(_ label: String, tint: Color, text: Color? = nil) -> some View {
        Text(label)
            .font(.caption2.weight(.bold))
            .foregroundStyle(text ?? tint)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(tint.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - This-device card (native-only: what the web page can't see)

@available(iOS 17.0, *)
private struct SettingsSessionDeviceCard: View {
    @Environment(\.colorScheme) private var colorScheme

    private var deviceSymbol: String {
        UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
    }
    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        return "\(version) (\(build))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("এই ডিভাইস")
                .font(.caption2.weight(.heavy))
                .tracking(1.4)
                .foregroundStyle(SettingsSessionPalette.accentText(colorScheme))
            deviceRow(deviceSymbol, UIDevice.current.model,
                      "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)")
            deviceRow("app.badge.checkmark", "ALMA ERP অ্যাপ", "সংস্করণ \(appVersion)")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsSessionGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func deviceRow(_ symbol: String, _ title: String, _ subtitle: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(
                    LinearGradient(colors: [SettingsSessionPalette.coral, AlmaSwiftTheme.violet],
                                   startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .shadow(color: SettingsSessionPalette.coral.opacity(0.35), radius: 5, y: 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.footnote.weight(.semibold))
                Text(subtitle).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Account details card (rows from /api/users/me)

@available(iOS 17.0, *)
private struct SettingsSessionAccountCard: View {
    let user: SettingsSessionUser
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("অ্যাকাউন্ট তথ্য")
                .font(.caption2.weight(.heavy))
                .tracking(1.4)
                .foregroundStyle(SettingsSessionPalette.accentText(colorScheme))
            accountRow("phone", "ফোন", user.phone ?? "—")
            accountRow("person.text.rectangle", "Employee ID", user.employeeIdGas ?? "—")
            accountRow("calendar", "যোগদানের তারিখ",
                       SettingsSessionFormat.dateOnly(user.joiningDate) ?? "—")
            accountRow("clock", "অ্যাকাউন্ট তৈরি",
                       SettingsSessionFormat.dateOnly(user.createdAt) ?? "—")
            if let status = user.profileStatus, !status.isEmpty {
                accountRow("checkmark.seal", "প্রোফাইল স্ট্যাটাস",
                           status.replacingOccurrences(of: "_", with: " "))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsSessionGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func accountRow(_ symbol: String, _ label: String, _ value: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(SettingsSessionPalette.accentText(colorScheme))
                .frame(width: 26, height: 26)
                .background(SettingsSessionPalette.coral.opacity(0.12),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}

// MARK: - Formatting helpers (web util parity)

private enum SettingsSessionFormat {
    /// ISO → "5/7/2026, 8:50 PM" style (web: new Date(...).toLocaleString()).
    static func dateTime(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    /// ISO → date-only "5/7/2026" (joining date, account creation).
    static func dateOnly(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        if let d = plain.date(from: iso) { return d }
        // joiningDate can arrive as plain "yyyy-MM-dd".
        let day = DateFormatter()
        day.dateFormat = "yyyy-MM-dd"
        day.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return day.date(from: String(iso.prefix(10)))
    }

    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (SettingsSession-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct SettingsSessionAurora: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    private struct AuroraBlob { let color: Color; let size: CGFloat; let x: CGFloat; let y: CGFloat; let dx: CGFloat; let dy: CGFloat }

    var body: some View {
        let dark = scheme == .dark
        // Agent-parity living aurora (web --aurora-blob-1…5): five blurred colour blobs
        // drifting corner-to-corner over the page canvas. Owner directive 2026-07-08:
        // every native page shares the Assistant tab's moving aurora.
        let blobs: [AuroraBlob] = [
            .init(color: Color(red: 0.220, green: 0.502, blue: 1.000).opacity(dark ? 0.60 : 0.30), size: 380, x: 0.15, y: 0.10, dx: 60, dy: 40),
            .init(color: Color(red: 0.486, green: 0.302, blue: 1.000).opacity(dark ? 0.55 : 0.26), size: 420, x: 0.85, y: 0.25, dx: -50, dy: 60),
            .init(color: Color(red: 0.839, green: 0.200, blue: 1.000).opacity(dark ? 0.50 : 0.24), size: 360, x: 0.30, y: 0.55, dx: 70, dy: -40),
            .init(color: Color(red: 1.000, green: 0.180, blue: 0.525).opacity(dark ? 0.55 : 0.26), size: 400, x: 0.80, y: 0.80, dx: -60, dy: -50),
            .init(color: Color(red: 1.000, green: 0.431, blue: 0.314).opacity(dark ? 0.45 : 0.22), size: 340, x: 0.20, y: 0.95, dx: 50, dy: -60),
        ]
        GeometryReader { geo in
            ZStack {
                (dark ? Color(red: 0.078, green: 0.078, blue: 0.094)
                      : Color(red: 0.980, green: 0.976, blue: 0.965))
                RadialGradient(colors: [Color(red: 0.388, green: 0.400, blue: 0.945).opacity(dark ? 0.22 : 0.10), .clear],
                               center: .init(x: 0.5, y: -0.1), startRadius: 0, endRadius: geo.size.height * 0.8)
                RadialGradient(colors: [Color(red: 0.925, green: 0.282, blue: 0.600).opacity(dark ? 0.28 : 0.12), .clear],
                               center: .init(x: 0.5, y: 1.15), startRadius: 0, endRadius: geo.size.height * 0.9)
                ForEach(Array(blobs.enumerated()), id: \.offset) { _, b in
                    Circle()
                        .fill(b.color)
                        .frame(width: b.size, height: b.size)
                        .position(x: geo.size.width * b.x + (drift ? b.dx : -b.dx),
                                  y: geo.size.height * b.y + (drift ? b.dy : -b.dy))
                        .blur(radius: 70)
                }
            }
            .onAppear { updateDrift() }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
                .receive(on: DispatchQueue.main)) { _ in updateDrift() }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    /// Battery guard: drift only when the owner allows motion — Reduce Motion and
    /// Low Power Mode both freeze the aurora to a static wash (blobs at rest).
    private func updateDrift() {
        if reduceMotion || ProcessInfo.processInfo.isLowPowerModeEnabled {
            var tx = Transaction(); tx.disablesAnimations = true
            withTransaction(tx) { drift = false }
        } else if !drift {
            withAnimation(.easeInOut(duration: 26).repeatForever(autoreverses: true)) { drift = true }
        }
    }
}

@available(iOS 17.0, *)
private extension View {
    func settingsSessionGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct SettingsSessionShimmer: ViewModifier {
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        content
            .overlay(
                LinearGradient(colors: [.clear, .white.opacity(0.25), .clear],
                               startPoint: .leading, endPoint: .trailing)
                    .offset(x: phase * 320)
                    .clipped()
            )
            .onAppear {
                withAnimation(.linear(duration: 1.15).repeatForever(autoreverses: false)) { phase = 1.5 }
            }
    }
}

@available(iOS 17.0, *)
private extension View {
    func settingsSessionShimmer() -> some View { modifier(SettingsSessionShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Session — Light") {
    SettingsSessionScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
