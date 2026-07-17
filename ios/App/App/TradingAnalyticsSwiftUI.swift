//
//  TradingAnalyticsSwiftUI.swift
//  ALMA ERP — the ALMA Trading analytics page (/trading/analytics) as a native
//  SwiftUI screen (read-only).
//
//  Mirrors the web page — same endpoint, same defaults, same blocks:
//    GET /api/trading/analytics?startDate=…&endDate=…&staffId=…&accountId=…
//                              &status=…&profitability=…            → analytics
//    GET /api/trading/accounts?status=ALL   → account picker options
//    GET /api/trading/staff                 → staff picker options
//  Web-parity blocks: filter card (date range → native preset chips · staff ·
//  account · status · profitability pickers; min/max ROI stays on the web) ·
//  11-KPI board re-set in the bento language (managed-capital hero with the
//  today/weekly/monthly net split · USDT/fees/expenses/headcount tiles) ·
//  Analytics Alerts (tone-red) · three mini trend line charts (Profit #4ade80 ·
//  USDT Volume #d6a94a · Expense #f87171 — the web MiniTrendChart polylines,
//  redrawn as native Paths) · four RankingBars cards (Top Profitable / Top Loss /
//  Best Spread / Highest Expense — green/red signed bars) · Staff Performance
//  ranked list · Merchant Account Intelligence rows (client-side search, same
//  fields the web filters on) · Expense Intelligence bars. CSV/Excel/PDF exports
//  and custom date/ROI inputs stay on the web escape hatch.
//  Trading hero accent: sage green (owner spec) instead of the coral hero.
//  Carried lessons: lenient decoding, cancellation-safe .refreshable, auth card,
//  ONE spinner pattern, no global overlays.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum TradingAnalyticsPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let red400 = Color(red: 0.973, green: 0.443, blue: 0.443)         // #F87171
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let amber300 = Color(red: 0.988, green: 0.827, blue: 0.302)       // #FCD34D
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let green300 = Color(red: 0.525, green: 0.937, blue: 0.675)       // #86EFAC
    static let zinc400 = Color(red: 0.631, green: 0.631, blue: 0.667)        // #A1A1AA
    /// Trading hero accent green (owner spec — ≈ AlmaSwiftTheme.sage #81B29A).
    static let tradingGreen = Color(red: 0.51, green: 0.70, blue: 0.60)
    /// Web trading gold `#d6a94a` — the USDT volume trend line.
    static let tradingGold = Color(red: 0.839, green: 0.663, blue: 0.290)

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
    /// Web "txt-pos" family — emerald on cream, bright green over dark aurora.
    static func positive(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? green400 : emerald600
    }
    /// Web signedClass: value >= 0 → text-green-400, else text-red-400.
    static func signed(_ value: Double, _ scheme: ColorScheme) -> Color {
        value >= 0 ? positive(scheme) : (scheme == .dark ? red400 : red500)
    }
    /// Web statusClass: ACTIVE green-300 · COMPLETED gold-lt · PAUSED amber-300 ·
    /// else zinc-400 (darkened equivalents on cream so pills stay readable).
    static func status(_ s: String, _ scheme: ColorScheme) -> Color {
        switch s.uppercased() {
        case "ACTIVE": return scheme == .dark ? green300 : emerald600
        case "COMPLETED": return accentText(scheme)
        case "PAUSED": return scheme == .dark ? amber300 : amber600
        default: return zinc400
        }
    }
    /// Web AccountIntelRow health tint: HEALTHY green-400 · HIGH_RISK red-400 ·
    /// else amber-500.
    static func health(_ h: String, _ scheme: ColorScheme) -> Color {
        switch h.uppercased() {
        case "HEALTHY": return positive(scheme)
        case "HIGH_RISK": return scheme == .dark ? red400 : red500
        default: return scheme == .dark ? amber500 : amber600
        }
    }
}

// MARK: - Lenient decode helpers (Prisma decimals arrive as numbers or strings)

private func tradingAnalyticsFlexDouble<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
    return nil
}

private func tradingAnalyticsFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    tradingAnalyticsFlexDouble(c, k).map { Int($0.rounded()) }
}

// MARK: - Models (same field names the web TradingAnalyticsResponse declares)

private struct TradingAnalyticsKpis: Decodable, Equatable {
    let totalManagedCapital: Double
    let todayNet: Double
    let weeklyNet: Double
    let monthlyNet: Double
    let totalUsdtVolume: Double
    let totalBuyUsdt: Double
    let totalSellUsdt: Double
    let totalBinanceFees: Double
    let totalOperatingExpenses: Double
    let activeMerchantAccounts: Int
    let activeStaffCount: Int

    private enum Keys: String, CodingKey {
        case totalManagedCapital, todayNet, weeklyNet, monthlyNet, totalUsdtVolume
        case totalBuyUsdt, totalSellUsdt, totalBinanceFees, totalOperatingExpenses
        case activeMerchantAccounts, activeStaffCount
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        totalManagedCapital = tradingAnalyticsFlexDouble(c, .totalManagedCapital) ?? 0
        todayNet = tradingAnalyticsFlexDouble(c, .todayNet) ?? 0
        weeklyNet = tradingAnalyticsFlexDouble(c, .weeklyNet) ?? 0
        monthlyNet = tradingAnalyticsFlexDouble(c, .monthlyNet) ?? 0
        totalUsdtVolume = tradingAnalyticsFlexDouble(c, .totalUsdtVolume) ?? 0
        totalBuyUsdt = tradingAnalyticsFlexDouble(c, .totalBuyUsdt) ?? 0
        totalSellUsdt = tradingAnalyticsFlexDouble(c, .totalSellUsdt) ?? 0
        totalBinanceFees = tradingAnalyticsFlexDouble(c, .totalBinanceFees) ?? 0
        totalOperatingExpenses = tradingAnalyticsFlexDouble(c, .totalOperatingExpenses) ?? 0
        activeMerchantAccounts = tradingAnalyticsFlexInt(c, .activeMerchantAccounts) ?? 0
        activeStaffCount = tradingAnalyticsFlexInt(c, .activeStaffCount) ?? 0
    }
}

