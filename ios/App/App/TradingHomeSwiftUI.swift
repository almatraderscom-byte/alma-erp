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
    // Native writes (owner 2026-07-11): the trade sheet's live P/L preview needs the
    // inventory position, the expense sheet needs the partnership flag — same fields
    // the web TradingAccount type reads.
    let usdtBalance: Double?
    let inventoryCostBdt: Double?
    let partnershipEnabled: Bool

    private enum Keys: String, CodingKey {
        case id, accountTitle, binanceUid, accountType, status, startingCapital, currentBalance
        case usdtBalance, inventoryCostBdt, partnershipEnabled
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
        usdtBalance = c.tradingHomeDouble(.usdtBalance)
        inventoryCostBdt = c.tradingHomeDouble(.inventoryCostBdt)
        partnershipEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .partnershipEnabled)) ?? false
    }
}

/// POST answers `{ ok, ... }` — only ok matters to the sheets (web checks res?.ok).
private struct TradingHomeMutationResponse: Decodable {
    let ok: Bool
    let error: String?
    private enum Keys: String, CodingKey { case ok, error }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        error = try? c.decodeIfPresent(String.self, forKey: .error)
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

    // ── Native writes (owner 2026-07-11: money entry goes native, not web escape).
    //    Same endpoints/payloads the web hooks fire (src/lib/api.ts trading section). ──

    struct TradePayload: Encodable {
        let tradingAccountId: String, tradeType: String
        let usdtAmount: Double, bdtRate: Double, feeUsdt: Double
        let notes: String
    }
    struct BkashPayload: Encodable {
        let tradingAccountId: String, summaryDate: String
        let totalOrders: Int, totalProfitBdt: Double, totalLossBdt: Double
        let notes: String
    }
    struct ExpensePayload: Encodable {
        let tradingAccountId: String, expenseType: String
        let amount: Double
        let paidBy: String?
        let notes: String
        let attachmentUrl: String?
    }
    struct CapitalPayload: Encodable {
        let tradingAccountId: String, entryType: String
        let amount: Double
        let notes: String
    }

    var toast: String? = nil

