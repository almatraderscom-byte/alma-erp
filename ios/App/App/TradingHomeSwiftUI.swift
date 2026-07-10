//
//  TradingHomeSwiftUI.swift
//  ALMA ERP — the Trading dashboard as a native SwiftUI screen (web /trading parity).
//
//  Mirrors the web /trading page — same endpoints, same colours, same blocks:
//    GET /api/trading/dashboard                → kpis · accountPerformance · alerts ·
//                                                screenshotCompliance · latestTrades/Expenses
//    GET /api/trading/summary                  → business kpis + period ranges
//    GET /api/trading/accounts?status=ACTIVE   → active account list (web sends only status;
//                                                empty search is dropped by apiGet)
//  Web-parity blocks: bento hero (current balance + today net/profit/loss split) ·
//  business KPI tiles (active accounts / capital / trade volume / USDT / fees / expenses) ·
//  screenshot-compliance amber strip (only when due/overdue > 0) · My accounts list
//  (MyTradingAccounts parity: title, UID, balance gold, daily P/L signed, compliance badge)
//  · Action-required alerts · period snapshots (today/yesterday/last7) · latest trades +
//  expenses. ALL mutations (trade entry, expense, bKash summary, screenshot upload) stay on
//  the web escape hatch — this screen is read-only. Hero accent = the trading business
//  switcher green (sage #81B29A). Carried lessons: lenient row decoding, ONE spinner
//  pattern (shimmer skeletons), no global overlays.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum TradingHomePalette {
    static let sage = Color(red: 0.51, green: 0.70, blue: 0.60)               // trading accent green (#82B399)
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)          // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)         // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)          // #EF4444
    static let red400 = Color(red: 0.973, green: 0.443, blue: 0.443)          // #F87171
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)        // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)        // #F59E0B
    static let orange500 = Color(red: 0.976, green: 0.451, blue: 0.086)       // #F97316
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)      // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)        // #4ADE80
    static let blue400 = Color(red: 0.376, green: 0.647, blue: 0.980)         // #60A5FA
    static let blue500 = Color(red: 0.231, green: 0.510, blue: 0.965)         // #3B82F6
    static let slate400 = Color(red: 0.580, green: 0.639, blue: 0.722)        // #94A3B8

    /// The web's gold-tinted money reads gold-dim on cream, gold-lt over dark aurora.
    static func gold(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Web signedClass: >= 0 green-400 · else red-400 (light gets the darker pair).
    static func signed(_ value: Int, _ scheme: ColorScheme) -> Color {
        value >= 0 ? (scheme == .dark ? green400 : emerald600) : red400
    }

    /// Web HealthBadge: PROFITABLE green · STABLE blue · RISK amber · LOSS red.
    static func health(_ h: String?, _ scheme: ColorScheme) -> Color {
        switch h {
        case "PROFITABLE": return scheme == .dark ? green400 : emerald600
        case "STABLE": return scheme == .dark ? blue400 : blue500
        case "RISK": return scheme == .dark ? amber500 : amber600
        case "LOSS": return red500
        default: return slate400
        }
    }

    /// Web alertTone: CRITICAL red · HIGH orange · MEDIUM amber · LOW blue.
    static func alert(_ severity: String?, _ scheme: ColorScheme) -> Color {
        switch severity {
        case "CRITICAL": return red500
        case "HIGH": return orange500
        case "MEDIUM": return scheme == .dark ? amber500 : amber600
        default: return scheme == .dark ? blue400 : blue500
        }
    }
}

// MARK: - Lenient decode helpers (Prisma decimals arrive as numbers OR strings)

private extension KeyedDecodingContainer {
    func tradingHomeInt(_ key: Key) -> Int? {
        if let i = try? decodeIfPresent(Int.self, forKey: key) { return i }
        if let d = try? decodeIfPresent(Double.self, forKey: key) { return Int(d.rounded()) }
        if let s = try? decodeIfPresent(String.self, forKey: key) { return Double(s).map { Int($0.rounded()) } }
        return nil
    }
    func tradingHomeDouble(_ key: Key) -> Double? {
        if let d = try? decodeIfPresent(Double.self, forKey: key) { return d }
        if let i = try? decodeIfPresent(Int.self, forKey: key) { return Double(i) }
        if let s = try? decodeIfPresent(String.self, forKey: key) { return Double(s) }
        return nil
    }
}