/// Account analytics row (topProfitable/topLoss/bestSpread/highestExpense/reportRows).
private struct TradingAnalyticsAccountRow: Decodable, Identifiable, Equatable {
    let id: String
    let accountTitle: String
    let assignedUserName: String
    let status: String
    let netProfit: Double
    let roi: Double
    let averageSpread: Double
    let feeRatio: Double
    let totalExpenses: Double
    let totalUsdt: Double
    let health: String

    private enum Keys: String, CodingKey {
        case id, accountTitle, assignedUserName, status, netProfit, roi
        case averageSpread, feeRatio, totalExpenses, totalUsdt, health
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let title = (try? c.decode(String.self, forKey: .accountTitle)) ?? "—"
        accountTitle = title
        id = (try? c.decode(String.self, forKey: .id)) ?? title
        assignedUserName = (try? c.decode(String.self, forKey: .assignedUserName)) ?? "Unassigned"
        status = (try? c.decode(String.self, forKey: .status)) ?? "ACTIVE"
        netProfit = tradingAnalyticsFlexDouble(c, .netProfit) ?? 0
        roi = tradingAnalyticsFlexDouble(c, .roi) ?? 0
        averageSpread = tradingAnalyticsFlexDouble(c, .averageSpread) ?? 0
        feeRatio = tradingAnalyticsFlexDouble(c, .feeRatio) ?? 0
        totalExpenses = tradingAnalyticsFlexDouble(c, .totalExpenses) ?? 0
        totalUsdt = tradingAnalyticsFlexDouble(c, .totalUsdt) ?? 0
        health = (try? c.decode(String.self, forKey: .health)) ?? "HEALTHY"
    }
}

private struct TradingAnalyticsStaffRow: Decodable, Identifiable, Equatable {
    let userId: String
    let name: String
    let assignedAccounts: Int
    let activeAccounts: Int
    let totalTradedUsdt: Double
    let totalProfitGenerated: Double
    let totalLossGenerated: Double
    let feeEfficiency: Double
    let roiContribution: Double
    var id: String { userId }

    private enum Keys: String, CodingKey {
        case userId, name, assignedAccounts, activeAccounts, totalTradedUsdt
        case totalProfitGenerated, totalLossGenerated, feeEfficiency, roiContribution
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let n = (try? c.decode(String.self, forKey: .name)) ?? "—"
        name = n
        userId = (try? c.decode(String.self, forKey: .userId)) ?? n
        assignedAccounts = tradingAnalyticsFlexInt(c, .assignedAccounts) ?? 0
        activeAccounts = tradingAnalyticsFlexInt(c, .activeAccounts) ?? 0
        totalTradedUsdt = tradingAnalyticsFlexDouble(c, .totalTradedUsdt) ?? 0
        totalProfitGenerated = tradingAnalyticsFlexDouble(c, .totalProfitGenerated) ?? 0
        totalLossGenerated = tradingAnalyticsFlexDouble(c, .totalLossGenerated) ?? 0
        feeEfficiency = tradingAnalyticsFlexDouble(c, .feeEfficiency) ?? 0
        roiContribution = tradingAnalyticsFlexDouble(c, .roiContribution) ?? 0
    }
}

/// Trend point — the web charts read netBdt / usdtVolume / expenseBdt per day.
private struct TradingAnalyticsTrendPoint: Decodable, Identifiable, Equatable {
    let date: String
    let netBdt: Double
    let usdtVolume: Double
    let expenseBdt: Double
    var id: String { date }

    private enum Keys: String, CodingKey { case date, netBdt, usdtVolume, expenseBdt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        date = (try? c.decode(String.self, forKey: .date)) ?? ""
        netBdt = tradingAnalyticsFlexDouble(c, .netBdt) ?? 0
        usdtVolume = tradingAnalyticsFlexDouble(c, .usdtVolume) ?? 0
        expenseBdt = tradingAnalyticsFlexDouble(c, .expenseBdt) ?? 0
    }
}

private struct TradingAnalyticsAlert: Decodable, Identifiable, Equatable {
    let severity: String
    let type: String
    let accountId: String
    let accountTitle: String
    let message: String
    var id: String { "\(type)-\(accountId)" }   // web key={`${alert.type}-${alert.accountId}`}

    private enum Keys: String, CodingKey { case severity, type, accountId, accountTitle, message }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        severity = (try? c.decode(String.self, forKey: .severity)) ?? "NORMAL"
        type = (try? c.decode(String.self, forKey: .type)) ?? "ALERT"
        accountId = (try? c.decode(String.self, forKey: .accountId)) ?? ""
        accountTitle = (try? c.decode(String.self, forKey: .accountTitle)) ?? "—"
        message = (try? c.decode(String.self, forKey: .message)) ?? ""
    }
}

private struct TradingAnalyticsExpenseCat: Decodable, Identifiable, Equatable {
    let type: String
    let amount: Double
    var id: String { type }

    private enum Keys: String, CodingKey { case type, amount }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        type = (try? c.decode(String.self, forKey: .type)) ?? "—"
        amount = tradingAnalyticsFlexDouble(c, .amount) ?? 0
    }
}

/// GET /api/trading/analytics — flat payload; tolerate an `{ok,data:{…}}` wrap
/// too, like every other native decoder does.
private struct TradingAnalyticsPayload: Decodable {
    let kpis: TradingAnalyticsKpis?
    let topProfitableAccounts: [TradingAnalyticsAccountRow]
    let topLossAccounts: [TradingAnalyticsAccountRow]
    let bestSpreadAccounts: [TradingAnalyticsAccountRow]
    let highestExpenseAccounts: [TradingAnalyticsAccountRow]
    let staff: [TradingAnalyticsStaffRow]
    let expenseCategories: [TradingAnalyticsExpenseCat]
    let trend: [TradingAnalyticsTrendPoint]
    let alerts: [TradingAnalyticsAlert]
    let reportRows: [TradingAnalyticsAccountRow]

