//
//  TargetControlSwiftUI.swift
//  ALMA ERP — Trading Target Control as a native SwiftUI screen (web /trading/target-control parity).
//
//  Mirrors the web page — same endpoints, same numbers, same blocks:
//    GET /api/trading/volume-targets?date=YYYY-MM-DD            → { date, targets, canManage }
//    GET /api/trading/volume-targets/settings                   → { settings: { autoPenaltyEnabled, defaultPenaltyBdt }, canManage }
//    GET /api/trading/volume-targets/analytics?month=YYYY-MM    → { analytics | summary, canManage }
//  Web-parity blocks: date filter · tab chips (Accounts / Penalty queue (n) /
//  Analytics / Settings) · month KPI board (Targets / Met green / Missed red /
//  Ignored) · per-account target cards with actual-vs-target progress bars +
//  status/penalty pills · analytics penalty totals (super admin payload) ·
//  auto-penalty settings. NATIVE WRITES (verified 2026-07-17): create/set target
//  (POST /api/trading/volume-targets), per-target actions incl. penalty apply/waive/
//  ignore (POST …/{id}/actions), delete (DELETE …/{id}), settings save (PATCH
//  …/settings). This is a control panel now, not just a monitor.
//  Carried lessons: lenient row decoding, ONE spinner pattern, no global overlays.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum TargetControlPalette {
    /// Trading hero accent — sage green (#82B399-ish, brief-specified).
    static let tradingGreen = Color(red: 0.51, green: 0.70, blue: 0.60)
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let red400 = Color(red: 0.973, green: 0.443, blue: 0.443)         // #F87171
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let green300 = Color(red: 0.525, green: 0.937, blue: 0.675)       // #86EFAC
    static let slate400 = Color(red: 0.580, green: 0.639, blue: 0.722)       // #94A3B8

    /// Accent-tinted text: gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
    static func positive(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? green400 : emerald600
    }

    /// Target status tints (web KPI semantics: met green · missed red ·
    /// ignored slate · pending amber).
    static func status(_ s: String?, _ scheme: ColorScheme) -> Color {
        switch s {
        case "MET": return positive(scheme)
        case "MISSED": return red500
        case "IGNORED": return slate400
        default: return scheme == .dark ? amber500 : amber600   // PENDING / unknown
        }
    }

    /// Penalty pill tints: PENDING amber · APPLIED red · WAIVED / PARTIALLY_WAIVED slate-gold.
    static func penalty(_ s: String?, _ scheme: ColorScheme) -> Color {
        switch s {
        case "APPLIED": return red400
        case "WAIVED": return slate400
        case "PARTIALLY_WAIVED": return accentText(scheme)
        default: return scheme == .dark ? amber500 : amber600   // PENDING
        }
    }
}

// MARK: - Lenient decode helpers (Prisma decimals may arrive as strings/numbers)

private func targetControlFlexDouble<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
    return nil
}

private func targetControlFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) {
        if let i = Int(s) { return i }
        if let d = Double(s) { return Int(d.rounded()) }
    }
    return nil
}

private func targetControlFlexBool<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Bool? {
    if let b = try? c.decodeIfPresent(Bool.self, forKey: k) { return b }
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i != 0 }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return s == "true" || s == "1" }
    return nil
}

// MARK: - Models (same field names volumeTargetDto sends on the wire)

private struct TargetControlPenalty: Decodable, Equatable {
    let id: String
    let status: String
    let originalAmountBdt: Double
    let appliedAmountBdt: Double?
    let waivedAmountBdt: Double?
    let finalPenaltyBdt: Double

    private enum Keys: String, CodingKey {
        case id, status, originalAmountBdt, appliedAmountBdt, waivedAmountBdt, finalPenaltyBdt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        status = (try? c.decode(String.self, forKey: .status)) ?? "PENDING"
        originalAmountBdt = targetControlFlexDouble(c, .originalAmountBdt) ?? 0
        appliedAmountBdt = targetControlFlexDouble(c, .appliedAmountBdt)
        waivedAmountBdt = targetControlFlexDouble(c, .waivedAmountBdt)
        finalPenaltyBdt = targetControlFlexDouble(c, .finalPenaltyBdt) ?? 0
    }
}

private struct TargetControlRow: Decodable, Identifiable, Equatable {
    let id: String
    let accountTitle: String
    let assignedUserName: String?
    let targetDate: String
    let targetUsdt: Double
    let actualUsdt: Double
    let shortfallUsdt: Double
    let status: String
    let penaltyAmountBdt: Double?
    let notes: String?
    let penalty: TargetControlPenalty?