// MARK: - Models (same field names the web TradingDashboardResponse & co. declare —
// camelCase wire, ALL fields optional so one bad row can't kill the screen)

private struct TradingHomeDashKpis: Decodable {
    let activeAccounts: Int?
    let todayTradeCount: Int?
    let todayProfit: Int?
    let todayLoss: Int?
    let netTodayResult: Int?
    let totalCapital: Int?
    let currentBalance: Int?
    let totalExpenses: Int?
    let totalTradeVolume: Int?
    let totalUsdtVolume: Double?
    let activeStaffCount: Int?

    private enum Keys: String, CodingKey {
        case activeAccounts, todayTradeCount, todayProfit, todayLoss, netTodayResult
        case totalCapital, currentBalance, totalExpenses, totalTradeVolume
        case totalUsdtVolume, activeStaffCount
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        activeAccounts = c.tradingHomeInt(.activeAccounts)
        todayTradeCount = c.tradingHomeInt(.todayTradeCount)
        todayProfit = c.tradingHomeInt(.todayProfit)
        todayLoss = c.tradingHomeInt(.todayLoss)
        netTodayResult = c.tradingHomeInt(.netTodayResult)
        totalCapital = c.tradingHomeInt(.totalCapital)
        currentBalance = c.tradingHomeInt(.currentBalance)
        totalExpenses = c.tradingHomeInt(.totalExpenses)
        totalTradeVolume = c.tradingHomeInt(.totalTradeVolume)
        totalUsdtVolume = c.tradingHomeDouble(.totalUsdtVolume)
        activeStaffCount = c.tradingHomeInt(.activeStaffCount)
    }
}

private struct TradingHomeCompliance: Decodable {
    let cutoffHourBd: Int?
    let pastCutoff: Bool?
    let completeCount: Int?
    let dueCount: Int?
    let overdueCount: Int?
}

private struct TradingHomePerfRow: Decodable, Identifiable {
    let id: String
    let accountTitle: String?
    let currentBalance: Int?
    let dailyPl: Int?
    let health: String?
    let screenshotToday: Bool?
    let screenshotCompliance: String?

    private enum Keys: String, CodingKey {
        case id, accountTitle, currentBalance, dailyPl, health
        case screenshotToday, screenshotCompliance
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        accountTitle = try? c.decodeIfPresent(String.self, forKey: .accountTitle)
        currentBalance = c.tradingHomeInt(.currentBalance)
        dailyPl = c.tradingHomeInt(.dailyPl)
        health = try? c.decodeIfPresent(String.self, forKey: .health)
        screenshotToday = try? c.decodeIfPresent(Bool.self, forKey: .screenshotToday)
        screenshotCompliance = try? c.decodeIfPresent(String.self, forKey: .screenshotCompliance)
    }
}

private struct TradingHomeAlert: Decodable, Identifiable {
    let key: String
    let severity: String?
    let title: String?
    let message: String?
    let accountTitle: String?
    let actionUrl: String?
    var id: String { key }

    private enum Keys: String, CodingKey { case key, severity, title, message, accountTitle, actionUrl }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        key = (try? c.decode(String.self, forKey: .key)) ?? UUID().uuidString
        severity = try? c.decodeIfPresent(String.self, forKey: .severity)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        message = try? c.decodeIfPresent(String.self, forKey: .message)
        accountTitle = try? c.decodeIfPresent(String.self, forKey: .accountTitle)
        actionUrl = try? c.decodeIfPresent(String.self, forKey: .actionUrl)
    }
}

private struct TradingHomeAccountRef: Decodable { let accountTitle: String? }
private struct TradingHomeUserRef: Decodable { let name: String? }

private struct TradingHomeTrade: Decodable, Identifiable {
    let id: String
    let tradingAccountId: String?
    let tradeType: String?
    let usdtAmount: Double?
    let netProfit: Int?
    let accountTitle: String?
    let userName: String?