    private enum Keys: String, CodingKey {
        case ok, data, kpis, topProfitableAccounts, topLossAccounts, bestSpreadAccounts
        case highestExpenseAccounts, staff, expenseCategories, trend, alerts, reportRows
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        kpis = try? c.decodeIfPresent(TradingAnalyticsKpis.self, forKey: .kpis)
        topProfitableAccounts = ((try? c.decodeIfPresent([TradingAnalyticsAccountRow].self, forKey: .topProfitableAccounts)) ?? []) ?? []
        topLossAccounts = ((try? c.decodeIfPresent([TradingAnalyticsAccountRow].self, forKey: .topLossAccounts)) ?? []) ?? []
        bestSpreadAccounts = ((try? c.decodeIfPresent([TradingAnalyticsAccountRow].self, forKey: .bestSpreadAccounts)) ?? []) ?? []
        highestExpenseAccounts = ((try? c.decodeIfPresent([TradingAnalyticsAccountRow].self, forKey: .highestExpenseAccounts)) ?? []) ?? []
        staff = ((try? c.decodeIfPresent([TradingAnalyticsStaffRow].self, forKey: .staff)) ?? []) ?? []
        expenseCategories = ((try? c.decodeIfPresent([TradingAnalyticsExpenseCat].self, forKey: .expenseCategories)) ?? []) ?? []
        trend = ((try? c.decodeIfPresent([TradingAnalyticsTrendPoint].self, forKey: .trend)) ?? []) ?? []
        alerts = ((try? c.decodeIfPresent([TradingAnalyticsAlert].self, forKey: .alerts)) ?? []) ?? []
        reportRows = ((try? c.decodeIfPresent([TradingAnalyticsAccountRow].self, forKey: .reportRows)) ?? []) ?? []
    }
}

/// Picker options — GET /api/trading/accounts → { accounts }, /api/trading/staff → { staff }.
private struct TradingAnalyticsOption: Decodable, Identifiable, Equatable {
    let id: String
    let label: String

    private enum Keys: String, CodingKey { case id, accountTitle, name }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        label = (try? c.decodeIfPresent(String.self, forKey: .accountTitle))
            ?? (try? c.decodeIfPresent(String.self, forKey: .name))
            ?? "—"
    }
}

private struct TradingAnalyticsOptionsResponse: Decodable {
    let accounts: [TradingAnalyticsOption]
    let staff: [TradingAnalyticsOption]
    private enum Keys: String, CodingKey { case ok, data, accounts, staff }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        accounts = ((try? c.decodeIfPresent([TradingAnalyticsOption].self, forKey: .accounts)) ?? []) ?? []
        staff = ((try? c.decodeIfPresent([TradingAnalyticsOption].self, forKey: .staff)) ?? []) ?? []
    }
}

// MARK: - Date presets (web default: startDate = today−29d, endDate = today;
// custom date inputs stay on the web escape hatch)

private enum TradingAnalyticsPreset: String, CaseIterable {
    case last7, last30, thisMonth, lastMonth, last90

    var label: String {
        switch self {
        case .last7: return "Last 7 days"
        case .last30: return "Last 30 days"
        case .thisMonth: return "This month"
        case .lastMonth: return "Last month"
        case .last90: return "Last 90 days"
        }
    }