    private enum Keys: String, CodingKey {
        case id, accountTitle, assignedUserName, targetDate, targetUsdt, actualUsdt
        case shortfallUsdt, status, penaltyAmountBdt, notes, penalty
    }
    /// Decode defensively — one bad row must never kill the whole list.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let rawId = try? c.decodeIfPresent(String.self, forKey: .id)
        accountTitle = (try? c.decodeIfPresent(String.self, forKey: .accountTitle)) ?? "Trading account"
        assignedUserName = try? c.decodeIfPresent(String.self, forKey: .assignedUserName)
        targetDate = (try? c.decodeIfPresent(String.self, forKey: .targetDate)) ?? ""
        id = rawId ?? "\(accountTitle)-\(targetDate)"
        targetUsdt = targetControlFlexDouble(c, .targetUsdt) ?? 0
        actualUsdt = targetControlFlexDouble(c, .actualUsdt) ?? 0
        shortfallUsdt = targetControlFlexDouble(c, .shortfallUsdt) ?? max(0, targetUsdt - actualUsdt)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "PENDING"
        penaltyAmountBdt = targetControlFlexDouble(c, .penaltyAmountBdt)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        penalty = try? c.decodeIfPresent(TargetControlPenalty.self, forKey: .penalty)
    }

    static func == (a: TargetControlRow, b: TargetControlRow) -> Bool {
        a.id == b.id && a.status == b.status && a.actualUsdt == b.actualUsdt
    }

    /// 0…1 fill for the progress bar (never NaN when target is 0).
    var progress: Double {
        guard targetUsdt > 0 else { return actualUsdt > 0 ? 1 : 0 }
        return min(1, max(0, actualUsdt / targetUsdt))
    }
}

/// GET /api/trading/volume-targets — flat `{ date, targets, canManage }`;
/// tolerate an `{ ok, data: {…} }` wrap too, like the other native decoders.
private struct TargetControlListResponse: Decodable {
    let targets: [TargetControlRow]
    let canManage: Bool

    private enum Keys: String, CodingKey { case ok, data, targets, canManage }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        targets = (try? c.decode([TargetControlRow].self, forKey: .targets)) ?? []
        canManage = (try? c.decodeIfPresent(Bool.self, forKey: .canManage)) ?? false
    }
}

private struct TargetControlSettings: Decodable, Equatable {
    let autoPenaltyEnabled: Bool
    let defaultPenaltyBdt: Int

    private enum Keys: String, CodingKey { case autoPenaltyEnabled, defaultPenaltyBdt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        autoPenaltyEnabled = targetControlFlexBool(c, .autoPenaltyEnabled) ?? false
        defaultPenaltyBdt = targetControlFlexInt(c, .defaultPenaltyBdt) ?? 500
    }
}

private struct TargetControlSettingsResponse: Decodable {
    let settings: TargetControlSettings?
    private enum Keys: String, CodingKey { case ok, data, settings }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        settings = try? c.decodeIfPresent(TargetControlSettings.self, forKey: .settings)
    }
}

private struct TargetControlOffender: Decodable, Identifiable, Equatable {
    let employeeId: String
    let count: Int
    var id: String { employeeId }

    private enum Keys: String, CodingKey { case employeeId, count }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        employeeId = (try? c.decodeIfPresent(String.self, forKey: .employeeId)) ?? "—"
        count = targetControlFlexInt(c, .count) ?? 0
    }
}

/// Month analytics — super admins get `analytics` (with penalty money), admins
/// get the trimmed `summary`. Decode both from one struct.
private struct TargetControlAnalytics: Decodable, Equatable {
    let month: String
    let targetCount: Int
    let met: Int
    let missed: Int
    let ignored: Int
    let totalAppliedBdt: Int?
    let totalWaivedBdt: Int?
    let netPenaltiesBdt: Int?
    let repeatOffenders: [TargetControlOffender]

    private enum Keys: String, CodingKey {
        case month, targetCount, met, missed, ignored
        case totalAppliedBdt, totalWaivedBdt, netPenaltiesBdt, repeatOffenders
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        month = (try? c.decodeIfPresent(String.self, forKey: .month)) ?? ""
        targetCount = targetControlFlexInt(c, .targetCount) ?? 0
        met = targetControlFlexInt(c, .met) ?? 0
        missed = targetControlFlexInt(c, .missed) ?? 0
        ignored = targetControlFlexInt(c, .ignored) ?? 0
        totalAppliedBdt = targetControlFlexInt(c, .totalAppliedBdt)
        totalWaivedBdt = targetControlFlexInt(c, .totalWaivedBdt)
        netPenaltiesBdt = targetControlFlexInt(c, .netPenaltiesBdt)
        repeatOffenders = (try? c.decodeIfPresent([TargetControlOffender].self, forKey: .repeatOffenders)) ?? []
    }
}