    private enum Keys: String, CodingKey {
        case id, tradingAccountId, tradeType, usdtAmount, netProfit, tradingAccount, user
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        tradingAccountId = try? c.decodeIfPresent(String.self, forKey: .tradingAccountId)
        tradeType = try? c.decodeIfPresent(String.self, forKey: .tradeType)
        usdtAmount = c.tradingHomeDouble(.usdtAmount)
        netProfit = c.tradingHomeInt(.netProfit)
        accountTitle = (try? c.decodeIfPresent(TradingHomeAccountRef.self, forKey: .tradingAccount))?.accountTitle
        userName = (try? c.decodeIfPresent(TradingHomeUserRef.self, forKey: .user))?.name
    }
}

private struct TradingHomeExpense: Decodable, Identifiable {
    let id: String
    let tradingAccountId: String?
    let expenseType: String?
    let amount: Int?
    let accountTitle: String?

    private enum Keys: String, CodingKey { case id, tradingAccountId, expenseType, amount, tradingAccount }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        tradingAccountId = try? c.decodeIfPresent(String.self, forKey: .tradingAccountId)
        expenseType = try? c.decodeIfPresent(String.self, forKey: .expenseType)
        amount = c.tradingHomeInt(.amount)
        accountTitle = (try? c.decodeIfPresent(TradingHomeAccountRef.self, forKey: .tradingAccount))?.accountTitle
    }
}

/// GET /api/trading/dashboard — flat payload; tolerate an `{ ok, data: {…} }` wrap
/// too, like the CRM decoder does.
private struct TradingHomeDashboard: Decodable {
    let kpis: TradingHomeDashKpis?
    let screenshotCompliance: TradingHomeCompliance?
    let accountPerformance: [TradingHomePerfRow]
    let alerts: [TradingHomeAlert]
    let latestTrades: [TradingHomeTrade]
    let latestExpenses: [TradingHomeExpense]

    private enum Keys: String, CodingKey {
        case ok, data, kpis, screenshotCompliance, accountPerformance, alerts
        case latestTrades, latestExpenses
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        kpis = try? c.decodeIfPresent(TradingHomeDashKpis.self, forKey: .kpis)
        screenshotCompliance = try? c.decodeIfPresent(TradingHomeCompliance.self, forKey: .screenshotCompliance)
        accountPerformance = (try? c.decodeIfPresent([TradingHomePerfRow].self, forKey: .accountPerformance)) ?? []
        alerts = (try? c.decodeIfPresent([TradingHomeAlert].self, forKey: .alerts)) ?? []
        latestTrades = (try? c.decodeIfPresent([TradingHomeTrade].self, forKey: .latestTrades)) ?? []
        latestExpenses = (try? c.decodeIfPresent([TradingHomeExpense].self, forKey: .latestExpenses)) ?? []
    }
}

private struct TradingHomeRange: Decodable {
    let netResultBdt: Int?

    private enum Keys: String, CodingKey { case netResultBdt, netResult }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        netResultBdt = c.tradingHomeInt(.netResultBdt) ?? c.tradingHomeInt(.netResult)
    }
}

private struct TradingHomeSummaryKpis: Decodable {
    let activeAccounts: Int?
    let totalCapital: Int?
    let totalFees: Int?
    let totalOperatingExpenses: Int?
    let totalTradedUsdt: Double?

    private enum Keys: String, CodingKey {
        case activeAccounts, totalCapital, totalFees, totalOperatingExpenses, totalTradedUsdt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        activeAccounts = c.tradingHomeInt(.activeAccounts)
        totalCapital = c.tradingHomeInt(.totalCapital)
        totalFees = c.tradingHomeInt(.totalFees)
        totalOperatingExpenses = c.tradingHomeInt(.totalOperatingExpenses)
        totalTradedUsdt = c.tradingHomeDouble(.totalTradedUsdt)
    }
}

/// GET /api/trading/summary → { kpis, ranges: { today, yesterday, last7, currentMonth } }.
private struct TradingHomeSummary: Decodable {
    let kpis: TradingHomeSummaryKpis?
    let today: TradingHomeRange?
    let yesterday: TradingHomeRange?
    let last7: TradingHomeRange?