    private static var dhakaCalendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return c
    }

    private static func ymd(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    /// Inclusive yyyy-MM-dd range. `last30` reproduces the web default exactly
    /// (today − 29 days … today).
    func range(now: Date = Date()) -> (start: String, end: String) {
        let cal = Self.dhakaCalendar
        let today = cal.startOfDay(for: now)
        switch self {
        case .last7:
            let s = cal.date(byAdding: .day, value: -6, to: today) ?? today
            return (Self.ymd(s), Self.ymd(today))
        case .last30:
            let s = cal.date(byAdding: .day, value: -29, to: today) ?? today
            return (Self.ymd(s), Self.ymd(today))
        case .thisMonth:
            let s = cal.date(from: cal.dateComponents([.year, .month], from: today)) ?? today
            return (Self.ymd(s), Self.ymd(today))
        case .lastMonth:
            let thisStart = cal.date(from: cal.dateComponents([.year, .month], from: today)) ?? today
            let prevEnd = cal.date(byAdding: .day, value: -1, to: thisStart) ?? today
            let prevStart = cal.date(from: cal.dateComponents([.year, .month], from: prevEnd)) ?? prevEnd
            return (Self.ymd(prevStart), Self.ymd(prevEnd))
        case .last90:
            let s = cal.date(byAdding: .day, value: -89, to: today) ?? today
            return (Self.ymd(s), Self.ymd(today))
        }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
private final class TradingAnalyticsVM {
    var data: TradingAnalyticsPayload? = nil
    var preset: TradingAnalyticsPreset = .last30     // web default (today−29d … today)
    // NP-6 (TR-05): custom range + ROI bounds (web filter card parity).
    var customStart = ""
    var customEnd = ""
    var useCustomRange = false
    var minRoi = ""
    var maxRoi = ""
    var staffId: String? = nil                       // web default '' (all staff)
    var accountId: String? = nil                     // web default '' (all accounts)
    var status = "ALL"                               // web default 'ALL'
    var profitability = "ALL"                        // web default 'ALL'
    var search = ""                                  // client-side, like the web
    var accountOptions: [TradingAnalyticsOption] = []
    var staffOptions: [TradingAnalyticsOption] = []
    var loading = false
    var error: String? = nil
    var authExpired = false

    /// Web status Select options (minus the picker-only "All").
    static let statuses = ["ACTIVE", "PAUSED", "COMPLETED", "CLOSED"]

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        let range = preset.range()
        let start = useCustomRange && customStart.count == 10 ? customStart : range.start
        let end = useCustomRange && customEnd.count == 10 ? customEnd : range.end
        do {
            let resp: TradingAnalyticsPayload = try await AlmaAPI.shared.get(
                "/api/trading/analytics",
                query: [
                    "startDate": start,
                    "endDate": end,
                    "staffId": staffId,
                    "accountId": accountId,
                    "status": status,
                    "profitability": profitability,
                    "minRoi": minRoi.isEmpty ? nil : minRoi,
                    "maxRoi": maxRoi.isEmpty ? nil : maxRoi,
                ])
            withAnimation(.spring(duration: 0.4, bounce: 0.15)) { data = resp }
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
        }
    }

    /// Picker options — same lookups the web page mounts (accounts?status=ALL + staff).
    func loadOptions() async {
        async let accountsCall: TradingAnalyticsOptionsResponse? = try? AlmaAPI.shared.get(
            "/api/trading/accounts", query: ["status": "ALL"])
        async let staffCall: TradingAnalyticsOptionsResponse? = try? AlmaAPI.shared.get(
            "/api/trading/staff")
        let (accountsResp, staffResp) = await (accountsCall, staffCall)
        accountOptions = accountsResp?.accounts ?? []
        staffOptions = staffResp?.staff ?? []
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    /// Web searchedRows: needle over accountTitle / assignedUserName / health / status.
    var searchedRows: [TradingAnalyticsAccountRow] {
        let rows = data?.reportRows ?? []
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return rows }
        return rows.filter { r in
            [r.accountTitle, r.assignedUserName, r.health, r.status]
                .contains { $0.lowercased().contains(needle) }
        }
    }

    var maxExpenseCategory: Double {
        max(data?.expenseCategories.map(\.amount).max() ?? 1, 1)   // web Math.max(…, 1)
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct TradingAnalyticsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = TradingAnalyticsVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                presetChips
                filterMenus
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err) }
                if vm.loading && vm.data == nil {
                    loadingRows
                } else {
                    kpiBoard
                    alertsCard
                    trendCards
                    rankingCards
                    staffCard
                    accountIntelCard
                    expenseIntelCard
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(TradingAnalyticsAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task {
            async let options: Void = vm.loadOptions()
            await vm.load()
            await options
        }
    }

    // ── Date preset chips (web date inputs, re-set as native presets) ──

    private var presetChips: some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(TradingAnalyticsPreset.allCases, id: \.rawValue) { p in
                        chip(p.label, active: !vm.useCustomRange && vm.preset == p) {
                            vm.useCustomRange = false
                            vm.preset = p
                            Task { await vm.load() }
                        }
                    }
                    chip("Custom", active: vm.useCustomRange) {
                        vm.useCustomRange.toggle()
                    }
                }
                .padding(.horizontal, 2)
            }
            // NP-6 (TR-05): custom start/end + min/max ROI — the web's exact query params.
            if vm.useCustomRange {
                HStack(spacing: 6) {
                    TextField("Start YYYY-MM-DD", text: Binding(get: { vm.customStart }, set: { vm.customStart = $0 }))
                    TextField("End YYYY-MM-DD", text: Binding(get: { vm.customEnd }, set: { vm.customEnd = $0 }))
                }
                .font(.caption)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.numbersAndPunctuation)
                HStack(spacing: 6) {
                    TextField("Min ROI %", text: Binding(get: { vm.minRoi }, set: { vm.minRoi = $0 }))
                    TextField("Max ROI %", text: Binding(get: { vm.maxRoi }, set: { vm.maxRoi = $0 }))
                    Button("Apply") {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        Task { await vm.load() }
                    }
                    .font(.caption.weight(.bold))
                    .buttonStyle(.bordered)
                    .disabled(vm.customStart.count != 10 || vm.customEnd.count != 10)
                }
                .font(.caption)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.decimalPad)
            }
        }
        .padding(.top, 4)
    }

    // ── Filter menus (web Selects: staff · account · status · profitability) ──

    private var filterMenus: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                menuChip(icon: "person", label: vm.staffId.flatMap { id in
                    vm.staffOptions.first(where: { $0.id == id })?.label
                } ?? "All staff", active: vm.staffId != nil) {
                    Button("All staff") { vm.staffId = nil; Task { await vm.load() } }
                    ForEach(vm.staffOptions) { s in
                        Button(s.label) { vm.staffId = s.id; Task { await vm.load() } }
                    }
                }
                menuChip(icon: "creditcard", label: vm.accountId.flatMap { id in
                    vm.accountOptions.first(where: { $0.id == id })?.label
                } ?? "All accounts", active: vm.accountId != nil) {
                    Button("All accounts") { vm.accountId = nil; Task { await vm.load() } }
                    ForEach(vm.accountOptions) { a in
                        Button(a.label) { vm.accountId = a.id; Task { await vm.load() } }
                    }
                }
                menuChip(icon: "circle.dashed", label: vm.status == "ALL" ? "All status" : vm.status.capitalized,
                         active: vm.status != "ALL") {
                    Button("All status") { vm.status = "ALL"; Task { await vm.load() } }
                    ForEach(TradingAnalyticsVM.statuses, id: \.self) { s in
                        Button(s.capitalized) { vm.status = s; Task { await vm.load() } }
                    }
                }
                menuChip(icon: "plusminus.circle",
                         label: vm.profitability == "ALL" ? "All P/L"
                              : vm.profitability == "PROFIT" ? "Profitable" : "Loss",
                         active: vm.profitability != "ALL") {
                    Button("All P/L") { vm.profitability = "ALL"; Task { await vm.load() } }
                    Button("Profitable") { vm.profitability = "PROFIT"; Task { await vm.load() } }
                    Button("Loss") { vm.profitability = "LOSS"; Task { await vm.load() } }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func menuChip(icon: String, label: String, active: Bool,
                          @ViewBuilder items: () -> some View) -> some View {
        Menu {
            items()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.caption)
                Text(label).font(.footnote.weight(active ? .semibold : .regular)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
            }
            .foregroundStyle(active ? TradingAnalyticsPalette.tradingGreen : .secondary)
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(active ? TradingAnalyticsPalette.tradingGreen.opacity(colorScheme == .dark ? 0.22 : 0.14)
                               : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                        in: Capsule())
            .overlay(Capsule().strokeBorder(
                active ? TradingAnalyticsPalette.tradingGreen.opacity(0.55)
                       : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                lineWidth: 1))
        }
    }

    private func chip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .lineLimit(1).minimumScaleFactor(0.5)
                .foregroundStyle(active ? TradingAnalyticsPalette.tradingGreen : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? TradingAnalyticsPalette.tradingGreen.opacity(colorScheme == .dark ? 0.25 : 0.15)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? TradingAnalyticsPalette.tradingGreen.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── KPI board (web's 11 KpiCards, re-set in the bento language: managed
    //    capital = the dark hero with today/weekly/monthly net split; the rest
    //    = glass tiles. Same numbers, same signed tints — presentation only.) ──

    private var kpiBoard: some View {
        let k = vm.data?.kpis
        return VStack(spacing: 10) {
            TradingAnalyticsHeroCard(
                capital: k.map { Int($0.totalManagedCapital.rounded()) },
                todayNet: k?.todayNet, weeklyNet: k?.weeklyNet, monthlyNet: k?.monthlyNet)
            HStack(spacing: 10) {
                statTile("USDT Volume", k?.totalUsdtVolume, sub: "মোট ভলিউম",
                         format: { TradingAnalyticsFormat.usdt($0) },
                         tint: .primary, accent: TradingAnalyticsPalette.tradingGold)
                statTile("Binance Fees", k?.totalBinanceFees, sub: "ফি খরচ",
                         format: { TradingAnalyticsFormat.taka($0) },
                         tint: colorScheme == .dark ? TradingAnalyticsPalette.amber500
                                                    : TradingAnalyticsPalette.amber600,
                         accent: TradingAnalyticsPalette.amber500)
            }
            HStack(spacing: 10) {
                statTile("Buy USDT", k?.totalBuyUsdt, sub: "কেনা",
                         format: { TradingAnalyticsFormat.usdt($0) },
                         tint: .primary, accent: TradingAnalyticsPalette.tradingGreen)
                statTile("Sell USDT", k?.totalSellUsdt, sub: "বেচা",
                         format: { TradingAnalyticsFormat.usdt($0) },
                         tint: .primary, accent: AlmaSwiftTheme.violet)
            }
            HStack(spacing: 10) {
                statTile("Op Expenses", k?.totalOperatingExpenses, sub: "অপারেটিং খরচ",
                         format: { TradingAnalyticsFormat.taka($0) },
                         tint: colorScheme == .dark ? TradingAnalyticsPalette.red400
                                                    : TradingAnalyticsPalette.red500,
                         accent: TradingAnalyticsPalette.red500)
                statTile("Merchants", k.map { Double($0.activeMerchantAccounts) }, sub: "অ্যাক্টিভ অ্যাকাউন্ট",
                         format: { "\(Int($0.rounded()))" },
                         tint: .primary, accent: TradingAnalyticsPalette.tradingGold)
                statTile("Staff", k.map { Double($0.activeStaffCount) }, sub: "অ্যাক্টিভ স্টাফ",
                         format: { "\(Int($0.rounded()))" },
                         tint: .primary, accent: TradingAnalyticsPalette.tradingGreen)
            }
        }
    }

    private func statTile(_ label: String, _ value: Double?, sub: String,
                          format: @escaping (Double) -> String,
                          tint: Color, accent: Color) -> some View {
        TradingAnalyticsStatTile(label: label,
                                 target: value.map { Int($0.rounded()) },
                                 format: { format(Double($0)) },
                                 sub: sub, tint: tint, accent: accent)
    }

    // ── Analytics Alerts (web tone-red card) ──

    @ViewBuilder private var alertsCard: some View {
        if let alerts = vm.data?.alerts, !alerts.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Analytics Alerts").font(.subheadline.weight(.bold))
                    .foregroundStyle(colorScheme == .dark ? TradingAnalyticsPalette.red400
                                                          : TradingAnalyticsPalette.red500)
                ForEach(alerts) { alert in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(alert.type) · \(alert.accountTitle)")
                            .font(.caption.weight(.bold))
                        Text(alert.message)
                            .font(.caption2)
                            .foregroundStyle(TradingAnalyticsPalette.red500)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color.white.opacity(colorScheme == .dark ? 0.04 : 0.35),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                        .strokeBorder(TradingAnalyticsPalette.red500.opacity(0.30), lineWidth: 1))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .tradingAnalyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                .strokeBorder(TradingAnalyticsPalette.red500.opacity(0.35), lineWidth: 1))
        }
    }

    // ── Trend charts (web MiniTrendChart ×3 — same series, same hex colours) ──

    private var trendCards: some View {
        let trend = vm.data?.trend ?? []
        return VStack(spacing: 10) {
            TradingAnalyticsTrendCard(title: "Profit Trend",
                                      values: trend.map(\.netBdt),
                                      labels: trend.map(\.date),
                                      color: TradingAnalyticsPalette.green400,   // web #4ade80
                                      unit: .taka)
            TradingAnalyticsTrendCard(title: "USDT Volume Trend",
                                      values: trend.map(\.usdtVolume),
                                      labels: trend.map(\.date),
                                      color: TradingAnalyticsPalette.tradingGold, // web #d6a94a
                                      unit: .usdt)
            TradingAnalyticsTrendCard(title: "Expense Trend",
                                      values: trend.map(\.expenseBdt),
                                      labels: trend.map(\.date),
                                      color: TradingAnalyticsPalette.red400,      // web #f87171
                                      unit: .taka)
        }
    }

    // ── Ranking cards (web RankingBars ×4 — signed green/red bars, top 8) ──

    private var rankingCards: some View {
        VStack(spacing: 10) {
            TradingAnalyticsRankingCard(
                title: "Top Profitable Accounts",
                rows: (vm.data?.topProfitableAccounts ?? []).map { ($0.accountTitle, $0.netProfit) },
                prefix: "৳", suffix: "")
            TradingAnalyticsRankingCard(
                title: "Top Loss Accounts",
                rows: (vm.data?.topLossAccounts ?? []).map { ($0.accountTitle, $0.netProfit) },
                prefix: "৳", suffix: "")
            TradingAnalyticsRankingCard(
                title: "Best Spread Performance",
                rows: (vm.data?.bestSpreadAccounts ?? []).map { ($0.accountTitle, $0.averageSpread) },
                prefix: "", suffix: " BDT")
            TradingAnalyticsRankingCard(
                title: "Highest Expense Accounts",
                rows: (vm.data?.highestExpenseAccounts ?? []).map { ($0.accountTitle, $0.totalExpenses) },
                prefix: "৳", suffix: "")
        }
    }

    // ── Staff Performance Analytics (web ranked list) ──

    private var staffCard: some View {
        let staff = vm.data?.staff ?? []
        return VStack(alignment: .leading, spacing: 12) {
            Text("Staff Performance Analytics").font(.subheadline.weight(.bold))
            if staff.isEmpty {
                emptyBlock("◇", "No staff analytics", "স্টাফ পারফরম্যান্স ডেটা নেই")
            } else {
                ForEach(Array(staff.enumerated()), id: \.element.id) { i, s in
                    staffRow(rank: i + 1, s: s)
                    if i < staff.count - 1 { Divider().opacity(0.35) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingAnalyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func staffRow(rank: Int, s: TradingAnalyticsStaffRow) -> some View {
        HStack(alignment: .top, spacing: 10) {
            // Rank badge — top three wear the trading green→violet gradient.
            Text("\(rank)")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(rank <= 3 ? .white : Color.secondary)
                .frame(width: 26, height: 26)
                .background(
                    rank <= 3
                        ? AnyShapeStyle(LinearGradient(
                            colors: [TradingAnalyticsPalette.tradingGreen, AlmaSwiftTheme.violet],
                            startPoint: .topLeading, endPoint: .bottomTrailing))
                        : AnyShapeStyle(Color.primary.opacity(0.06)),
                    in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(s.name).font(.footnote.weight(.semibold)).lineLimit(1)
                    Spacer()
                    Text(TradingAnalyticsFormat.pct(s.roiContribution) + " ROI")
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(TradingAnalyticsPalette.signed(s.roiContribution, colorScheme))
                }
                HStack(spacing: 8) {
                    Text("\(s.activeAccounts)/\(s.assignedAccounts) accounts")
                        .font(.caption2).foregroundStyle(.secondary)
                    Text(TradingAnalyticsFormat.usdt(s.totalTradedUsdt))
                        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    Spacer()
                    Text("৳" + TradingAnalyticsFormat.num(s.totalProfitGenerated))
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(TradingAnalyticsPalette.positive(colorScheme))
                    Text("৳" + TradingAnalyticsFormat.num(s.totalLossGenerated))
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(colorScheme == .dark ? TradingAnalyticsPalette.red400
                                                              : TradingAnalyticsPalette.red500)
                }
                Text(String(format: "%.1f%% fee efficiency", s.feeEfficiency))
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    // ── Merchant Account Intelligence (web rows, client-side search, top 20) ──

    private var accountIntelCard: some View {
        let rows = Array(vm.searchedRows.prefix(20))   // web .slice(0, 20)
        return VStack(alignment: .leading, spacing: 12) {
            Text("Merchant Account Intelligence").font(.subheadline.weight(.bold))
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search report rows...", text: $vm.search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(Color.white.opacity(colorScheme == .dark ? 0.06 : 0.4),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4), lineWidth: 1))
            if rows.isEmpty {
                emptyBlock("◇", "No account rows", "অ্যাকাউন্ট ডেটা নেই")
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                    accountIntelRow(row)
                    if i < rows.count - 1 { Divider().opacity(0.35) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingAnalyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func accountIntelRow(_ row: TradingAnalyticsAccountRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(row.accountTitle).font(.footnote.weight(.bold)).lineLimit(1)
                    Text(row.assignedUserName).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Text("৳" + TradingAnalyticsFormat.num(row.netProfit))
                    .font(.footnote.weight(.bold).monospacedDigit())
                    .foregroundStyle(TradingAnalyticsPalette.signed(row.netProfit, colorScheme))
            }
            HStack(spacing: 8) {
                statusPill(row.status)
                Text(String(format: "%.2f%% ROI", row.roi))
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                Text(String(format: "%.4f spread", row.averageSpread))
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                Text(String(format: "%.1f%% fees", row.feeRatio))
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                Spacer()
                Text(row.health.replacingOccurrences(of: "_", with: " "))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(TradingAnalyticsPalette.health(row.health, colorScheme))
            }
        }
        .padding(.vertical, 2)
    }

    private func statusPill(_ status: String) -> some View {
        let tint = TradingAnalyticsPalette.status(status, colorScheme)
        return Text(status)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
    }

    // ── Expense Intelligence (web red bar list, top 8) ──

    private var expenseIntelCard: some View {
        let cats = Array((vm.data?.expenseCategories ?? []).prefix(8))   // web .slice(0, 8)
        let maxAmount = vm.maxExpenseCategory
        return VStack(alignment: .leading, spacing: 12) {
            Text("Expense Intelligence").font(.subheadline.weight(.bold))
            if cats.isEmpty {
                emptyBlock("◇", "No expenses", "এই রেঞ্জে খরচ নেই")
            } else {
                ForEach(cats) { cat in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(cat.type).font(.caption.weight(.semibold))
                            Spacer()
                            Text("৳" + TradingAnalyticsFormat.num(cat.amount))
                                .font(.caption.weight(.bold).monospacedDigit())
                                .foregroundStyle(TradingAnalyticsPalette.red500)
                        }
                        // Web: width = max(4%, amount/max ×100), red-400 fill.
                        hBar(fraction: max(0.04, cat.amount / maxAmount),
                             color: TradingAnalyticsPalette.red400)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingAnalyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Shared bits ──

    private func hBar(fraction: Double, color: Color, height: CGFloat = 6) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.07))
                Capsule()
                    .fill(LinearGradient(colors: [color.opacity(0.85), color],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(geo.size.width * min(max(fraction, 0), 1), fraction > 0 ? 3 : 0))
            }
        }
        .frame(height: height)
    }

    private func emptyBlock(_ glyph: String, _ title: String, _ desc: String) -> some View {
        VStack(spacing: 4) {
            Text(glyph).font(.title2).foregroundStyle(.secondary)
            Text(title).font(.footnote.weight(.semibold))
            Text(desc).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 26)
    }

    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(TradingAnalyticsPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).tradingAnalyticsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .tradingAnalyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 110)
                .tradingAnalyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .tradingAnalyticsShimmer()
        }
    }

    /// NP-6 (TR-05): native CSV + PDF export via share sheet (web columns verbatim:
    /// Account · Staff · Status · Health · Net Profit BDT · ROI %). CSV opens in
    /// Excel/Numbers — the web's XLSX carries the same columns (FN-04 resolution).
    private var webEscape: some View {
        HStack(spacing: 8) {
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                exportShare(csv: true)
            } label: {
                Text("📄 CSV").font(.caption.weight(.bold))
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .background(TradingAnalyticsPalette.tradingGreen.opacity(0.13), in: Capsule())
                    .foregroundStyle(TradingAnalyticsPalette.tradingGreen)
            }
            .buttonStyle(.plain)
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                exportShare(csv: false)
            } label: {
                Text("🧾 PDF").font(.caption.weight(.bold))
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .background(TradingAnalyticsPalette.tradingGreen.opacity(0.13), in: Capsule())
                    .foregroundStyle(TradingAnalyticsPalette.tradingGreen)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 6)
    }

    private func exportShare(csv: Bool) {
        let rows = vm.searchedRows
        guard !rows.isEmpty else { return }
        let url: URL
        if csv {
            var text = "Account,Staff,Status,Health,Net Profit BDT,ROI %\n"
            for r in rows {
                let cells = [r.accountTitle, r.assignedUserName, r.status, r.health,
                             String(Int(r.netProfit.rounded())), String(format: "%.2f", r.roi)]
                text += cells.map { "\"\($0.replacingOccurrences(of: "\"", with: "\"\""))\"" }
                    .joined(separator: ",") + "\n"
            }
            url = FileManager.default.temporaryDirectory.appendingPathComponent("alma-trading-analytics.csv")
            try? text.data(using: .utf8)?.write(to: url, options: .atomic)
        } else {
            // Simple A4 PDF: title + KPIs + report rows (web exportPdf content parity).
            let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 595, height: 842))
            url = FileManager.default.temporaryDirectory.appendingPathComponent("alma-trading-analytics.pdf")
            try? renderer.writePDF(to: url) { ctx in
                ctx.beginPage()
                var y: CGFloat = 32
                func draw(_ text: String, size: CGFloat, bold: Bool = false) {
                    let font = bold ? UIFont.boldSystemFont(ofSize: size) : UIFont.systemFont(ofSize: size)
                    (text as NSString).draw(at: CGPoint(x: 32, y: y), withAttributes: [.font: font])
                    y += size + 8
                    if y > 800 { ctx.beginPage(); y = 32 }
                }
                draw("Alma Trading Analytics Report", size: 18, bold: true)
                if let k = vm.data?.kpis {
                    draw("Managed capital: BDT \(Int(k.totalManagedCapital.rounded()).formatted()) · Monthly net: BDT \(Int(k.monthlyNet.rounded()).formatted())", size: 10)
                }
                y += 6
                for r in rows.prefix(40) {
                    draw("\(r.accountTitle) — \(r.assignedUserName) · \(r.status) · \(r.health) · Net BDT \(Int(r.netProfit.rounded()).formatted()) · ROI \(String(format: "%.2f", r.roi))%", size: 9)
                }
            }
        }
        let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        var top = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        top?.present(av, animated: true)
    }
}