private struct TargetControlAnalyticsResponse: Decodable {
    let analytics: TargetControlAnalytics?
    private enum Keys: String, CodingKey { case ok, data, analytics, summary }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        analytics = (try? c.decodeIfPresent(TargetControlAnalytics.self, forKey: .analytics))
            ?? (try? c.decodeIfPresent(TargetControlAnalytics.self, forKey: .summary))
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
private final class TargetControlVM {
    var date = Date()
    var targets: [TargetControlRow] = []
    var settings: TargetControlSettings? = nil
    var analytics: TargetControlAnalytics? = nil
    var canManage = false
    var tab: TargetControlTab = .targets
    var loading = false
    var error: String? = nil
    var authExpired = false

    /// Web penaltyQueue: MISSED rows whose penalty is absent or still PENDING.
    var penaltyQueue: [TargetControlRow] {
        targets.filter { $0.status == "MISSED" && ($0.penalty == nil || $0.penalty?.status == "PENDING") }
    }

    // ── Day totals for the hero (sum of the selected date's rows) ──
    var dayTarget: Double { targets.reduce(0) { $0 + $1.targetUsdt } }
    var dayActual: Double { targets.reduce(0) { $0 + $1.actualUsdt } }
    var dayProgress: Double {
        guard dayTarget > 0 else { return dayActual > 0 ? 1 : 0 }
        return min(1, max(0, dayActual / dayTarget))
    }
    var dayMet: Int { targets.filter { $0.status == "MET" }.count }

    var dateParam: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }
    var monthParam: String { String(dateParam.prefix(7)) }

    /// Same three parallel loads the web page fires (list + settings + month analytics).
    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            async let listReq: TargetControlListResponse = AlmaAPI.shared.get(
                "/api/trading/volume-targets", query: ["date": dateParam])
            async let settingsReq: TargetControlSettingsResponse = AlmaAPI.shared.get(
                "/api/trading/volume-targets/settings")
            async let analyticsReq: TargetControlAnalyticsResponse = AlmaAPI.shared.get(
                "/api/trading/volume-targets/analytics", query: ["month": monthParam])
            let (list, settingsRes, analyticsRes) = try await (listReq, settingsReq, analyticsReq)
            targets = list.targets
            canManage = list.canManage
            settings = settingsRes.settings
            analytics = analyticsRes.analytics
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — never surface that.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    // ── Native writes (owner 2026-07-11) — web api.trading.volumeTarget* verbatim. ──

    var toast: String? = nil
    var busyId: String? = nil
    var accounts: [(id: String, title: String)] = []

    private struct AnyOkResponse: Decodable { let ok: Bool?, error: String? }

    /// Account options for the create sheet (web useTradingAccounts ACTIVE).
    func loadAccounts() async {
        struct Row: Decodable { let id: String?, accountTitle: String? }
        struct Resp: Decodable { let accounts: [Row]? }
        if let r: Resp = try? await AlmaAPI.shared.get(
            "/api/trading/accounts", query: ["status": "ACTIVE"]) {
            accounts = (r.accounts ?? []).compactMap { row in
                guard let id = row.id else { return nil }
                return (id, row.accountTitle ?? "Account")
            }
        }
    }

    struct CreatePayload: Encodable {
        let trading_account_id: String
        let target_date: String
        let target_usdt: Double
        let penalty_amount_bdt: Double?
    }
    func createTarget(_ p: CreatePayload) async -> Bool {
        await write(success: "Daily target created") {
            try await AlmaAPI.shared.send("POST", "/api/trading/volume-targets", body: p)
        }
    }

    /// POST /api/trading/volume-targets/{id}/actions — REFRESH / APPLY_PENALTY /
    /// WAIVE_PENALTY / IGNORE (web runAction).
    struct ActionPayload: Encodable {
        let action: String
        var amount_bdt: Double? = nil
        var waive_amount_bdt: Double? = nil
    }
    func runAction(_ id: String, _ p: ActionPayload) async -> Bool {
        busyId = id
        defer { busyId = nil }
        return await write(success: "Updated") {
            try await AlmaAPI.shared.send("POST", "/api/trading/volume-targets/\(id)/actions", body: p)
        }
    }

    func deleteTarget(_ id: String) async -> Bool {
        busyId = id
        defer { busyId = nil }
        return await write(success: "Removed") {
            try await AlmaAPI.shared.send("DELETE", "/api/trading/volume-targets/\(id)")
        }
    }

    struct SettingsPayload: Encodable {
        let auto_penalty_enabled: Bool
        let default_penalty_bdt: Double
    }
    func saveSettings(_ p: SettingsPayload) async -> Bool {
        await write(success: "Auto-penalty settings saved") {
            try await AlmaAPI.shared.send("PATCH", "/api/trading/volume-targets/settings", body: p)
        }
    }