    private enum Keys: String, CodingKey { case ok, data, kpis, ranges, today, yesterday, last7 }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        kpis = try? c.decodeIfPresent(TradingHomeSummaryKpis.self, forKey: .kpis)
        let r = try? c.nestedContainer(keyedBy: Keys.self, forKey: .ranges)
        today = try? r?.decodeIfPresent(TradingHomeRange.self, forKey: .today)
        yesterday = try? r?.decodeIfPresent(TradingHomeRange.self, forKey: .yesterday)
        last7 = try? r?.decodeIfPresent(TradingHomeRange.self, forKey: .last7)
    }
}

private struct TradingHomeAccount: Decodable, Identifiable {
    let id: String
    let accountTitle: String
    let binanceUid: String?
    let accountType: String?
    let status: String?
    let startingCapital: Int?
    let currentBalance: Int?

    private enum Keys: String, CodingKey {
        case id, accountTitle, binanceUid, accountType, status, startingCapital, currentBalance
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        accountTitle = (try? c.decode(String.self, forKey: .accountTitle)) ?? "Trading account"
        binanceUid = try? c.decodeIfPresent(String.self, forKey: .binanceUid)
        accountType = try? c.decodeIfPresent(String.self, forKey: .accountType)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        startingCapital = c.tradingHomeInt(.startingCapital)
        currentBalance = c.tradingHomeInt(.currentBalance)
    }
}

/// GET /api/trading/accounts answers flat `{ accounts, total }`; tolerate a wrap too.
private struct TradingHomeAccountsResponse: Decodable {
    let accounts: [TradingHomeAccount]

    private enum Keys: String, CodingKey { case ok, data, accounts }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        accounts = (try? c.decode([TradingHomeAccount].self, forKey: .accounts)) ?? []
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
private final class TradingHomeVM {
    var dash: TradingHomeDashboard? = nil
    var summary: TradingHomeSummary? = nil
    var accounts: [TradingHomeAccount] = []
    var loading = false
    var error: String? = nil
    var authExpired = false

    var perfById: [String: TradingHomePerfRow] {
        Dictionary(uniqueKeysWithValues: (dash?.accountPerformance ?? []).map { ($0.id, $0) })
    }

    var complianceNeedsAttention: Bool {
        let c = dash?.screenshotCompliance
        return ((c?.overdueCount ?? 0) + (c?.dueCount ?? 0)) > 0
    }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            // Same three calls the web page fires (useTradingDashboard / useTradingSummary /
            // useTradingAccounts({status:'ACTIVE'})) — empty search is dropped by the web
            // apiGet, so only status travels.
            async let d: TradingHomeDashboard = AlmaAPI.shared.get("/api/trading/dashboard")
            async let s: TradingHomeSummary = AlmaAPI.shared.get("/api/trading/summary")
            async let a: TradingHomeAccountsResponse = AlmaAPI.shared.get(
                "/api/trading/accounts", query: ["status": "ACTIVE"])
            let (dr, sr, ar) = try await (d, s, a)
            dash = dr
            summary = sr
            accounts = ar.accounts
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

// MARK: - Formatting helpers

private enum TradingHomeFormat {
    static func taka(_ v: Int) -> String { "৳\(v.formatted())" }

