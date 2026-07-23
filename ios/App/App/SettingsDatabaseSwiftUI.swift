//
//  SettingsDatabaseSwiftUI.swift
//  ALMA ERP — Settings → Database as a native SwiftUI screen.
//
//  Mirrors the web /settings/database page — same endpoints, same colours, same blocks:
//    GET /api/settings/database-status  → connection diagnostics + user row count
//    GET /api/health                    → env validation · wallet ledger · GAS · storage
//  Blocks: health hero (green/amber/red) · Connection info card · Live status rows
//  (web Row parity: dot + label + mono detail + OK/Issue) · table stats (mono counts) ·
//  infra/backup card (storage bucket, GAS release, build) · Quick fixes (read-only text).
//  ⚠️ STRICTLY READ-ONLY — migrations/backup/restore/cleanup stay on the web escape
//  hatch, no exceptions. Carried lessons: ONE spinner style, never a global overlay.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum SettingsDatabasePalette {
    static var coral: Color { AlmaSwiftTheme.coral }
    static var goldLt: Color { AlmaSwiftTheme.accentLt }
    static var goldDim: Color { AlmaSwiftTheme.accentDim }
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

// MARK: - Models (same field names the web StatusJson type declares)

/// GET /api/settings/database-status — flat JSON, no ok/data wrapper.
struct SettingsDatabaseStatus: Decodable, Equatable {
    let databaseUrlConfigured: Bool?
    let databaseUrlHint: String?
    let postgresReachable: Bool?
    let prismaWorks: Bool?
    let userRowCount: Int?
    let nextAuthSecretConfigured: Bool?
    let nextAuthUrl: String?
    let error: String?

    private enum Keys: String, CodingKey {
        case databaseUrlConfigured, databaseUrlHint, postgresReachable, prismaWorks
        case userRowCount, nextAuthSecretConfigured, nextAuthUrl, error
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        databaseUrlConfigured = try? c.decodeIfPresent(Bool.self, forKey: .databaseUrlConfigured)
        databaseUrlHint = try? c.decodeIfPresent(String.self, forKey: .databaseUrlHint)
        postgresReachable = try? c.decodeIfPresent(Bool.self, forKey: .postgresReachable)
        prismaWorks = try? c.decodeIfPresent(Bool.self, forKey: .prismaWorks)
        userRowCount = Self.flexInt(c, .userRowCount)
        nextAuthSecretConfigured = try? c.decodeIfPresent(Bool.self, forKey: .nextAuthSecretConfigured)
        nextAuthUrl = try? c.decodeIfPresent(String.self, forKey: .nextAuthUrl)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

/// GET /api/health — the slice the web page renders plus the infra card bits.
struct SettingsDatabaseHealth: Decodable, Equatable {
    let ok: Bool?
    let environment: String?
    let envOk: Bool?
    let envMissing: Int?
    let envPlaceholder: Int?
    let dbOk: Bool?
    let dbError: String?
    let walletLedgerOk: Bool?
    let cronConfigured: Bool?
    let notificationsDbOk: Bool?
    let resendConfigured: Bool?
    let pushConfigured: Bool?
    let storageConfigured: Bool?
    let storageBucket: String?
    let commitShort: String?
    let branch: String?
    let gasOk: Bool?
    let gasReleaseStamp: String?