// MARK: - Trend line card (native re-set of the web MiniTrendChart SVG polyline)

private enum TradingAnalyticsUnit { case taka, usdt }

@available(iOS 17.0, *)
private struct TradingAnalyticsTrendCard: View {
    let title: String
    let values: [Double]
    let labels: [String]      // yyyy-MM-dd per day
    let color: Color
    let unit: TradingAnalyticsUnit
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.subheadline.weight(.bold))
                Spacer()
                if let last = values.last {
                    Text(format(last))
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(color)
                }
            }
            if values.isEmpty {
                Text("No trend data")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 34)
            } else {
                chart
                    .frame(height: 120)
                    .padding(.top, 8)
                if let first = labels.first, let lastLabel = labels.last {
                    HStack {
                        Text(TradingAnalyticsFormat.dayShort(first))
                        Spacer()
                        Text(TradingAnalyticsFormat.dayShort(lastLabel))
                    }
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingAnalyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    /// Same maths as the web SVG: min = min(0, …values), max = max(1, …values),
    /// y = 90% − ((v − min) / span) × 80%, baseline at 90%.
    private var chart: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let minV = min(0, values.min() ?? 0)
            let maxV = max(1, values.max() ?? 1)
            let span = (maxV - minV) == 0 ? 1 : (maxV - minV)
            let pts: [CGPoint] = values.enumerated().map { i, v in
                let x = values.count <= 1 ? 0 : CGFloat(i) / CGFloat(values.count - 1) * w
                let y = h * 0.9 - CGFloat((v - minV) / span) * h * 0.8
                return CGPoint(x: x, y: y)
            }
            ZStack {
                // Baseline (web: line at y=90, rgba(0,0,0,.06)).
                Path { p in
                    p.move(to: CGPoint(x: 0, y: h * 0.9))
                    p.addLine(to: CGPoint(x: w, y: h * 0.9))
                }
                .stroke(Color.primary.opacity(0.08), lineWidth: 1)
                // Soft area fill under the line — native flourish, same series colour.
                if pts.count > 1 {
                    Path { p in
                        p.move(to: CGPoint(x: pts[0].x, y: h * 0.9))
                        p.addLine(to: pts[0])
                        for pt in pts.dropFirst() { p.addLine(to: pt) }
                        p.addLine(to: CGPoint(x: pts[pts.count - 1].x, y: h * 0.9))
                        p.closeSubpath()
                    }
                    .fill(LinearGradient(colors: [color.opacity(0.22), color.opacity(0.02)],
                                         startPoint: .top, endPoint: .bottom))
                }
                // The polyline (web strokeWidth 2.5, round caps/joins).
                Path { p in
                    guard let first = pts.first else { return }
                    p.move(to: first)
                    for pt in pts.dropFirst() { p.addLine(to: pt) }
                }
                .stroke(color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                // Point dots (web r=1.8 circles) — thin out on long ranges.
                let step = max(1, pts.count / 30)
                ForEach(Array(pts.enumerated()), id: \.offset) { i, pt in
                    if i % step == 0 || i == pts.count - 1 {
                        Circle().fill(color).frame(width: 4, height: 4).position(pt)
                    }
                }
            }
        }
    }

    private func format(_ v: Double) -> String {
        switch unit {
        case .taka: return TradingAnalyticsFormat.taka(v)
        case .usdt: return TradingAnalyticsFormat.usdt(v)
        }
    }
}