    /// One shared runner: POST → ok-check → reload dashboards. Returns success.
    private func post(_ path: String, _ body: some Encodable, success: String) async -> Bool {
        do {
            let res: TradingHomeMutationResponse = try await AlmaAPI.shared.send("POST", path, body: body)
            guard res.ok else {
                toast = res.error ?? "সেভ হয়নি — আবার চেষ্টা করুন"
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

    func submitTrade(_ p: TradePayload) async -> Bool {
        await post("/api/trading/trades", p, success: "ট্রেড সেভ হয়েছে")
    }
    func submitBkash(_ p: BkashPayload) async -> Bool {
        await post("/api/trading/accounts/\(p.tradingAccountId)/bkash-summary", p,
                   success: "Bkash summary সেভ হয়েছে")
    }
    func addExpense(_ p: ExpensePayload) async -> Bool {
        await post("/api/trading/expenses", p, success: "খরচ যোগ হয়েছে")
    }
    func addCapital(_ p: CapitalPayload) async -> Bool {
        await post("/api/trading/capital", p, success: "Capital entry পোস্ট হয়েছে")
    }

    /// Expense attachment (image/PDF) → returns the stored URL for the payload.
    struct AttachmentResponse: Decodable {
        struct Attachment: Decodable { let url: String? }
        let ok: Bool?, attachment: Attachment?
    }
    func uploadAttachment(data: Data, filename: String, mime: String) async -> String? {
        let res: AttachmentResponse? = try? await AlmaAPI.shared.uploadMultipart(
            "/api/trading/attachments", fileField: "file", filename: filename, mime: mime, data: data)
        return res?.attachment?.url
    }

    /// Compliance screenshot — multipart to the account's performance endpoint.
    func uploadScreenshot(accountId: String, data: Data, shotDate: String, note: String) async -> Bool {
        struct ShotResponse: Decodable { let ok: Bool? }
        do {
            var fields = ["shotDate": shotDate]
            if !note.isEmpty { fields["note"] = note }
            let res: ShotResponse = try await AlmaAPI.shared.uploadMultipart(
                "/api/trading/accounts/\(accountId)/performance",
                fileField: "file", filename: "screenshot.jpg", mime: "image/jpeg",
                data: data, fields: fields)
            guard res.ok ?? false else {
                toast = "স্ক্রিনশট আপলোড হয়নি"
                return false
            }
            toast = "স্ক্রিনশট আপলোড হয়েছে"
            await load()
            return true
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return false
        } catch {
            toast = error.localizedDescription
            return false
        }
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
    @State private var showTrade = false
    @State private var showExpense = false
    @State private var showCapital = false
    @State private var showShot = false
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
                    workflowActions
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
        .sheet(isPresented: $showTrade) { TradingHomeTradeSheet(vm: vm) }
        .sheet(isPresented: $showExpense) { TradingHomeExpenseSheet(vm: vm) }
        .sheet(isPresented: $showCapital) { TradingHomeCapitalSheet(vm: vm) }
        .sheet(isPresented: $showShot) { TradingHomeShotSheet(vm: vm) }
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

    // ── Workflow actions (web TradingQuickActions parity — native sheets, owner
    //    2026-07-11: money entry native). ──
    private var workflowActions: some View {
        HStack(spacing: 8) {
            workflowButton("plus.circle.fill", "Add Trade", TradingHomePalette.gold(colorScheme)) { showTrade = true }
            workflowButton("banknote", "Expense", TradingHomePalette.signed(-1, colorScheme)) { showExpense = true }
            workflowButton("arrow.up.arrow.down.circle", "Capital", AlmaSwiftTheme.sage) { showCapital = true }
            workflowButton("camera.viewfinder", "Screenshot", AlmaSwiftTheme.violet) { showShot = true }
        }
    }
    private func workflowButton(_ icon: String, _ label: String, _ tint: Color,
                                action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            VStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 17, weight: .semibold))
                Text(label).font(.system(size: 10, weight: .bold))
                    .lineLimit(1).minimumScaleFactor(0.8)
            }
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(tint.opacity(0.25), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(vm.accounts.isEmpty)
        .opacity(vm.accounts.isEmpty ? 0.5 : 1)
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

// MARK: - Native write sheets (owner 2026-07-11: trade/expense/capital/screenshot
// entry goes native — web TradingModals.tsx parity, same payloads).

import PhotosUI

/// Shared sheet chrome: title bar + footer submit button, web ModalFrame parity.
@available(iOS 17.0, *)
private struct TradingHomeSheetFrame<Content: View>: View {
    let title: String
    let desc: String
    let submitLabel: String
    let submitting: Bool
    let canSubmit: Bool
    let onSubmit: () -> Void
    @ViewBuilder let content: Content
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.subheadline.weight(.bold))
                    Text(desc).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Close") { dismiss() }
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .buttonStyle(.plain)
            }
            .padding(.horizontal, 18).padding(.top, 20).padding(.bottom, 12)
            Divider().opacity(0.4)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) { content }
                    .padding(18)
            }
            .scrollDismissesKeyboard(.interactively)
            Divider().opacity(0.4)
            Button(action: onSubmit) {
                HStack(spacing: 8) {
                    if submitting { ProgressView().tint(.white) }
                    Text(submitLabel).font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(canSubmit && !submitting ? AlmaSwiftTheme.coral : AlmaSwiftTheme.coral.opacity(0.4),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit || submitting)
            .padding(.horizontal, 18).padding(.vertical, 14)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .background(AlmaSwiftTheme.rootBg(scheme))
    }
}

/// Small labelled numeric/text field, web Input parity.
@available(iOS 17.0, *)
private struct TradingHomeField: View {
    let placeholder: String
    @Binding var text: String
    var keyboard: UIKeyboardType = .decimalPad

    var body: some View {
        TextField(placeholder, text: $text)
            .keyboardType(keyboard)
            .font(.subheadline.weight(keyboard == .decimalPad ? .bold : .regular))
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(Color.primary.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }
}

/// Account picker used by every write sheet.
@available(iOS 17.0, *)
private struct TradingHomeAccountPicker: View {
    let accounts: [TradingHomeAccount]
    @Binding var selectedId: String