    /// USDT volumes wear the web money() short scale: 1.2M / 34.5K / 960.
    static func usdtShort(_ v: Double) -> String {
        let a = abs(v), sign = v < 0 ? "-" : ""
        if a >= 1_000_000 { return "\(sign)\(String(format: "%.2f", a / 1_000_000))M" }
        if a >= 1_000 { return "\(sign)\(String(format: "%.1f", a / 1_000))K" }
        return "\(sign)\(String(format: "%.0f", a))"
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct TradingHomeScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = TradingHomeVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.dash == nil && vm.accounts.isEmpty {
                    loadingRows
                } else {
                    kpiBoard
                    quickNav
                    if vm.complianceNeedsAttention { complianceStrip }
                    accountsCard
                    if !(vm.dash?.alerts.isEmpty ?? true) { alertsCard }
                    snapshotsCard
                    recentActivity
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(TradingHomeAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    // ── KPI board (web: Today net / Current balance / Today profit / Today loss +
    //    admin business row) — bento language: current balance = the dark hero anchor
    //    with today net/profit/loss split, business KPIs = accent tiles. ──

    private var kpiBoard: some View {
        let k = vm.dash?.kpis
        let bk = vm.summary?.kpis
        return VStack(spacing: 10) {
            TradingHomeHeroCard(balance: k?.currentBalance,
                                todayNet: k?.netTodayResult,
                                todayProfit: k?.todayProfit,
                                todayLoss: k?.todayLoss)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10),
                                GridItem(.flexible(), spacing: 10)], spacing: 10) {
                TradingHomeBentoStatTile(label: "Active accounts",
                                         target: k?.activeAccounts ?? bk?.activeAccounts,
                                         format: { "\($0)" }, sub: "চালু অ্যাকাউন্ট",
                                         tint: TradingHomePalette.sage,
                                         accent: TradingHomePalette.sage)
                TradingHomeBentoStatTile(label: "Total capital",
                                         target: k?.totalCapital ?? bk?.totalCapital,
                                         format: { AlmaSwiftTheme.takaShort($0) }, sub: "মোট মূলধন",
                                         tint: TradingHomePalette.gold(colorScheme),
                                         accent: AlmaSwiftTheme.coral)
                TradingHomeBentoStatTile(label: "Trade volume",
                                         target: k?.totalTradeVolume,
                                         format: { AlmaSwiftTheme.takaShort($0) }, sub: "মোট ট্রেড ভলিউম",
                                         tint: TradingHomePalette.blue400,
                                         accent: TradingHomePalette.blue400)
                TradingHomeBentoStatTile(label: "USDT volume",
                                         target: (k?.totalUsdtVolume ?? bk?.totalTradedUsdt).map { Int($0.rounded()) },
                                         format: { "\(TradingHomeFormat.usdtShort(Double($0))) USDT" },
                                         sub: "মোট USDT",
                                         tint: AlmaSwiftTheme.violet,
                                         accent: AlmaSwiftTheme.violet)
                TradingHomeBentoStatTile(label: "Total fees",
                                         target: bk?.totalFees,
                                         format: { AlmaSwiftTheme.takaShort($0) }, sub: "বাইন্যান্স ফি",
                                         tint: TradingHomePalette.amber500,
                                         accent: TradingHomePalette.amber500)
                TradingHomeBentoStatTile(label: "Total expenses",
                                         target: k?.totalExpenses ?? bk?.totalOperatingExpenses,
                                         format: { AlmaSwiftTheme.takaShort($0) }, sub: "অপারেটিং খরচ",
                                         tint: TradingHomePalette.red400,
                                         accent: TradingHomePalette.red500)
            }
        }
        .padding(.top, 4)
    }

    // ── Screenshot compliance strip (web amber tone card — shown only when the
    //    due/overdue counts demand attention, per native scope) ──

    private var complianceStrip: some View {
        let c = vm.dash?.screenshotCompliance
        let cutoff = (c?.pastCutoff ?? false)
            ? "cutoff passed" : "cutoff \(c?.cutoffHourBd ?? 0):00 BD"
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: "camera.badge.clock")
                .foregroundStyle(TradingHomePalette.amber500)
            VStack(alignment: .leading, spacing: 2) {
                Text("Screenshot compliance").font(.footnote.weight(.bold))
                Text("\(c?.completeCount ?? 0) complete · \(c?.dueCount ?? 0) due · \(c?.overdueCount ?? 0) overdue · \(cutoff)")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .fill(.ultraThinMaterial)
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .fill(TradingHomePalette.amber500.opacity(colorScheme == .dark ? 0.14 : 0.10))
            }
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(TradingHomePalette.amber500.opacity(0.35), lineWidth: 1))
    }

    // ── My accounts (web MyTradingAccounts parity — read-only rows, tap opens the
    //    web account page; trade/screenshot/summary actions stay on the web) ──

    private var accountsCard: some View {
        TradingHomeSectionCard(title: "My accounts",
                               sub: "ডেইলি অপস · অ্যাকাউন্ট-প্রতি স্ক্রিনশট স্ট্যাটাস",
                               trailing: "View all",
                               onTrailing: { openWeb("/trading/accounts", "Accounts") }) {
            if vm.accounts.isEmpty {
                emptyLine("কোনো অ্যাকটিভ অ্যাকাউন্ট নেই")
            } else {
                ForEach(Array(vm.accounts.prefix(12).enumerated()), id: \.element.id) { idx, account in
                    if idx > 0 { tradingHomeDivider }
                    TradingHomeAccountRow(account: account, perf: vm.perfById[account.id]) {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        openWeb("/trading/accounts/\(account.id)", account.accountTitle)
                    }
                }
            }
        }
    }