// MARK: - Ranking bars card (native re-set of the web RankingBars — top 8,
// signed green/red fills over the muted track)

@available(iOS 17.0, *)
private struct TradingAnalyticsRankingCard: View {
    let title: String
    let rows: [(label: String, value: Double)]
    let prefix: String
    let suffix: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let shown = Array(rows.prefix(8))                                   // web .slice(0, 8)
        let maxAbs = max(1, shown.map { abs($0.value) }.max() ?? 1)         // web Math.max(1, …)
        return VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.subheadline.weight(.bold))
            if shown.isEmpty {
                Text("No data")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 22)
            } else {
                ForEach(Array(shown.enumerated()), id: \.offset) { _, row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(row.label).font(.caption.weight(.bold)).lineLimit(1)
                            Spacer()
                            Text(prefix + TradingAnalyticsFormat.num2(row.value) + suffix)
                                .font(.caption.weight(.heavy).monospacedDigit())
                                .foregroundStyle(TradingAnalyticsPalette.signed(row.value, colorScheme))
                        }
                        bar(fraction: max(0.04, abs(row.value) / maxAbs),   // web max(4, …)%
                            positive: row.value >= 0)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingAnalyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func bar(fraction: Double, positive: Bool) -> some View {
        let color = positive ? TradingAnalyticsPalette.green400 : TradingAnalyticsPalette.red400
        return GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.07))
                Capsule()
                    .fill(LinearGradient(colors: [color.opacity(0.85), color],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: geo.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(height: 8)
    }
}