    var body: some View {
        Menu {
            ForEach(accounts) { a in
                Button(a.accountTitle) { selectedId = a.id }
            }
        } label: {
            HStack {
                Text(accounts.first(where: { $0.id == selectedId })?.accountTitle ?? "অ্যাকাউন্ট বাছুন")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.caption2)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(Color.primary.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        }
    }
}

// ── Add Trade (web TradeEntryModal: BKASH daily summary / BANK P2P engine) ──

@available(iOS 17.0, *)
private struct TradingHomeTradeSheet: View {
    let vm: TradingHomeVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var accountId = ""
    @State private var mode = "BANK"           // BANK | BKASH — web defaults BANK
    @State private var tradeType = "BUY"
    @State private var usdtAmount = ""
    @State private var bdtRate = ""
    @State private var feeUsdt = ""
    @State private var notes = ""
    @State private var bkashDate = TradingHomeDateHelper.today()
    @State private var bkashProfit = ""
    @State private var bkashLoss = ""
    @State private var submitting = false
    @State private var errorText: String? = nil
    @State private var confirming = false

    private var account: TradingHomeAccount? { vm.accounts.first(where: { $0.id == accountId }) }
    private func num(_ s: String) -> Double { Double(s.replacingOccurrences(of: ",", with: "")) ?? 0 }

    // Web calc block parity (TradingModals.tsx calc useMemo).
    private var totalBdt: Double { num(usdtAmount) * num(bdtRate) }
    private var feeBdt: Double { num(feeUsdt) * num(bdtRate) }
    private var netBdt: Double { tradeType == "BUY" ? totalBdt + feeBdt : totalBdt - feeBdt }
    private var avgCostRate: Double {
        let bal = account?.usdtBalance ?? 0
        return bal > 0 ? (account?.inventoryCostBdt ?? 0) / bal : 0
    }
    private var sellNet: Double { netBdt - num(usdtAmount) * avgCostRate }
    private var bkashNet: Double { num(bkashProfit) - num(bkashLoss) }

    private var canSubmit: Bool {
        guard account != nil else { return false }
        if mode == "BKASH" { return num(bkashProfit) > 0 || num(bkashLoss) > 0 }
        return num(usdtAmount) > 0 && num(bdtRate) > 0 && num(feeUsdt) >= 0
    }

    var body: some View {
        TradingHomeSheetFrame(
            title: "Add Trade Entry",
            desc: account?.accountTitle ?? "Choose account · Bkash summary or Bank/P2P",
            submitLabel: mode == "BKASH" ? "Save Bkash summary" : "Submit trade",
            submitting: submitting, canSubmit: canSubmit,
            onSubmit: { confirming = true }
        ) {
            if vm.accounts.count > 1 {
                TradingHomeAccountPicker(accounts: vm.accounts, selectedId: $accountId)
            }
            Picker("Mode", selection: $mode) {
                Text("BKASH").tag("BKASH")
                Text("BANK / P2P").tag("BANK")
            }
            .pickerStyle(.segmented)

            if mode == "BKASH" {
                Text("২০০-৩০০+ ছোট merchant action-এর দিনের ফল — USDT/rate/fee লাগে না।")
                    .font(.caption2).foregroundStyle(.secondary)
                DatePicker("তারিখ", selection: Binding(
                    get: { TradingHomeDateHelper.parse(bkashDate) },
                    set: { bkashDate = TradingHomeDateHelper.string($0) }
                ), displayedComponents: .date)
                .font(.subheadline)
                TradingHomeField(placeholder: "Total daily profit (BDT)", text: $bkashProfit)
                TradingHomeField(placeholder: "Total daily loss (BDT)", text: $bkashLoss)
                resultPanel(label: "Net result = profit - loss", value: bkashNet, signed: true)
            } else {
                Picker("Type", selection: $tradeType) {
                    Text("BUY").tag("BUY")
                    Text("SELL").tag("SELL")
                }
                .pickerStyle(.segmented)
                TradingHomeField(placeholder: "USDT amount", text: $usdtAmount)
                TradingHomeField(placeholder: "BDT Rate", text: $bdtRate)
                TradingHomeField(placeholder: "Binance Fee (USDT)", text: $feeUsdt)
                HStack(spacing: 8) {
                    calcTile(tradeType == "BUY" ? "Total BDT" : "Sell BDT", totalBdt)
                    calcTile("Fee BDT", feeBdt)
                    calcTile(tradeType == "BUY" ? "Net Buy Cost" : "Net Receive", netBdt)
                }
                if tradeType == "SELL" {
                    resultPanel(label: "Live profit / loss (avg cost ৳\(String(format: "%.2f", avgCostRate)))",
                                value: sellNet, signed: true)
                }
                if tradeType == "SELL", num(usdtAmount) > (account?.usdtBalance ?? 0) {
                    Label("Sell USDT অ্যাকাউন্টের USDT ব্যালান্সের বেশি", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2.weight(.semibold)).foregroundStyle(TradingHomePalette.signed(-1, scheme))
                }
            }
            TradingHomeField(placeholder: "Notes", text: $notes, keyboard: .default)
            if let errorText {
                Text(errorText).font(.caption2.weight(.semibold))
                    .foregroundStyle(TradingHomePalette.signed(-1, scheme))
            }
        }
        .onAppear { if accountId.isEmpty { accountId = vm.accounts.first?.id ?? "" } }
        .confirmationDialog(
            mode == "BKASH"
                ? "Bkash summary সেভ করবেন? Net \(TradingHomeFormat.taka(Int(bkashNet.rounded())))"
                : "\(tradeType) ট্রেড সাবমিট করবেন? Net \(TradingHomeFormat.taka(Int(netBdt.rounded())))",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, সেভ করুন") { submit() }
            Button("বাতিল", role: .cancel) {}
        }
    }