    private enum Keys: String, CodingKey {
        case ok, environment, env, database, cron, notifications, storage, frontend, gas
    }
    private enum EnvKeys: String, CodingKey { case ok, missing, placeholder }
    private enum DbKeys: String, CodingKey { case ok, error, wallet_ledger_ok }
    private enum CronKeys: String, CodingKey { case configured }
    private enum NotifKeys: String, CodingKey { case database_ok, resend_configured, push_configured }
    private enum StorageKeys: String, CodingKey { case expense_receipts_configured, expense_receipts_bucket }
    private enum FrontendKeys: String, CodingKey { case commit_short, branch }
    private enum GasKeys: String, CodingKey { case ok, gas_release_stamp }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        environment = try? c.decodeIfPresent(String.self, forKey: .environment)
        if let env = try? c.nestedContainer(keyedBy: EnvKeys.self, forKey: .env) {
            envOk = try? env.decodeIfPresent(Bool.self, forKey: .ok)
            envMissing = (try? env.decodeIfPresent([String].self, forKey: .missing))?.count
            envPlaceholder = (try? env.decodeIfPresent([String].self, forKey: .placeholder))?.count
        } else {
            envOk = nil; envMissing = nil; envPlaceholder = nil
        }
        if let db = try? c.nestedContainer(keyedBy: DbKeys.self, forKey: .database) {
            dbOk = try? db.decodeIfPresent(Bool.self, forKey: .ok)
            dbError = try? db.decodeIfPresent(String.self, forKey: .error)
            walletLedgerOk = try? db.decodeIfPresent(Bool.self, forKey: .wallet_ledger_ok)
        } else {
            dbOk = nil; dbError = nil; walletLedgerOk = nil
        }
        cronConfigured = (try? c.nestedContainer(keyedBy: CronKeys.self, forKey: .cron))
            .flatMap { try? $0.decodeIfPresent(Bool.self, forKey: .configured) }
        if let n = try? c.nestedContainer(keyedBy: NotifKeys.self, forKey: .notifications) {
            notificationsDbOk = try? n.decodeIfPresent(Bool.self, forKey: .database_ok)
            resendConfigured = try? n.decodeIfPresent(Bool.self, forKey: .resend_configured)
            pushConfigured = try? n.decodeIfPresent(Bool.self, forKey: .push_configured)
        } else {
            notificationsDbOk = nil; resendConfigured = nil; pushConfigured = nil
        }
        if let s = try? c.nestedContainer(keyedBy: StorageKeys.self, forKey: .storage) {
            storageConfigured = try? s.decodeIfPresent(Bool.self, forKey: .expense_receipts_configured)
            storageBucket = try? s.decodeIfPresent(String.self, forKey: .expense_receipts_bucket)
        } else {
            storageConfigured = nil; storageBucket = nil
        }
        if let f = try? c.nestedContainer(keyedBy: FrontendKeys.self, forKey: .frontend) {
            commitShort = try? f.decodeIfPresent(String.self, forKey: .commit_short)
            branch = try? f.decodeIfPresent(String.self, forKey: .branch)
        } else {
            commitShort = nil; branch = nil
        }
        if let g = try? c.nestedContainer(keyedBy: GasKeys.self, forKey: .gas) {
            gasOk = try? g.decodeIfPresent(Bool.self, forKey: .ok)
            gasReleaseStamp = try? g.decodeIfPresent(String.self, forKey: .gas_release_stamp)
        } else {
            gasOk = nil; gasReleaseStamp = nil
        }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class SettingsDatabaseVM {
    var status: SettingsDatabaseStatus? = nil
    var health: SettingsDatabaseHealth? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let s: SettingsDatabaseStatus = try await AlmaAPI.shared.get("/api/settings/database-status")
            status = s
            authExpired = false
            // Health is best-effort — the web page swallows its failure too.
            health = try? await AlmaAPI.shared.get("/api/health")
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

    // ── Hero verdict: green (all good) / amber (degraded) / red (DB unreachable) ──

    enum Verdict { case healthy, degraded, down }

    var verdict: Verdict {
        guard let s = status else { return .degraded }
        if s.postgresReachable != true || s.prismaWorks != true { return .down }
        let degraded = s.databaseUrlConfigured != true
            || s.nextAuthSecretConfigured != true
            || health?.envOk == false
            || health?.walletLedgerOk == false
            || health?.ok == false
        return degraded ? .degraded : .healthy
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct SettingsDatabaseScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = SettingsDatabaseVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if vm.loading && vm.status == nil {
                    loadingRows
                } else if let s = vm.status {
                    heroCard(s)
                    if let apiErr = s.error, !apiErr.isEmpty { noticeCard(apiErr, tone: .error) }
                    connectionCard
                    liveStatusCard(s)
                    tableStatsCard(s)
                    infraCard
                    quickFixesCard
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(SettingsDatabaseAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    // ── Health hero (green/amber/red) ──

    private func heroCard(_ s: SettingsDatabaseStatus) -> some View {
        let (tint, icon, title, sub): (Color, String, String, String) = switch vm.verdict {
        case .healthy: (SettingsDatabasePalette.emerald600, "checkmark.seal.fill",
                        "ডাটাবেস সচল", "PostgreSQL · Prisma · NextAuth — সব OK")
        case .degraded: (SettingsDatabasePalette.amber600, "exclamationmark.triangle.fill",
                         "আংশিক সমস্যা", "সংযোগ আছে, কিছু চেক ব্যর্থ — নিচের তালিকা দেখুন")
        case .down: (SettingsDatabasePalette.red500, "xmark.octagon.fill",
                     "ডাটাবেস সংযোগ নেই", "PostgreSQL পৌঁছানো যাচ্ছে না — Quick fixes দেখুন")
        }
        return HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline.weight(.bold)).foregroundStyle(tint)
                Text(sub).font(.caption).foregroundStyle(.secondary)
                if let hint = s.databaseUrlHint, !hint.isEmpty {
                    Text(hint).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .settingsDatabaseGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }

    // ── Connection card (web "Connection" gold card, verbatim copy) ──

    private var connectionCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("CONNECTION")
                .font(.caption2.weight(.heavy)).tracking(1.2)
                .foregroundStyle(SettingsDatabasePalette.accentText(colorScheme))
            Text("Uses Supabase Postgres for ERP accounts and RBAC. Google Sheets behaviour is unchanged (NEXT_PUBLIC_API_URL).")
                .font(.caption).foregroundStyle(.secondary)
            Text("docs/SUPABASE_POSTGRES_SETUP.md")
                .font(.caption2.monospaced())
                .foregroundStyle(SettingsDatabasePalette.goldLt)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsDatabaseGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(SettingsDatabasePalette.goldDim.opacity(0.25), lineWidth: 1))
    }

    // ── Live status rows (web Row component parity: dot · label · detail · OK/Issue) ──

    private func liveStatusCard(_ s: SettingsDatabaseStatus) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Live status")
                .font(.subheadline.weight(.bold))
                .padding(.bottom, 6)
            statusRow("PostgreSQL reachable", ok: s.postgresReachable, detail: s.databaseUrlHint)
            statusRow("Prisma query OK", ok: s.prismaWorks)
            statusRow("DATABASE_URL configured", ok: s.databaseUrlConfigured, detail: s.databaseUrlHint)
            statusRow("NextAuth signing secret", ok: s.nextAuthSecretConfigured, detail: s.nextAuthUrl)
            statusRow("Environment validation", ok: vm.health?.envOk,
                      detail: vm.health.map { "missing=\($0.envMissing ?? 0) placeholders=\($0.envPlaceholder ?? 0)" })
            statusRow("Wallet ledger health", ok: vm.health?.walletLedgerOk, detail: vm.health?.dbError, last: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsDatabaseGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func statusRow(_ label: String, ok: Bool?, detail: String? = nil, last: Bool = false) -> some View {
        let tone: Color = ok == nil ? .secondary
            : ok == true ? SettingsDatabasePalette.green400 : SettingsDatabasePalette.red500
        return VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Circle().fill(ok == nil ? Color.secondary.opacity(0.5) : tone)
                    .frame(width: 8, height: 8)
                    .padding(.top, 4)
                VStack(alignment: .leading, spacing: 1) {
                    Text(label).font(.caption.weight(.semibold))
                    if let detail, !detail.isEmpty {
                        Text(detail).font(.caption2.monospaced()).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                Text(ok == nil ? "…" : ok == true ? "OK" : "Issue")
                    .font(.caption2.weight(.bold)).textCase(.uppercase)
                    .foregroundStyle(tone)
            }
            .padding(.vertical, 7)
            if !last {
                Divider().opacity(0.35)
            }
        }
    }

    // ── Table stats (mono row counts — everything the diagnostics expose) ──

    private func tableStatsCard(_ s: SettingsDatabaseStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("টেবিল পরিসংখ্যান")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            statRow("users", value: s.userRowCount.map { "\($0.formatted())" } ?? "—",
                    ok: s.userRowCount != nil)
            statRow("employee_ledger (wallet)",
                    value: vm.health?.walletLedgerOk == true ? "OK" : vm.health?.walletLedgerOk == false ? "Issue" : "—",
                    ok: vm.health?.walletLedgerOk != false)
            statRow("notifications",
                    value: vm.health?.notificationsDbOk == true ? "OK" : vm.health?.notificationsDbOk == false ? "Issue" : "—",
                    ok: vm.health?.notificationsDbOk != false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsDatabaseGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func statRow(_ name: String, value: String, ok: Bool) -> some View {
        HStack {
            Text(name).font(.footnote.weight(.semibold))
            Spacer()
            Text(value)
                .font(.footnote.monospaced().weight(.bold))
                .foregroundStyle(ok ? SettingsDatabasePalette.accentText(colorScheme)
                                    : SettingsDatabasePalette.red500)
                .padding(.horizontal, 8).padding(.vertical, 2)
                .background(SettingsDatabasePalette.coral.opacity(0.14), in: Capsule())
        }
    }

    // ── Infra / backup card (storage bucket · GAS · cron · build — read-only info) ──

    private var infraCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("স্টোরেজ ও ব্যাকআপ তথ্য")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            infoRow("Environment", vm.health?.environment ?? "—")
            infoRow("Receipt storage (Supabase)",
                    vm.health?.storageConfigured == true
                        ? (vm.health?.storageBucket ?? "configured") : "not configured",
                    mono: true,
                    tint: vm.health?.storageConfigured == true ? nil : SettingsDatabasePalette.amber600)
            infoRow("Google Sheets (GAS)",
                    vm.health?.gasOk == true ? (vm.health?.gasReleaseStamp ?? "OK")
                        : vm.health?.gasOk == false ? "Issue" : "—",
                    mono: true,
                    tint: vm.health?.gasOk == false ? SettingsDatabasePalette.red500 : nil)
            infoRow("Cron secret", vm.health?.cronConfigured == true ? "configured" : "missing",
                    tint: vm.health?.cronConfigured == true ? nil : SettingsDatabasePalette.amber600)
            infoRow("Build", [vm.health?.branch, vm.health?.commitShort]
                .compactMap { $0 }.joined(separator: " · ").ifEmptyDash, mono: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsDatabaseGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func infoRow(_ label: String, _ value: String, mono: Bool = false, tint: Color? = nil) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 10)
            Text(value)
                .font(mono ? .caption.monospaced().weight(.semibold) : .caption.weight(.semibold))
                .foregroundStyle(tint ?? .primary)
                .lineLimit(1).truncationMode(.middle)
        }
    }

    // ── Quick fixes (web card verbatim — informational only, actions stay on web) ──

    private var quickFixesCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("QUICK FIXES")
                .font(.caption2.weight(.bold)).tracking(1.0).foregroundStyle(.secondary)
            bullet("Copy the Supabase direct Postgres URI into both .env.local and .env.")
            bullet("Run npx prisma db push then npm run db:seed.")
            bullet("Ensure password characters are URL-encoded in the connection string.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsDatabaseGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text("•").font(.caption).foregroundStyle(.secondary)
            Text(text).font(.caption).foregroundStyle(.secondary)
        }
    }

    // ── Shared bits ──

    private enum NoticeTone { case error, success, info }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", SettingsDatabasePalette.red500)
        case .success: ("checkmark.circle", SettingsDatabasePalette.emerald600)
        case .info: ("info.circle", Color.secondary)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).settingsDatabaseGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .settingsDatabaseGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 120)
                .settingsDatabaseGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .settingsDatabaseShimmer()
        }
    }