// MARK: - Formatting helpers

private enum TradingAnalyticsFormat {
    /// Whole-taka short money (৳1.2L style via the shared theme helper).
    static func taka(_ v: Double) -> String {
        let i = Int(v.rounded())
        return i < 0 ? "-" + AlmaSwiftTheme.takaShort(abs(i)) : AlmaSwiftTheme.takaShort(i)
    }
    /// USDT amounts — whole numbers with a suffix (web toLocaleString + USDT).
    static func usdt(_ v: Double) -> String {
        "\(Int(v.rounded()).formatted()) USDT"
    }
    /// Full signed number, no decimals (web toLocaleString('en-BD')).
    static func num(_ v: Double) -> String {
        Int(v.rounded()).formatted()
    }
    /// Web RankingBars value: up to 2 fraction digits.
    static func num2(_ v: Double) -> String {
        v.formatted(.number.precision(.fractionLength(0...2)))
    }
    /// Signed percent with 2 decimals (web roiContribution.toFixed(2) + '%').
    static func pct(_ v: Double) -> String {
        String(format: "%.2f%%", v)
    }
    /// "2026-07-03" → "3 Jul".
    static func dayShort(_ ymd: String) -> String {
        let parts = ymd.prefix(10).split(separator: "-")
        guard parts.count >= 3, let m = Int(parts[1]), let d = Int(parts[2]),
              (1...12).contains(m) else { return ymd }
        let names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "\(d) \(names[m - 1])"
    }
}