    private func write(success: String, _ op: () async throws -> AnyOkResponse) async -> Bool {
        do {
            let res = try await op()
            if let err = res.error {
                toast = err
                return false
            }
            toast = success
            await load()
            return true
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return false
        } catch {
            if Self.isCancellation(error) { return false }
            toast = error.localizedDescription
            return false
        }
    }
}

private enum TargetControlTab: String, CaseIterable {
    case targets, penalties, analytics, settings
}

// MARK: - Screen

@available(iOS 17.0, *)
struct TargetControlScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = TargetControlVM()
    @State private var showCreate = false
    @State private var settingsAutoPenalty = false
    @State private var settingsPenaltyText = "500"
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                heroBoard
                dateRow
                tabChips
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }

                switch vm.tab {
                case .targets, .penalties:
                    targetList
                case .analytics:
                    analyticsCard
                case .settings:
                    settingsCard
                }

                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(TargetControlAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task {
            await vm.load()
            await vm.loadAccounts()
            if let s = vm.settings {
                settingsAutoPenalty = s.autoPenaltyEnabled
                settingsPenaltyText = String(Int(s.defaultPenaltyBdt))
            }
        }
        .sheet(isPresented: $showCreate) { TargetControlCreateSheet(vm: vm) }
        .overlay(alignment: .bottom) {
            if let t = vm.toast {
                Text(t)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task {
                        try? await Task.sleep(nanoseconds: 2_600_000_000)
                        withAnimation { vm.toast = nil }
                    }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: vm.toast != nil)
    }

    // ── Bento board: dark hero (day USDT progress) + month KPI tiles
    //    (web: Targets / Met green / Missed red / Ignored) ──

    private var heroBoard: some View {
        VStack(spacing: 10) {
            TargetControlHeroCard(actual: vm.dayActual,
                                  target: vm.dayTarget,
                                  progress: vm.dayProgress,
                                  accounts: vm.targets.count,
                                  met: vm.dayMet)
            if let a = vm.analytics {
                HStack(spacing: 10) {
                    TargetControlStatTile(label: "Targets", value: a.targetCount,
                                          format: { "\($0)" }, sub: "এ মাসে মোট",
                                          tint: .primary, accent: TargetControlPalette.tradingGreen)
                    TargetControlStatTile(label: "Met", value: a.met,
                                          format: { "\($0)" }, sub: "টার্গেট পূরণ",
                                          tint: TargetControlPalette.positive(colorScheme),
                                          accent: TargetControlPalette.green400)
                    TargetControlStatTile(label: "Missed", value: a.missed,
                                          format: { "\($0)" }, sub: "টার্গেট মিস",
                                          tint: TargetControlPalette.red400,
                                          accent: TargetControlPalette.red500)
                    TargetControlStatTile(label: "Ignored", value: a.ignored,
                                          format: { "\($0)" }, sub: "মাফ করা",
                                          tint: TargetControlPalette.slate400,
                                          accent: TargetControlPalette.slate400)
                }
            }
        }
        .padding(.top, 4)
    }

    // ── Date filter (web: <input type="date"> in the shell actions) ──

    private var dateRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "calendar")
                .font(.footnote)
                .foregroundStyle(TargetControlPalette.tradingGreen)
            DatePicker("Target date", selection: Binding(
                get: { vm.date },
                set: { newValue in
                    vm.date = newValue
                    Task { await vm.load() }
                }), displayedComponents: .date)
                .labelsHidden()
                .datePickerStyle(.compact)
            Spacer()
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                Task { await vm.load() }
            } label: {
                if vm.loading {
                    AlmaStarburstLoader(mode: .searching, size: 15)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .targetControlGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Tab chips (web: Accounts / Penalty queue (n) / Analytics / Settings) ──

    private var tabChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TargetControlTab.allCases, id: \.self) { t in
                    chip(t)
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func chip(_ t: TargetControlTab) -> some View {
        let active = vm.tab == t
        let tint = t == .penalties && !vm.penaltyQueue.isEmpty
            ? TargetControlPalette.red400 : TargetControlPalette.tradingGreen
        return Button {
            UISelectionFeedbackGenerator().selectionChanged()
            vm.tab = t
        } label: {
            HStack(spacing: 5) {
                Text(chipLabel(t)).font(.footnote.weight(active ? .semibold : .regular))
                    .foregroundStyle(active ? tint : .secondary)
                if t == .penalties && !vm.penaltyQueue.isEmpty {
                    Text("\(vm.penaltyQueue.count)")
                        .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(active ? tint.opacity(colorScheme == .dark ? 0.28 : 0.16)
                               : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                        in: Capsule())
            .overlay(Capsule().strokeBorder(
                active ? tint.opacity(0.55) : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func chipLabel(_ t: TargetControlTab) -> String {
        switch t {
        case .targets: return "Accounts"
        case .penalties: return "Penalty queue"
        case .analytics: return "Analytics"
        case .settings: return "Settings"
        }
    }

    // ── Target cards (Accounts / Penalty queue tabs) ──

    @ViewBuilder private var targetList: some View {
        let rows = vm.tab == .penalties ? vm.penaltyQueue : vm.targets
        if vm.canManage {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                showCreate = true
            } label: {
                Label("+ Set target", systemImage: "target")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TargetControlPalette.accentText(colorScheme))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(TargetControlPalette.tradingGreen.opacity(0.10),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                        .strokeBorder(TargetControlPalette.tradingGreen.opacity(0.3), lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
        if vm.loading && vm.targets.isEmpty {
            loadingRows
        } else if rows.isEmpty && !vm.loading && vm.error == nil && !vm.authExpired {
            emptyState
        } else {
            ForEach(rows) { row in
                TargetControlRowCard(row: row, vm: vm)
            }
        }
    }

    // ── Analytics tab (web: note card; super admin gets penalty money here too) ──

    private var analyticsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("MONTH ANALYTICS")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if let a = vm.analytics {
                statRow("Month", a.month.isEmpty ? vm.monthParam : a.month)
                statRow("Targets", "\(a.targetCount)")
                statRow("Met", "\(a.met)", tint: TargetControlPalette.positive(colorScheme))
                statRow("Missed", "\(a.missed)", tint: TargetControlPalette.red400)
                statRow("Ignored", "\(a.ignored)", tint: TargetControlPalette.slate400)
                if let applied = a.totalAppliedBdt {
                    Divider().opacity(0.4)
                    statRow("Penalties applied", "৳\(applied.formatted())",
                            tint: TargetControlPalette.red400)
                    statRow("Waived", "৳\((a.totalWaivedBdt ?? 0).formatted())",
                            tint: TargetControlPalette.slate400)
                    statRow("Net penalties", "৳\((a.netPenaltiesBdt ?? 0).formatted())",
                            tint: TargetControlPalette.accentText(colorScheme))
                }
                if !a.repeatOffenders.isEmpty {
                    Divider().opacity(0.4)
                    Text("REPEAT OFFENDERS")
                        .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                    ForEach(a.repeatOffenders) { o in
                        statRow(o.employeeId, "\(o.count)×",
                                tint: TargetControlPalette.amber500)
                    }
                }
            } else {
                Text(vm.canManage
                     ? "Use Accounts and Penalty queue for enforcement. Month KPIs are shown above."
                     : "Summary KPIs above reflect the selected month. Contact Super Admin for penalty actions.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .targetControlGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Settings tab (read-only mirror; editing = web escape) ──

    private var settingsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("AUTO-PENALTY CONFIGURATION")
                .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if vm.settings != nil, vm.canManage {
                // Native settings write (owner 2026-07-11) — web saveSettings parity.
                Toggle("Auto-penalty", isOn: $settingsAutoPenalty)
                    .font(.subheadline)
                    .tint(TargetControlPalette.tradingGreen)
                HStack {
                    Text("Default penalty (৳)").font(.subheadline)
                    Spacer()
                    TextField("500", text: $settingsPenaltyText)
                        .keyboardType(.numberPad)
                        .font(.subheadline.weight(.bold).monospacedDigit())
                        .multilineTextAlignment(.trailing)
                        .frame(width: 100)
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(Color.primary.opacity(0.06),
                                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                Button {
                    let amount = Double(settingsPenaltyText) ?? 500
                    Task {
                        _ = await vm.saveSettings(.init(
                            auto_penalty_enabled: settingsAutoPenalty,
                            default_penalty_bdt: amount))
                    }
                } label: {
                    Text("Save settings")
                        .font(.caption.weight(.bold))
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                }
                .buttonStyle(.borderedProminent)
                .tint(TargetControlPalette.tradingGreen)
            } else if let s = vm.settings {
                HStack {
                    Text("Auto-penalty").font(.subheadline)
                    Spacer()
                    Text(s.autoPenaltyEnabled ? "On" : "Off")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(s.autoPenaltyEnabled
                                         ? TargetControlPalette.positive(colorScheme)
                                         : TargetControlPalette.slate400)
                }
                HStack {
                    Text("Default penalty").font(.subheadline)
                    Spacer()
                    Text("৳\(s.defaultPenaltyBdt.formatted())")
                        .font(.subheadline.weight(.bold).monospacedDigit())
                        .foregroundStyle(TargetControlPalette.accentText(colorScheme))
                }
            } else {
                Text("সেটিংস লোড হয়নি").font(.footnote).foregroundStyle(.secondary)
            }
            Button {
                openWeb("/trading/target-control", "Target control")
            } label: {
                Label("ওয়েব ভার্সন", systemImage: "safari")
                    .font(.footnote.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(TargetControlPalette.tradingGreen.opacity(colorScheme == .dark ? 0.22 : 0.14),
                                in: Capsule())
                    .overlay(Capsule().strokeBorder(
                        TargetControlPalette.tradingGreen.opacity(0.4), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .foregroundStyle(TargetControlPalette.tradingGreen)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .targetControlGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func statRow(_ label: String, _ value: String, tint: Color = .primary) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.bold).monospacedDigit()).foregroundStyle(tint)
        }
    }

    // ── Shared bits ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .targetControlGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(TargetControlPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).targetControlGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 96)
                .targetControlGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .targetControlShimmer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "target").font(.largeTitle).foregroundStyle(.secondary)
            Text(vm.tab == .penalties ? "কোনো পেনাল্টি বাকি নেই" : "কোনো টার্গেট নেই")
                .foregroundStyle(.secondary)
            Text(vm.tab == .penalties
                 ? "মিস করা টার্গেটের পেনাল্টি এখানে আসবে"
                 : "এই দিনের জন্য কোনো USDT টার্গেট সেট করা হয়নি")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 50)
        .padding(.bottom, 30)
    }

    private var webEscape: some View {
        Button {
            openWeb("/trading/target-control", "Target control")
        } label: {
            Label("টার্গেট সেট / পেনাল্টি অ্যাকশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Target row card (web Card: account · assignee/date · target vs actual ·
// status pill — plus a native progress bar the web renders as text)

@available(iOS 17.0, *)
private struct TargetControlRowCard: View {
    let row: TargetControlRow
    var vm: TargetControlVM? = nil
    @Environment(\.colorScheme) private var colorScheme
    @State private var confirmingDelete = false
    @State private var confirmingPenalty = false

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.accountTitle).font(.subheadline.weight(.bold)).lineLimit(1)
                    Text("\(row.assignedUserName ?? "Unassigned") · \(String(row.targetDate.prefix(10)))")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 6)
                statusPill
            }

            // Actual vs target — the web shows "Target X USDT · Actual Y USDT · Short Z".
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(TargetControlFormat.usdt(row.actualUsdt))
                    .font(.title3.weight(.heavy).monospacedDigit())
                    .foregroundStyle(barTint)
                Text("/ \(TargetControlFormat.usdt(row.targetUsdt)) USDT")
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                if row.shortfallUsdt > 0 {
                    Text("Short \(TargetControlFormat.usdt(row.shortfallUsdt))")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(TargetControlPalette.red400)
                }
            }

            progressBar

            if let p = row.penalty {
                penaltyLine(p)
            } else if row.status == "MISSED", let amt = row.penaltyAmountBdt {
                Text("Penalty due · ৳\(Int(amt.rounded()).formatted())")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(TargetControlPalette.amber500)
            }

            actionsRow
        }
        .padding(14)
        .targetControlGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Native manage actions (owner 2026-07-11) — web runAction/delete parity,
    //    SUPER_ADMIN only (vm.canManage mirrors the web's role gate). ──

    @ViewBuilder private var actionsRow: some View {
        if let vm, vm.canManage {
            let busy = vm.busyId == row.id
            let defaultPenalty = Double(vm.settings?.defaultPenaltyBdt ?? 500)
            HStack(spacing: 8) {
                chip("Refresh", TargetControlPalette.tradingGreen, busy) {
                    Task { _ = await vm.runAction(row.id, .init(action: "REFRESH")) }
                }
                if row.status == "MISSED", row.penalty == nil || row.penalty?.status == "PENDING" {
                    chip("Penalty", TargetControlPalette.red400, busy) { confirmingPenalty = true }
                    if let p = row.penalty {
                        chip("Waive", TargetControlPalette.slate400, busy) {
                            Task {
                                _ = await vm.runAction(row.id, .init(
                                    action: "WAIVE_PENALTY", waive_amount_bdt: p.finalPenaltyBdt))
                            }
                        }
                    }
                    chip("Ignore", TargetControlPalette.slate400, busy) {
                        Task { _ = await vm.runAction(row.id, .init(action: "IGNORE")) }
                    }
                }
                chip("Delete", TargetControlPalette.red400, busy) { confirmingDelete = true }
            }
            .confirmationDialog("Delete this target?", isPresented: $confirmingDelete,
                                titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task { _ = await vm.deleteTarget(row.id) }
                }
                Button("বাতিল", role: .cancel) {}
            }
            .confirmationDialog(
                "৳\(Int((row.penaltyAmountBdt ?? defaultPenalty).rounded()).formatted()) penalty apply করবেন?",
                isPresented: $confirmingPenalty, titleVisibility: .visible
            ) {
                Button("হ্যাঁ, apply করুন", role: .destructive) {
                    Task {
                        _ = await vm.runAction(row.id, .init(
                            action: "APPLY_PENALTY",
                            amount_bdt: row.penaltyAmountBdt ?? defaultPenalty))
                    }
                }
                Button("বাতিল", role: .cancel) {}
            }
        }
    }

    private func chip(_ label: String, _ tint: Color, _ busy: Bool,
                      action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            HStack(spacing: 4) {
                if busy { ProgressView().controlSize(.mini) }
                Text(label).font(.system(size: 10, weight: .bold))
            }
            .foregroundStyle(tint)
            .padding(.horizontal, 9).padding(.vertical, 6)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.3), lineWidth: 0.8))
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }

    private var barTint: Color {
        if row.status == "MET" || row.progress >= 1 { return TargetControlPalette.positive(colorScheme) }
        if row.status == "MISSED" { return TargetControlPalette.red400 }
        return colorScheme == .dark ? TargetControlPalette.amber500 : TargetControlPalette.amber600
    }

    private var progressBar: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                Capsule()
                    .fill(LinearGradient(colors: [barTint.opacity(0.75), barTint],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(6, geo.size.width * row.progress))
            }
        }
        .frame(height: 6)
    }

    private var statusPill: some View {
        let tint = TargetControlPalette.status(row.status, colorScheme)
        return Text(row.status)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(tint.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
    }

    private func penaltyLine(_ p: TargetControlPenalty) -> some View {
        let tint = TargetControlPalette.penalty(p.status, colorScheme)
        return HStack(spacing: 6) {
            Circle().fill(tint).frame(width: 6, height: 6)
            Text("Penalty \(p.status.replacingOccurrences(of: "_", with: " ").lowercased())")
                .font(.caption2.weight(.semibold)).foregroundStyle(tint)
            Spacer()
            Text("৳\(Int(p.finalPenaltyBdt.rounded()).formatted())")
                .font(.caption2.weight(.bold).monospacedDigit()).foregroundStyle(tint)
        }
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(tint.opacity(0.10), in: Capsule())
    }
}

// MARK: - Formatting helpers

private enum TargetControlFormat {
    /// USDT amounts — whole numbers stay whole, decimals trim to 2 places.
    static func usdt(_ v: Double) -> String {
        if v == v.rounded() && abs(v) < 1e15 {
            return Int(v).formatted()
        }
        return v.formatted(.number.precision(.fractionLength(0...2)))
    }
}

// MARK: - Bento components (TargetControl-owned copies of the board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func targetControlMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear) — one Animatable interpolation, no
/// timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct TargetControlCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Double
    let format: (Double) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? target : 0
        TargetControlCountUpText(value: shown, format: format)
            .animation(targetControlMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if targetControlMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct TargetControlCountUpText: View, Animatable {
    var value: Double
    var format: (Double) -> String
    var animatableData: Double {
        get { value }
        set { value = newValue }
    }
    var body: some View {
        Text(format(value))
    }
}

/// Shared tile backdrop: frosted glass + a soft diagonal accent wash.
@available(iOS 17.0, *)
private func targetControlBentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
    ZStack {
        RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous).fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .fill(Color.white.opacity(scheme == .dark ? 0.04 : 0.35))
        LinearGradient(colors: [accent.opacity(scheme == .dark ? 0.14 : 0.10), .clear],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
}

/// Small glass stat tile — count-up value + sub line over a soft accent wash.
@available(iOS 17.0, *)
private struct TargetControlStatTile: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: Int
    let format: (Int) -> String
    let sub: String
    let tint: Color
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.75)
            TargetControlCountUp(target: Double(value),
                                 format: { format(Int($0.rounded())) })
                .font(.system(size: 17, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 11).padding(.vertical, 12)
        .background { targetControlBentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe,
/// re-tinted with the trading sage-green accent). Day's actual USDT count-up over
/// the summed target, a native progress bar, plus Accounts / Met splits.
@available(iOS 17.0, *)
private struct TargetControlHeroCard: View {
    let actual: Double
    let target: Double
    let progress: Double
    let accounts: Int
    let met: Int

    private static let sage = TargetControlPalette.tradingGreen
    private static let sageLt = Color(red: 0.671, green: 0.851, blue: 0.757)   // lighter sage tint

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("ডেইলি ভলিউম টার্গেট · TRADING").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(Self.sageLt)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                TargetControlCountUp(target: actual,
                                     format: { TargetControlFormat.usdt($0.rounded()) })
                    .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                    .foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.6)
                Text("USDT").font(.caption.weight(.bold)).foregroundStyle(.white.opacity(0.55))
            }
            .padding(.top, 8)
            Text("টার্গেট \(TargetControlFormat.usdt(target)) USDT-এর মধ্যে আজকের ভলিউম")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            // Day progress bar (sum actual / sum target).
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.12))
                    Capsule()
                        .fill(LinearGradient(colors: [Self.sage, Self.sageLt],
                                             startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(6, geo.size.width * progress))
                }
            }
            .frame(height: 7)
            .padding(.top, 12)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Accounts", value: Double(accounts), format: { "\(Int($0.rounded()))" },
                         tint: .white, sub: "আজকের টার্গেট")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Met", value: Double(met), format: { "\(Int($0.rounded()))" },
                         tint: Self.sageLt, sub: "টার্গেট পূরণ")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Progress", value: progress * 100, format: { "\(Int($0.rounded()))%" },
                         tint: .white, sub: "দিনের অগ্রগতি")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.078, green: 0.125, blue: 0.106))   // deep sage-black
                LinearGradient(colors: [Self.sage.opacity(0.38), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.22), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [AlmaSwiftTheme.coral.opacity(0.14), .clear],
                               center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 220)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(.white.opacity(0.16), lineWidth: 1))
        // Always the board's dark anchor — force dark traits inside the card.
        .environment(\.colorScheme, .dark)
    }

    private func heroStat(label: String, value: Double, format: @escaping (Double) -> String,
                          tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            TargetControlCountUp(target: value, format: format)
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Aurora background + glass (TargetControl-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct TargetControlAurora: View {
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
    func targetControlGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct TargetControlShimmer: ViewModifier {
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
    func targetControlShimmer() -> some View { modifier(TargetControlShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Target Control — Light") {
    TargetControlScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}

// MARK: - Create target sheet (owner 2026-07-11 — web "+ Set target" form parity).

@available(iOS 17.0, *)
private struct TargetControlCreateSheet: View {
    let vm: TargetControlVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var accountId = ""
    @State private var targetUsdt = ""
    @State private var penaltyBdt = ""
    @State private var submitting = false
    @State private var confirming = false
    @State private var errorText: String? = nil

    private func num(_ s: String) -> Double { Double(s.replacingOccurrences(of: ",", with: "")) ?? 0 }
    private var canSubmit: Bool { !accountId.isEmpty && num(targetUsdt) > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Set daily target").font(.subheadline.weight(.bold)).padding(.top, 20)
            Text("তারিখ: \(vm.dateParam)").font(.caption).foregroundStyle(.secondary)
            Menu {
                ForEach(vm.accounts, id: \.id) { a in
                    Button(a.title) { accountId = a.id }
                }
            } label: {
                HStack {
                    Text(vm.accounts.first(where: { $0.id == accountId })?.title ?? "অ্যাকাউন্ট বাছুন")
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.caption2)
                }
                .foregroundStyle(.primary)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Color.primary.opacity(0.06),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            }
            TextField("Target USDT", text: $targetUsdt)
                .keyboardType(.decimalPad)
                .font(.title3.weight(.bold)).monospacedDigit()
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Color.primary.opacity(0.06),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            TextField("Penalty BDT (ঐচ্ছিক — default \(vm.settings?.defaultPenaltyBdt ?? 500))", text: $penaltyBdt)
                .keyboardType(.numberPad)
                .font(.subheadline)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Color.primary.opacity(0.06),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            if let errorText {
                Text(errorText).font(.caption2.weight(.semibold))
                    .foregroundStyle(TargetControlPalette.red400)
            }
            Button {
                confirming = true
            } label: {
                HStack(spacing: 8) {
                    if submitting { ProgressView().tint(.white) }
                    Text("Create target").font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(canSubmit && !submitting
                            ? TargetControlPalette.tradingGreen
                            : TargetControlPalette.tradingGreen.opacity(0.4),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit || submitting)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .presentationDetents([.height(400)])
        .presentationDragIndicator(.visible)
        .background(AlmaSwiftTheme.rootBg(scheme))
        .confirmationDialog(
            "\(TargetControlFormat.usdt(num(targetUsdt))) USDT target সেট করবেন?",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, সেট করুন") { submit() }
            Button("বাতিল", role: .cancel) {}
        }
    }

    private func submit() {
        guard canSubmit, !submitting else { return }
        submitting = true; errorText = nil
        Task {
            defer { submitting = false }
            let ok = await vm.createTarget(.init(
                trading_account_id: accountId,
                target_date: vm.dateParam,
                target_usdt: num(targetUsdt),
                penalty_amount_bdt: penaltyBdt.isEmpty ? nil : num(penaltyBdt)))
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { dismiss() } else { errorText = vm.toast }
        }
    }
}