    // ── Action required (web AlertsPanel — read-only; CTA = the web page) ──

    private var alertsCard: some View {
        let alerts = vm.dash?.alerts ?? []
        return TradingHomeSectionCard(title: "Action required",
                                      sub: "ফিক্স করতে ওয়েবে খুলুন",
                                      trailing: "\(alerts.count)",
                                      onTrailing: nil) {
            ForEach(Array(alerts.prefix(8).enumerated()), id: \.element.id) { idx, alert in
                if idx > 0 { tradingHomeDivider }
                Button {
                    openWeb(alert.actionUrl ?? "/trading", alert.accountTitle ?? "Trading")
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(alert.title ?? "Alert").font(.caption.weight(.bold))
                                .foregroundStyle(.primary)
                                .multilineTextAlignment(.leading)
                            if let m = alert.message, !m.isEmpty {
                                Text(m).font(.caption2).foregroundStyle(.secondary)
                                    .multilineTextAlignment(.leading)
                            }
                        }
                        Spacer(minLength: 6)
                        tradingHomePill(alert.severity ?? "LOW",
                                        TradingHomePalette.alert(alert.severity, colorScheme))
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    // ── Period snapshots (web card — today / yesterday / last 7 days net) ──

    @ViewBuilder private var snapshotsCard: some View {
        if let s = vm.summary {
            TradingHomeSectionCard(title: "Period snapshots",
                                   sub: "নেট রেজাল্ট", trailing: nil, onTrailing: nil) {
                snapshotRow("Today", s.today?.netResultBdt)
                tradingHomeDivider
                snapshotRow("Yesterday", s.yesterday?.netResultBdt)
                tradingHomeDivider
                snapshotRow("Last 7 days", s.last7?.netResultBdt)
            }
        }
    }

    private func snapshotRow(_ label: String, _ value: Int?) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value.map { TradingHomeFormat.taka($0) } ?? "—")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(value.map { TradingHomePalette.signed($0, colorScheme) } ?? .secondary)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
    }

    // ── Recent activity (web Latest Trades / Latest Expenses cards) ──

    @ViewBuilder private var recentActivity: some View {
        let trades = vm.dash?.latestTrades ?? []
        let expenses = vm.dash?.latestExpenses ?? []
        TradingHomeSectionCard(title: "Latest trades",
                               sub: "সাম্প্রতিক এন্ট্রি", trailing: nil, onTrailing: nil) {
            if trades.isEmpty {
                emptyLine("No trades today")
            } else {
                ForEach(Array(trades.enumerated()), id: \.element.id) { idx, trade in
                    if idx > 0 { tradingHomeDivider }
                    tradeRow(trade)
                }
            }
        }
        TradingHomeSectionCard(title: "Latest expenses",
                               sub: "সাম্প্রতিক খরচ", trailing: nil, onTrailing: nil) {
            if expenses.isEmpty {
                emptyLine("No expenses")
            } else {
                ForEach(Array(expenses.enumerated()), id: \.element.id) { idx, expense in
                    if idx > 0 { tradingHomeDivider }
                    expenseRow(expense)
                }
            }
        }
    }

    private func tradeRow(_ trade: TradingHomeTrade) -> some View {
        Button {
            openWeb("/trading/accounts/\(trade.tradingAccountId ?? "")",
                    trade.accountTitle ?? "Trading")
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(trade.accountTitle ?? trade.tradingAccountId ?? "—")
                        .font(.caption.weight(.bold)).foregroundStyle(.primary).lineLimit(1)
                    Text("\(trade.userName ?? "Staff") · \(trade.tradeType ?? "—") · \(TradingHomeFormat.usdtShort(trade.usdtAmount ?? 0)) USDT")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 6)
                Text(trade.netProfit.map { TradingHomeFormat.taka($0) } ?? "—")
                    .font(.footnote.weight(.bold).monospacedDigit())
                    .foregroundStyle(TradingHomePalette.signed(trade.netProfit ?? 0, colorScheme))
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func expenseRow(_ expense: TradingHomeExpense) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(expense.expenseType ?? "Expense")
                    .font(.caption.weight(.bold)).lineLimit(1)
                Text(expense.accountTitle ?? expense.tradingAccountId ?? "—")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 6)
            Text(expense.amount.map { TradingHomeFormat.taka($0) } ?? "—")
                .font(.footnote.weight(.bold).monospacedDigit())
                .foregroundStyle(TradingHomePalette.red400)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    // ── Shared bits ──

    private var tradingHomeDivider: some View {
        Rectangle().fill(Color.primary.opacity(0.06)).frame(height: 1)
            .padding(.leading, 14)
    }

    private func tradingHomePill(_ label: String, _ tint: Color) -> some View {
        Text(label)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(tint.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
    }

    private func emptyLine(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.vertical, 20)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .tradingHomeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(TradingHomePalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).tradingHomeGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        VStack(spacing: 10) {
            Color.clear.frame(height: 168)
                .tradingHomeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .tradingHomeShimmer()
            ForEach(0..<4, id: \.self) { _ in
                Color.clear.frame(height: 72)
                    .tradingHomeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                    .tradingHomeShimmer()
            }
        }
        .padding(.top, 4)
    }

    /// The web page's mutations (trade entry, expense, bKash summary, screenshot
    /// upload) are NOT native — one escape row covers them all.
    // ── Quick nav — the web's section tabs as native chips. openWeb routes through
    //    pushSmart, so migrated targets open their NATIVE screens (S7 batch). ──
    private var quickNav: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                quickNavChip("Accounts", "person.2.badge.key", "/trading/accounts", "Trading accounts")
                quickNavChip("Analytics", "chart.xyaxis.line", "/trading/analytics", "Trading analytics")
                quickNavChip("HR", "person.text.rectangle", "/trading/hr", "Trading HR")
                quickNavChip("Targets", "target", "/trading/target-control", "Target control")
                quickNavChip("Telegram", "paperplane", "/trading/telegram", "Telegram Quick Entry")
            }
            .padding(.horizontal, 2)
        }
    }

    private func quickNavChip(_ title: String, _ icon: String, _ path: String, _ navTitle: String) -> some View {
        Button {
            openWeb(path, navTitle)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.caption)
                Text(title).font(.footnote.weight(.medium))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .tradingHomeGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var webEscape: some View {
        Button {
            openWeb("/trading", "Trading")
        } label: {
            Label("ট্রেড / স্ক্রিনশট / সামারি — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Section card (web Card + bordered header parity)

@available(iOS 17.0, *)
private struct TradingHomeSectionCard<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let sub: String
    let trailing: String?
    let onTrailing: (() -> Void)?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.footnote.weight(.bold))
                    Text(sub).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if let trailing {
                    if let onTrailing {
                        Button(action: onTrailing) {
                            Text(trailing).font(.caption2.weight(.bold))
                                .foregroundStyle(TradingHomePalette.gold(scheme))
                        }
                        .buttonStyle(.plain)
                    } else {
                        Text(trailing).font(.caption2.weight(.bold))
                            .foregroundStyle(TradingHomePalette.red400)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(TradingHomePalette.red500.opacity(0.12), in: Capsule())
                    }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            Rectangle().fill(Color.primary.opacity(0.06)).frame(height: 1)
            VStack(spacing: 0) { content }
                .padding(.vertical, 2)
        }
        .tradingHomeGlass(scheme, corner: AlmaSwiftTheme.rCard)
    }
}

// MARK: - Account row (MyTradingAccounts parity: title · UID + compliance badge ·
// balance gold · daily P/L signed · health pill)

@available(iOS 17.0, *)
private struct TradingHomeAccountRow: View {
    let account: TradingHomeAccount
    let perf: TradingHomePerfRow?
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: onTap) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(account.accountTitle)
                        .font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                        .lineLimit(1)
                    HStack(spacing: 6) {
                        Text(account.binanceUid?.isEmpty == false ? account.binanceUid! : "No UID")
                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        complianceBadge
                        if let h = perf?.health {
                            pill(h, TradingHomePalette.health(h, colorScheme))
                        }
                    }
                }
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(TradingHomeFormat.taka(perf?.currentBalance
                        ?? account.currentBalance ?? account.startingCapital ?? 0))
                        .font(.footnote.weight(.bold).monospacedDigit())
                        .foregroundStyle(TradingHomePalette.gold(colorScheme))
                    if let pl = perf?.dailyPl {
                        Text("Today \(TradingHomeFormat.taka(pl))")
                            .font(.caption2.weight(.bold).monospacedDigit())
                            .foregroundStyle(TradingHomePalette.signed(pl, colorScheme))
                    }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Web complianceBadge: today/COMPLETE green "Today ✓" · OVERDUE red · DUE amber.
    @ViewBuilder private var complianceBadge: some View {
        if (perf?.screenshotToday ?? false) || perf?.screenshotCompliance == "COMPLETE" {
            pill("Today ✓", colorScheme == .dark ? TradingHomePalette.green400
                                                 : TradingHomePalette.emerald600)
        } else if perf?.screenshotCompliance == "OVERDUE" {
            pill("Screenshot overdue", TradingHomePalette.red500)
        } else if perf?.screenshotCompliance == "DUE" {
            pill("Screenshot due", colorScheme == .dark ? TradingHomePalette.amber500
                                                        : TradingHomePalette.amber600)
        }
    }

    private func pill(_ label: String, _ tint: Color) -> some View {
        Text(label)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(tint.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
            .lineLimit(1)
    }
}