// MARK: - Bento components (TradingAnalytics-owned copies of the Dashboard board
// language — per-file copies are this repo's parallel-session convention)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func tradingAnalyticsMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct TradingAnalyticsCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        TradingAnalyticsCountUpText(value: shown, format: format)
            .animation(tradingAnalyticsMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if tradingAnalyticsMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct TradingAnalyticsCountUpText: View, Animatable {
    var value: Double
    var format: (Int) -> String
    var animatableData: Double {
        get { value }
        set { value = newValue }
    }
    var body: some View {
        Text(format(Int(value.rounded())))
    }
}

/// Shared tile backdrop: frosted glass + a soft diagonal accent wash.
@available(iOS 17.0, *)
private func tradingAnalyticsBentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
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
/// `target == nil` renders the "—" placeholder (data not loaded yet).
@available(iOS 17.0, *)
private struct TradingAnalyticsStatTile: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let target: Int?
    let format: (Int) -> String
    let sub: String
    let tint: Color
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.75)
            if let target {
                TradingAnalyticsCountUp(target: target, format: format)
                    .font(.system(size: 17, weight: .heavy)).monospacedDigit()
                    .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.55)
            } else {
                Text("—").font(.system(size: 17, weight: .heavy)).foregroundStyle(tint)
            }
            Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background { tradingAnalyticsBentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero
/// recipe), tinted with the TRADING GREEN accent instead of coral. Managed-capital
/// count-up plus the Today / Weekly / Monthly net split with signed tints.
@available(iOS 17.0, *)
private struct TradingAnalyticsHeroCard: View {
    let capital: Int?
    let todayNet: Double?
    let weeklyNet: Double?
    let monthlyNet: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("ম্যানেজড ক্যাপিটাল · ALMA TRADING").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(TradingAnalyticsPalette.tradingGreen)
            Group {
                if let capital {
                    TradingAnalyticsCountUp(target: capital, format: { AlmaSwiftTheme.takaShort($0) })
                } else {
                    Text("—")
                }
            }
            .font(.system(size: 40, weight: .heavy)).monospacedDigit()
            .foregroundStyle(.white)
            .lineLimit(1).minimumScaleFactor(0.6)
            .padding(.top, 8)
            Text("সব মার্চেন্ট অ্যাকাউন্টের মোট মূলধন")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Today net", value: todayNet, sub: "আজ")
                heroDivider
                heroStat(label: "Weekly net", value: weeklyNet, sub: "৭ দিন")
                heroDivider
                heroStat(label: "Monthly net", value: monthlyNet, sub: "৩০ দিন")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.075, green: 0.125, blue: 0.110))   // deep trading green base
                LinearGradient(colors: [TradingAnalyticsPalette.tradingGreen.opacity(0.34), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.22), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [TradingAnalyticsPalette.tradingGold.opacity(0.16), .clear],
                               center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 220)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(.white.opacity(0.16), lineWidth: 1))
        // Always the board's dark anchor — force dark traits inside the card.
        .environment(\.colorScheme, .dark)
    }

    private var heroDivider: some View {
        Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
            .padding(.vertical, 2).padding(.horizontal, 12)
    }

    private func heroStat(label: String, value: Double?, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            Group {
                if let value {
                    TradingAnalyticsCountUp(target: Int(value.rounded()),
                                            format: { TradingAnalyticsFormat.taka(Double($0)) })
                } else {
                    Text("—")
                }
            }
            .font(.system(size: 17, weight: .heavy)).monospacedDigit()
            // Web signedClass on the dark hero: green-400 / red-400.
            .foregroundStyle((value ?? 0) >= 0 ? TradingAnalyticsPalette.green400
                                               : TradingAnalyticsPalette.red400)
            .lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Aurora background + glass (TradingAnalytics-owned copies —
// parallel-session rule: page files never import another page's helpers, so the
// shared look is duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct TradingAnalyticsAurora: View {
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
    func tradingAnalyticsGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct TradingAnalyticsShimmer: ViewModifier {
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
    func tradingAnalyticsShimmer() -> some View { modifier(TradingAnalyticsShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Trading Analytics — Light") {
    TradingAnalyticsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