    private func calcTile(_ label: String, _ value: Double) -> some View {
        VStack(spacing: 3) {
            Text(label).font(.system(size: 9)).foregroundStyle(.secondary)
            Text(TradingHomeFormat.taka(Int(value.rounded())))
                .font(.caption.weight(.bold)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(Color.primary.opacity(0.05),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }

    private func resultPanel(label: String, value: Double, signed: Bool) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 9, weight: .bold)).tracking(0.6)
                .foregroundStyle(.secondary)
            Text("\(value >= 0 ? "+" : "-")\(TradingHomeFormat.taka(Int(abs(value).rounded())))")
                .font(.system(size: 26, weight: .bold)).monospacedDigit()
                .foregroundStyle(TradingHomePalette.signed(value >= 0 ? 1 : -1, scheme))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(TradingHomePalette.signed(value >= 0 ? 1 : -1, scheme).opacity(0.10),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }

    private func submit() {
        guard let account, !submitting else { return }
        if mode == "BANK", tradeType == "SELL", num(usdtAmount) > (account.usdtBalance ?? 0) {
            errorText = "Sell USDT exceeds account USDT balance."
            return
        }
        submitting = true; errorText = nil
        Task {
            defer { submitting = false }
            let ok: Bool
            if mode == "BKASH" {
                ok = await vm.submitBkash(.init(
                    tradingAccountId: account.id, summaryDate: bkashDate, totalOrders: 0,
                    totalProfitBdt: num(bkashProfit), totalLossBdt: num(bkashLoss), notes: notes))
            } else {
                ok = await vm.submitTrade(.init(
                    tradingAccountId: account.id, tradeType: tradeType,
                    usdtAmount: num(usdtAmount), bdtRate: num(bdtRate), feeUsdt: num(feeUsdt),
                    notes: notes.trimmingCharacters(in: .whitespaces)))
            }
            if ok {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                dismiss()
            } else {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                errorText = vm.toast
            }
        }
    }
}

// ── Expense entry (web ExpenseEntryModal — attachment optional) ──

@available(iOS 17.0, *)
private struct TradingHomeExpenseSheet: View {
    let vm: TradingHomeVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var accountId = ""
    @State private var expenseType = "Mobile purchase"
    @State private var amount = ""
    @State private var paidBy = "OWNER"
    @State private var notes = ""
    @State private var attachmentUrl: String? = nil
    @State private var uploading = false
    @State private var pickedItem: PhotosPickerItem? = nil
    @State private var submitting = false
    @State private var confirming = false

    // Web EXPENSE_TYPES verbatim (trading-utils.ts).
    private let types = ["Mobile purchase", "Internet/MB", "SIM", "Travel",
                         "Device purchase", "Banking charges", "Misc operational"]