    /// Migration / backup / restore / cleanup tooling is destructive territory —
    /// it lives ONLY on the web, behind this escape hatch.
    private var webEscape: some View {
        Button {
            openWeb("/settings/database", "Database")
        } label: {
            Label("মাইগ্রেশন/ব্যাকআপ টুলসসহ সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

private extension String {
    var ifEmptyDash: String { isEmpty ? "—" : self }
}

// MARK: - Aurora background + glass (SettingsDatabase-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct SettingsDatabaseAurora: View {
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
                        // Radial-gradient falloff reads the same as the old blur(70)
                        // but costs ZERO gaussian passes — the live blurs were the
                        // app-wide transition/scroll jank source (perf audit 2026-07-08).
                        .fill(RadialGradient(colors: [b.color, b.color.opacity(0)],
                                             center: .center,
                                             startRadius: b.size * 0.10,
                                             endRadius: b.size * 0.62))
                        .frame(width: b.size * 1.35, height: b.size * 1.35)
                        .position(x: geo.size.width * b.x + (drift ? b.dx : -b.dx),
                                  y: geo.size.height * b.y + (drift ? b.dy : -b.dy))
                }
            }
            .onAppear { updateDrift() }
            // Covered/backgrounded screens must not keep animating — pausing here means
            // a stack of pushed pages costs nothing while hidden.
            .onDisappear { pauseDrift() }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
                .receive(on: DispatchQueue.main)) { _ in updateDrift() }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    /// Battery guard: drift only when the owner allows motion — Reduce Motion and
    /// Low Power Mode both freeze the aurora to a static wash (blobs at rest).
    private func pauseDrift() {
        var tx = Transaction(); tx.disablesAnimations = true
        withTransaction(tx) { drift = false }
    }

    private func updateDrift() {
        if reduceMotion || ProcessInfo.processInfo.isLowPowerModeEnabled {
            var tx = Transaction(); tx.disablesAnimations = true
            withTransaction(tx) { drift = false }
        } else if !drift {
            // Start the drift AFTER the push/present transition settles — kicking a
            // repeatForever animation mid-transition made every slide-in stutter.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                guard !drift, !reduceMotion,
                      !ProcessInfo.processInfo.isLowPowerModeEnabled else { return }
                withAnimation(.easeInOut(duration: 26).repeatForever(autoreverses: true)) { drift = true }
            }
        }
    }
}

@available(iOS 17.0, *)
private extension View {
    func settingsDatabaseGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct SettingsDatabaseShimmerModifier: ViewModifier {
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
    func settingsDatabaseShimmer() -> some View { modifier(SettingsDatabaseShimmerModifier()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Settings Database — Light") {
    SettingsDatabaseScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