// MARK: - Aurora background + glass (TradingHome-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct TradingHomeAurora: View {
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
    func tradingHomeGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct TradingHomeShimmer: ViewModifier {
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
    func tradingHomeShimmer() -> some View { modifier(TradingHomeShimmer()) }
}

// MARK: - Bento components (TradingHome-owned copies of the Dashboard board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func tradingHomeMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct TradingHomeCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        TradingHomeCountUpText(value: shown, format: format)
            .animation(tradingHomeMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if tradingHomeMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct TradingHomeCountUpText: View, Animatable {
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
private func tradingHomeBentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
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
/// `target == nil` renders the "—" placeholder (same fallback the web KPI cards had).
@available(iOS 17.0, *)
private struct TradingHomeBentoStatTile: View {
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
                TradingHomeCountUp(target: target, format: format)
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
        .background { tradingHomeBentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe,
/// re-tinted for trading: the business-switcher sage green leads, violet/coral stay
/// as supporting washes). Current-balance count-up plus the Today net / profit / loss
/// split — the web's first KPI row, same numbers, same signed tints.
@available(iOS 17.0, *)
private struct TradingHomeHeroCard: View {
    let balance: Int?
    let todayNet: Int?
    let todayProfit: Int?
    let todayLoss: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("কারেন্ট ব্যালেন্স · TRADING").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(TradingHomePalette.sage)
            Group {
                if let balance {
                    TradingHomeCountUp(target: balance, format: { AlmaSwiftTheme.takaShort($0) })
                } else {
                    Text("—")
                }
            }
            .font(.system(size: 40, weight: .heavy)).monospacedDigit()
            .foregroundStyle(.white)
            .lineLimit(1).minimumScaleFactor(0.6)
            .padding(.top, 8)
            Text("সব ট্রেডিং অ্যাকাউন্ট মিলিয়ে")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Today net", target: todayNet,
                         tint: (todayNet ?? 0) < 0 ? TradingHomePalette.red400
                                                   : TradingHomePalette.green400,
                         sub: "আজকের নেট")
                heroDivider
                heroStat(label: "Today profit", target: todayProfit,
                         tint: TradingHomePalette.green400, sub: "আজকের লাভ")
                heroDivider
                heroStat(label: "Today loss", target: todayLoss,
                         tint: TradingHomePalette.red400, sub: "আজকের লস")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.094, green: 0.082, blue: 0.157))
                LinearGradient(colors: [TradingHomePalette.sage.opacity(0.34), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.24), .clear],
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

    private var heroDivider: some View {
        Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
            .padding(.vertical, 2).padding(.horizontal, 12)
    }

    private func heroStat(label: String, target: Int?, tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            Group {
                if let target {
                    TradingHomeCountUp(target: target, format: { AlmaSwiftTheme.takaShort($0) })
                } else {
                    Text("—")
                }
            }
            .font(.system(size: 17, weight: .heavy)).monospacedDigit()
            .foregroundStyle(tint)
            .lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Trading — Light") {
    TradingHomeScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