    private var account: TradingHomeAccount? { vm.accounts.first(where: { $0.id == accountId }) }
    private func num(_ s: String) -> Double { Double(s.replacingOccurrences(of: ",", with: "")) ?? 0 }
    private var canSubmit: Bool { account != nil && num(amount) > 0 && !uploading }

    var body: some View {
        TradingHomeSheetFrame(
            title: "Add account expense",
            desc: "Account ledger খরচ — global finance/analytics-এও যাবে।",
            submitLabel: "Add expense", submitting: submitting, canSubmit: canSubmit,
            onSubmit: { confirming = true }
        ) {
            TradingHomeAccountPicker(accounts: vm.accounts, selectedId: $accountId)
            Menu {
                ForEach(types, id: \.self) { t in Button(t) { expenseType = t } }
            } label: {
                HStack {
                    Text(expenseType).font(.subheadline.weight(.semibold))
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.caption2)
                }
                .foregroundStyle(.primary)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Color.primary.opacity(0.06),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            }
            TradingHomeField(placeholder: "Expense Amount (BDT)", text: $amount)
            if account?.partnershipEnabled == true {
                Picker("কে দিয়েছে", selection: $paidBy) {
                    Text("আমি (Owner)").tag("OWNER")
                    Text("Staff").tag("STAFF")
                }
                .pickerStyle(.segmented)
            }
            PhotosPicker(selection: $pickedItem, matching: .images) {
                HStack(spacing: 8) {
                    Image(systemName: attachmentUrl != nil ? "checkmark.circle.fill" : "paperclip")
                    Text(uploading ? "Uploading…"
                         : attachmentUrl != nil ? "Attachment ready"
                         : "রিসিট/স্ক্রিনশট যোগ করুন (ঐচ্ছিক)")
                        .font(.caption.weight(.semibold))
                    if uploading { ProgressView().controlSize(.mini) }
                }
                .foregroundStyle(attachmentUrl != nil ? AlmaSwiftTheme.sage : .secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Color.primary.opacity(0.05),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            }
            .onChange(of: pickedItem) { _, item in
                guard let item else { return }
                uploading = true
                Task {
                    defer { uploading = false }
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        attachmentUrl = await vm.uploadAttachment(
                            data: data, filename: "receipt.jpg", mime: "image/jpeg")
                    }
                }
            }
            TradingHomeField(placeholder: "Notes", text: $notes, keyboard: .default)
        }
        .onAppear { if accountId.isEmpty { accountId = vm.accounts.first?.id ?? "" } }
        .confirmationDialog(
            "\(TradingHomeFormat.taka(Int(num(amount).rounded()))) খরচ যোগ করবেন (\(expenseType))?",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, যোগ করুন") { submit() }
            Button("বাতিল", role: .cancel) {}
        }
    }

    private func submit() {
        guard let account, !submitting else { return }
        submitting = true
        Task {
            defer { submitting = false }
            let ok = await vm.addExpense(.init(
                tradingAccountId: account.id, expenseType: expenseType, amount: num(amount),
                paidBy: account.partnershipEnabled ? paidBy : nil,
                notes: notes, attachmentUrl: attachmentUrl))
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { dismiss() }
        }
    }
}

// ── Capital entry (web CapitalEntryModal: deposit / withdraw / adjustment) ──

@available(iOS 17.0, *)
private struct TradingHomeCapitalSheet: View {
    let vm: TradingHomeVM
    @Environment(\.dismiss) private var dismiss
    @State private var accountId = ""
    @State private var entryType = "DEPOSIT"
    @State private var amount = ""
    @State private var notes = ""
    @State private var submitting = false
    @State private var confirming = false

    private var account: TradingHomeAccount? { vm.accounts.first(where: { $0.id == accountId }) }
    private func num(_ s: String) -> Double { Double(s.replacingOccurrences(of: ",", with: "")) ?? 0 }
    private var canSubmit: Bool { account != nil && num(amount) != 0 }
    private var typeLabel: String {
        entryType == "DEPOSIT" ? "Deposit" : entryType == "WITHDRAW" ? "Withdraw" : "Adjustment"
    }

    var body: some View {
        TradingHomeSheetFrame(
            title: "Capital entry",
            desc: account?.accountTitle ?? "Deposit, withdraw, or adjustment",
            submitLabel: "Post capital entry", submitting: submitting, canSubmit: canSubmit,
            onSubmit: { confirming = true }
        ) {
            TradingHomeAccountPicker(accounts: vm.accounts, selectedId: $accountId)
            Picker("Type", selection: $entryType) {
                Text("Deposit").tag("DEPOSIT")
                Text("Withdraw").tag("WITHDRAW")
                Text("Adjustment").tag("ADJUSTMENT")
            }
            .pickerStyle(.segmented)
            TradingHomeField(placeholder: "Amount", text: $amount)
            TradingHomeField(placeholder: "Notes", text: $notes, keyboard: .default)
        }
        .onAppear { if accountId.isEmpty { accountId = vm.accounts.first?.id ?? "" } }
        .confirmationDialog(
            "\(typeLabel) \(TradingHomeFormat.taka(Int(num(amount).rounded()))) পোস্ট করবেন?",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, পোস্ট করুন") { submit() }
            Button("বাতিল", role: .cancel) {}
        }
    }

    private func submit() {
        guard let account, !submitting else { return }
        submitting = true
        Task {
            defer { submitting = false }
            let ok = await vm.addCapital(.init(
                tradingAccountId: account.id, entryType: entryType,
                amount: num(amount), notes: notes))
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { dismiss() }
        }
    }
}

// ── Compliance screenshot upload (web ScreenshotUploadModal essentials) ──

@available(iOS 17.0, *)
private struct TradingHomeShotSheet: View {
    let vm: TradingHomeVM
    @Environment(\.dismiss) private var dismiss
    @State private var accountId = ""
    @State private var shotDate = TradingHomeDateHelper.today()
    @State private var note = ""
    @State private var pickedItem: PhotosPickerItem? = nil
    @State private var imageData: Data? = nil
    @State private var preview: UIImage? = nil
    @State private var submitting = false

    private var canSubmit: Bool { !accountId.isEmpty && imageData != nil }

    var body: some View {
        TradingHomeSheetFrame(
            title: "Upload Screenshot",
            desc: "দিনের performance screenshot — compliance এখান থেকেই আপডেট হয়।",
            submitLabel: "Upload", submitting: submitting, canSubmit: canSubmit,
            onSubmit: submit
        ) {
            TradingHomeAccountPicker(accounts: vm.accounts, selectedId: $accountId)
            DatePicker("তারিখ", selection: Binding(
                get: { TradingHomeDateHelper.parse(shotDate) },
                set: { shotDate = TradingHomeDateHelper.string($0) }
            ), displayedComponents: .date)
            .font(.subheadline)
            PhotosPicker(selection: $pickedItem, matching: .screenshots) {
                Group {
                    if let preview {
                        Image(uiImage: preview)
                            .resizable().scaledToFit()
                            .frame(maxHeight: 220)
                            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "photo.badge.plus").font(.title2)
                            Text("স্ক্রিনশট বাছুন").font(.caption.weight(.semibold))
                        }
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 36)
                        .background(Color.primary.opacity(0.05),
                                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    }
                }
            }
            .onChange(of: pickedItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        imageData = data
                        preview = UIImage(data: data)
                    }
                }
            }
            TradingHomeField(placeholder: "Note (ঐচ্ছিক)", text: $note, keyboard: .default)
        }
        .onAppear { if accountId.isEmpty { accountId = vm.accounts.first?.id ?? "" } }
    }

    private func submit() {
        guard let imageData, !submitting else { return }
        submitting = true
        Task {
            defer { submitting = false }
            let ok = await vm.uploadScreenshot(
                accountId: accountId, data: imageData, shotDate: shotDate, note: note)
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { dismiss() }
        }
    }
}

/// yyyy-MM-dd helpers for the web's date payloads (Dhaka-day semantics live server-side).
private enum TradingHomeDateHelper {
    static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()
    static func today() -> String { string(Date()) }
    static func string(_ d: Date) -> String { formatter.string(from: d) }
    static func parse(_ s: String) -> Date { formatter.date(from: s) ?? Date() }
}
