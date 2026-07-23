//
//  TradingAccountsSwiftUI.swift
//  ALMA ERP — Trading Accounts (/trading/accounts + /trading/accounts/[id]) as a
//  native SwiftUI screen (read + native account create/edit/archive).
//
//  Mirrors the web pages — same endpoints, same colours, same blocks:
//    GET /api/trading/accounts?search=…&status=…       → { accounts, total }
//    GET /api/trading/accounts/{id}/summary            → { account, summary, today,
//                                                          ranges, recentTrades, … }
//  Web-parity blocks (list): search (title/UID/staff) · status filter chips
//  (All/Active/Paused/Completed/Closed, web TRADING_STATUS_OPTIONS) · account rows
//  (title + 50/50 partnership pill · staff · UID · balance gold/red · profit green ·
//  merchant progress · status pill). Detail sheet mirrors the web detail page:
//  KPI grid (balance/capital/trades/USDT/profit/loss/expenses/withdrawals/ROI/net P/L)
//  · negative-balance risk warning · account info card (type, staff, commission,
//  deposits/withdrawals/adjustments, merchant progress) · partnership card ·
//  Today Summary · ranges strip · recent trades · recent expenses.
//  NATIVE WRITES (verified 2026-07-17): account create (POST /api/trading/accounts)
//  and edit/archive (PATCH …/{id}). Trade/expense/capital/screenshot entry is native
//  on Trading Home. STILL WEB (parity ledger TR-01/TR-02, phases NP-6): detail-level
//  trade edit/audit/delete flows and partnership settlement.
//  Carried lessons: lenient all-optional decoding (Prisma Decimals arrive as JSON
//  strings), ONE spinner (AlmaStarburstSpinner family), cancellation-safe
//  .refreshable, auth card, no global overlays.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum TradingAccountsPalette {
    static var coral: Color { AlmaSwiftTheme.coral }
    static var goldLt: Color { AlmaSwiftTheme.accentLt }
    static var goldDim: Color { AlmaSwiftTheme.accentDim }
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let red400 = Color(red: 0.973, green: 0.443, blue: 0.443)         // #F87171
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let slate400 = Color(red: 0.580, green: 0.639, blue: 0.722)       // #94A3B8
    /// Trading hero accent — sage green (owner spec for the Trading pages).
    static let sage = Color(red: 0.51, green: 0.70, blue: 0.60)              // #82B399

    /// The web's gold-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Web statusClass: ACTIVE green · COMPLETED gold · PAUSED amber · CLOSED zinc.
    static func status(_ s: String?, _ scheme: ColorScheme) -> Color {
        switch s {
        case "ACTIVE": return scheme == .dark ? green400 : emerald600
        case "COMPLETED": return accentText(scheme)
        case "PAUSED": return scheme == .dark ? amber500 : amber600
        default: return slate400          // CLOSED / unknown
        }
    }

    /// Web signedClass: >= 0 green-400 · < 0 red-400 (light theme uses the deeper pair).
    static func signed(_ v: Double, _ scheme: ColorScheme) -> Color {
        v >= 0 ? (scheme == .dark ? green400 : emerald600)
               : (scheme == .dark ? red400 : red500)
    }

    /// Web balance colour: negative red-400, else gold.
    static func balance(_ v: Double, _ scheme: ColorScheme) -> Color {
        v < 0 ? (scheme == .dark ? red400 : red500) : accentText(scheme)
    }
}

// MARK: - Flexible number decoding (Prisma Decimal serializes as a JSON string)

private func tradingAccountsFlexDouble<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
    return nil
}

private func tradingAccountsFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) ?? Double(s).map { Int($0.rounded()) } }
    return nil
}

// MARK: - Models (same field names the web TradingAccountListItem type declares)

struct TradingAccountsRow: Decodable, Identifiable, Equatable {
    let id: String
    let accountTitle: String
    let binanceUid: String?
    let accountType: String?
    let status: String?
    let startingCapital: Double?
    let currentBalance: Double?
    let totalProfit: Double?
    let totalLoss: Double?
    let totalExpenses: Double?
    let totalWithdrawals: Double?
    let merchantProgress: Double?
    let partnershipEnabled: Bool?
    let partnershipNetStaffOwes: Double?
    let staffSharePercent: Double?
    let lastPartnershipSettledAt: String?
    let commissionType: String?
    let commissionRate: Double?
    let fixedCommission: Double?
    let startDate: String?
    let assignedUserName: String?
    let notes: String?
    // Native edit form prefill (owner 2026-07-11: account create/edit goes native).
    let merchantTarget: Double?
    let completionBonus: Double?
    let assignedUserId: String?

    private enum Keys: String, CodingKey {
        case id, accountTitle, binanceUid, accountType, status
        case startingCapital, currentBalance, totalProfit, totalLoss
        case totalExpenses, totalWithdrawals, merchantProgress
        case partnershipEnabled, partnershipNetStaffOwes, staffSharePercent
        case lastPartnershipSettledAt
        case commissionType, commissionRate, fixedCommission
        case startDate, assignedUser, notes
        case merchantTarget, completionBonus, assignedUserId
    }
    private enum UserKeys: String, CodingKey { case name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        accountTitle = (try? c.decode(String.self, forKey: .accountTitle)) ?? "—"
        binanceUid = try? c.decodeIfPresent(String.self, forKey: .binanceUid)
        accountType = try? c.decodeIfPresent(String.self, forKey: .accountType)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        startingCapital = tradingAccountsFlexDouble(c, .startingCapital)
        currentBalance = tradingAccountsFlexDouble(c, .currentBalance)
        totalProfit = tradingAccountsFlexDouble(c, .totalProfit)
        totalLoss = tradingAccountsFlexDouble(c, .totalLoss)
        totalExpenses = tradingAccountsFlexDouble(c, .totalExpenses)
        totalWithdrawals = tradingAccountsFlexDouble(c, .totalWithdrawals)
        merchantProgress = tradingAccountsFlexDouble(c, .merchantProgress)
        partnershipEnabled = try? c.decodeIfPresent(Bool.self, forKey: .partnershipEnabled)
        partnershipNetStaffOwes = tradingAccountsFlexDouble(c, .partnershipNetStaffOwes)
        staffSharePercent = tradingAccountsFlexDouble(c, .staffSharePercent)
        lastPartnershipSettledAt = try? c.decodeIfPresent(String.self, forKey: .lastPartnershipSettledAt)
        commissionType = try? c.decodeIfPresent(String.self, forKey: .commissionType)
        commissionRate = tradingAccountsFlexDouble(c, .commissionRate)
        fixedCommission = tradingAccountsFlexDouble(c, .fixedCommission)
        startDate = try? c.decodeIfPresent(String.self, forKey: .startDate)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        let u = try? c.nestedContainer(keyedBy: UserKeys.self, forKey: .assignedUser)
        assignedUserName = u.flatMap { try? $0.decodeIfPresent(String.self, forKey: .name) }
        merchantTarget = tradingAccountsFlexDouble(c, .merchantTarget)
        completionBonus = tradingAccountsFlexDouble(c, .completionBonus)
        assignedUserId = try? c.decodeIfPresent(String.self, forKey: .assignedUserId)
    }

    static func == (a: TradingAccountsRow, b: TradingAccountsRow) -> Bool { a.id == b.id }
}

/// GET /api/trading/accounts answers flat `{ accounts, total }`; tolerate an
/// apiDataSuccess `{ ok, data: {…} }` wrap too, like the approvals decoder does.
struct TradingAccountsListResponse: Decodable {
    let accounts: [TradingAccountsRow]

    private enum Keys: String, CodingKey { case ok, data, accounts }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        accounts = (try? c.decode([TradingAccountsRow].self, forKey: .accounts)) ?? []
    }
}

/// Web TradingSummary — the detail page's KPI numbers (route computes plain numbers).
struct TradingAccountsSummary: Decodable, Equatable {
    let startingCapital: Double
    let currentBalance: Double
    let totalProfit: Double
    let totalLoss: Double
    let totalFees: Double
    let totalExpenses: Double
    let totalWithdrawals: Double
    let totalTrades: Int
    let totalTradedUsdt: Double
    let totalBuyUsdt: Double
    let totalSellUsdt: Double
    let usdtBalance: Double
    let netOperationalProfit: Double
    let roiPct: Double
    let deposits: Double
    let adjustments: Double
    let merchantProgress: Double

    private enum Keys: String, CodingKey {
        case startingCapital, currentBalance, totalProfit, totalLoss, totalFees
        case totalExpenses, totalWithdrawals, totalTrades, totalTradedUsdt
        case totalBuyUsdt, totalSellUsdt, usdtBalance, netOperationalProfit
        case roiPct, deposits, adjustments, merchantProgress
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        startingCapital = tradingAccountsFlexDouble(c, .startingCapital) ?? 0
        currentBalance = tradingAccountsFlexDouble(c, .currentBalance) ?? 0
        totalProfit = tradingAccountsFlexDouble(c, .totalProfit) ?? 0
        totalLoss = tradingAccountsFlexDouble(c, .totalLoss) ?? 0
        totalFees = tradingAccountsFlexDouble(c, .totalFees) ?? 0
        totalExpenses = tradingAccountsFlexDouble(c, .totalExpenses) ?? 0
        totalWithdrawals = tradingAccountsFlexDouble(c, .totalWithdrawals) ?? 0
        totalTrades = tradingAccountsFlexInt(c, .totalTrades) ?? 0
        totalTradedUsdt = tradingAccountsFlexDouble(c, .totalTradedUsdt) ?? 0
        totalBuyUsdt = tradingAccountsFlexDouble(c, .totalBuyUsdt) ?? 0
        totalSellUsdt = tradingAccountsFlexDouble(c, .totalSellUsdt) ?? 0
        usdtBalance = tradingAccountsFlexDouble(c, .usdtBalance) ?? 0
        netOperationalProfit = tradingAccountsFlexDouble(c, .netOperationalProfit) ?? 0
        roiPct = tradingAccountsFlexDouble(c, .roiPct) ?? 0
        deposits = tradingAccountsFlexDouble(c, .deposits) ?? 0
        adjustments = tradingAccountsFlexDouble(c, .adjustments) ?? 0
        merchantProgress = tradingAccountsFlexDouble(c, .merchantProgress) ?? 0
    }
}

/// Web TradingDailySummary — the Today Summary cells + the ranges strip rows.
struct TradingAccountsDay: Decodable, Equatable {
    let tradesCount: Int
    let bkashOrders: Int
    let usdtVolume: Double
    let buyUsdtVolume: Double
    let sellUsdtVolume: Double
    let profit: Double
    let loss: Double
    let fees: Double
    let expenses: Double
    let netResult: Double

    private enum Keys: String, CodingKey {
        case tradesCount, bkashOrders, usdtVolume, buyUsdtVolume, sellUsdtVolume
        case profit, loss, fees, expenses, netResult
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        tradesCount = tradingAccountsFlexInt(c, .tradesCount) ?? 0
        bkashOrders = tradingAccountsFlexInt(c, .bkashOrders) ?? 0
        usdtVolume = tradingAccountsFlexDouble(c, .usdtVolume) ?? 0
        buyUsdtVolume = tradingAccountsFlexDouble(c, .buyUsdtVolume) ?? 0
        sellUsdtVolume = tradingAccountsFlexDouble(c, .sellUsdtVolume) ?? 0
        profit = tradingAccountsFlexDouble(c, .profit) ?? 0
        loss = tradingAccountsFlexDouble(c, .loss) ?? 0
        fees = tradingAccountsFlexDouble(c, .fees) ?? 0
        expenses = tradingAccountsFlexDouble(c, .expenses) ?? 0
        netResult = tradingAccountsFlexDouble(c, .netResult) ?? 0
    }
}

struct TradingAccountsRanges: Decodable, Equatable {
    let today: TradingAccountsDay?
    let yesterday: TradingAccountsDay?
    let last7: TradingAccountsDay?
    let currentMonth: TradingAccountsDay?

    private enum Keys: String, CodingKey { case today, yesterday, last7, currentMonth }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        today = try? c.decodeIfPresent(TradingAccountsDay.self, forKey: .today)
        yesterday = try? c.decodeIfPresent(TradingAccountsDay.self, forKey: .yesterday)
        last7 = try? c.decodeIfPresent(TradingAccountsDay.self, forKey: .last7)
        currentMonth = try? c.decodeIfPresent(TradingAccountsDay.self, forKey: .currentMonth)
    }
}

/// Light slice of a trade row for the detail sheet's "Recent trades" block.
struct TradingAccountsTrade: Decodable, Identifiable, Equatable {
    let id: String
    let tradeType: String
    let usdtAmount: Double
    let bdtRate: Double?
    let netBdt: Double?
    let feeBdt: Double?
    let netProfit: Double
    let tradeDate: String?
    let deletedAt: String?

    private enum Keys: String, CodingKey {
        case id, tradeType, usdtAmount, bdtRate, netBdt, feeBdt, feeAmount, netProfit, tradeDate, deletedAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        tradeType = (try? c.decode(String.self, forKey: .tradeType)) ?? "BUY"
        usdtAmount = tradingAccountsFlexDouble(c, .usdtAmount) ?? 0
        bdtRate = tradingAccountsFlexDouble(c, .bdtRate)
        netBdt = tradingAccountsFlexDouble(c, .netBdt)
        feeBdt = tradingAccountsFlexDouble(c, .feeBdt) ?? tradingAccountsFlexDouble(c, .feeAmount)
        netProfit = tradingAccountsFlexDouble(c, .netProfit) ?? 0
        tradeDate = try? c.decodeIfPresent(String.self, forKey: .tradeDate)
        deletedAt = try? c.decodeIfPresent(String.self, forKey: .deletedAt)
    }
    static func == (a: TradingAccountsTrade, b: TradingAccountsTrade) -> Bool { a.id == b.id }
}

/// Light slice of an expense row for the detail sheet's "Recent expenses" block.
struct TradingAccountsExpense: Decodable, Identifiable, Equatable {
    let id: String
    let expenseType: String
    let amount: Double
    let paidBy: String?
    let notes: String?
    let expenseDate: String?

    private enum Keys: String, CodingKey { case id, expenseType, amount, paidBy, notes, expenseDate }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        expenseType = (try? c.decode(String.self, forKey: .expenseType)) ?? "—"
        amount = tradingAccountsFlexDouble(c, .amount) ?? 0
        paidBy = try? c.decodeIfPresent(String.self, forKey: .paidBy)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        expenseDate = try? c.decodeIfPresent(String.self, forKey: .expenseDate)
    }
    static func == (a: TradingAccountsExpense, b: TradingAccountsExpense) -> Bool { a.id == b.id }
}

/// GET /api/trading/accounts/{id}/summary — flat payload; tolerate `{ ok, data }`.
struct TradingAccountsDetail: Decodable {
    let account: TradingAccountsRow?
    let summary: TradingAccountsSummary?
    let today: TradingAccountsDay?
    let ranges: TradingAccountsRanges?
    let recentTrades: [TradingAccountsTrade]
    let recentExpenses: [TradingAccountsExpense]

    private enum Keys: String, CodingKey {
        case ok, data, account, summary, today, ranges, recentTrades, recentExpenses
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        account = try? c.decodeIfPresent(TradingAccountsRow.self, forKey: .account)
        summary = try? c.decodeIfPresent(TradingAccountsSummary.self, forKey: .summary)
        today = try? c.decodeIfPresent(TradingAccountsDay.self, forKey: .today)
        ranges = try? c.decodeIfPresent(TradingAccountsRanges.self, forKey: .ranges)
        recentTrades = (try? c.decodeIfPresent([TradingAccountsTrade].self, forKey: .recentTrades)) ?? []
        recentExpenses = (try? c.decodeIfPresent([TradingAccountsExpense].self, forKey: .recentExpenses)) ?? []
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class TradingAccountsVM {
    var accounts: [TradingAccountsRow] = []
    var search = ""
    var status = "ALL"                    // ALL | ACTIVE | PAUSED | COMPLETED | CLOSED
    var loading = false
    var error: String? = nil
    var authExpired = false

    /// Web TRADING_STATUS_OPTIONS — All status / Active / Paused / Completed / Closed.
    static let statusOptions: [(label: String, value: String)] = [
        ("All", "ALL"), ("Active", "ACTIVE"), ("Paused", "PAUSED"),
        ("Completed", "COMPLETED"), ("Closed", "CLOSED"),
    ]

    // ── Hero summary — computed from the loaded list, same columns the web table sums ──
    var totalBalance: Int { Int(accounts.reduce(0.0) { $0 + ($1.currentBalance ?? 0) }.rounded()) }
    var totalCapital: Int { Int(accounts.reduce(0.0) { $0 + ($1.startingCapital ?? 0) }.rounded()) }
    var totalProfit: Int { Int(accounts.reduce(0.0) { $0 + ($1.totalProfit ?? 0) }.rounded()) }
    var totalExpenses: Int { Int(accounts.reduce(0.0) { $0 + ($1.totalExpenses ?? 0) }.rounded()) }
    var activeCount: Int { accounts.filter { $0.status == "ACTIVE" }.count }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            // Replicates the web api.trading.accounts params exactly (search + status).
            let resp: TradingAccountsListResponse = try await AlmaAPI.shared.get(
                "/api/trading/accounts",
                query: ["search": search, "status": status])
            accounts = resp.accounts
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

    /// Detail payload for the sheet — same endpoint the web detail page hits.
    func loadDetail(id: String) async throws -> TradingAccountsDetail {
        try await AlmaAPI.shared.get("/api/trading/accounts/\(id)/summary")
    }

    // ── Native writes (owner 2026-07-11: account create/edit/archive goes native;
    //    web TradingAccountModal payload verbatim). ──

    var toast: String? = nil
    var staff: [TradingAccountsStaff] = []

    struct AccountPayload: Encodable {
        let accountTitle: String
        let binanceUid: String
        let accountType: String
        let status: String
        let startingCapital: Double
        let merchantTarget: Double?
        let commissionType: String
        let commissionRate: Double
        let fixedCommission: Double
        let completionBonus: Double
        let startDate: String
        let assignedUserId: String?
        let notes: String
        let partnershipEnabled: Bool
        let staffSharePercent: Double
        var action: String? = nil          // PATCH-only: "update" | "archive"
    }
    private struct SaveResponse: Decodable {
        let ok: Bool?, error: String?
    }

    /// GET /api/trading/staff — assignment picker (web loads it for the modal).
    func loadStaff() async {
        struct StaffResponse: Decodable { let staff: [TradingAccountsStaff]? }
        if let r: StaffResponse = try? await AlmaAPI.shared.get("/api/trading/staff") {
            staff = r.staff ?? []
        }
    }

    /// Create (POST) or update (PATCH) — returns success, reloads the list.
    func saveAccount(_ payload: AccountPayload, editingId: String?) async -> Bool {
        do {
            let res: SaveResponse
            if let editingId {
                res = try await AlmaAPI.shared.send("PATCH", "/api/trading/accounts/\(editingId)", body: payload)
            } else {
                res = try await AlmaAPI.shared.send("POST", "/api/trading/accounts", body: payload)
            }
            guard res.ok ?? false else {
                toast = res.error ?? "Could not save account"
                return false
            }
            toast = editingId == nil ? "Trading account created" : "Trading account updated"
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

    /// Archive — the web sends PATCH {action:'archive'}.
    func archiveAccount(_ row: TradingAccountsRow) async -> Bool {
        struct ArchiveBody: Encodable { let action = "archive" }
        do {
            let res: SaveResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/trading/accounts/\(row.id)", body: ArchiveBody())
            guard res.ok ?? false else {
                toast = res.error ?? "Archive হয়নি"
                return false
            }
            toast = "অ্যাকাউন্ট archive হয়েছে"
            await load()
            return true
        } catch {
            toast = error.localizedDescription
            return false
        }
    }
}

/// GET /api/trading/staff rows (web TradingUser: id/name/role).
struct TradingAccountsStaff: Decodable, Identifiable {
    let id: String
    let name: String
    let role: String?
    private enum Keys: String, CodingKey { case id, name, role }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        role = try? c.decodeIfPresent(String.self, forKey: .role)
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct TradingAccountsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = TradingAccountsVM()
    @State private var selected: TradingAccountsRow? = nil
    @State private var searchDebounce: Task<Void, Never>? = nil
    @State private var showCreate = false
    @State private var editing: TradingAccountsRow? = nil
    @State private var archiving: TradingAccountsRow? = nil
    let openWeb: (_ path: String, _ title: String) -> Void
    /// IOSP-1 typed deep link (/trading/accounts/{id}): auto-open this account's
    /// detail sheet once the list loads — same pattern as EmployeesScreen.focusEmpId.
    var focusAccountId: String? = nil

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                heroBoard
                newAccountButton
                searchRow
                statusChips
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.accounts.isEmpty { loadingRows }
                ForEach(vm.accounts) { a in
                    TradingAccountsRowCard(account: a) {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        selected = a
                    }
                    .contextMenu {
                        Button { editing = a } label: { Label("সম্পাদনা", systemImage: "pencil") }
                        Button(role: .destructive) { archiving = a } label: {
                            Label("Archive", systemImage: "archivebox")
                        }
                    }
                }
                if !vm.loading && vm.accounts.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(TradingAccountsAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task {
            await vm.load(); await vm.loadStaff()
            // Deep link: auto-open the focused account once the list is in.
            if let fid = focusAccountId, selected == nil {
                selected = vm.accounts.first { $0.id == fid }
            }
        }
        .sheet(item: $selected) { a in
            TradingAccountsDetailSheet(row: a, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showCreate) { TradingAccountsFormSheet(vm: vm, editing: nil) }
        .sheet(item: $editing) { row in TradingAccountsFormSheet(vm: vm, editing: row) }
        .confirmationDialog(
            "\"\(archiving?.accountTitle ?? "")\" archive করবেন? Active list থেকে সরে যাবে।",
            isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } }),
            titleVisibility: .visible
        ) {
            Button("হ্যাঁ, archive করুন", role: .destructive) {
                if let row = archiving { Task { _ = await vm.archiveAccount(row) } }
                archiving = nil
            }
            Button("বাতিল", role: .cancel) { archiving = nil }
        }
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

    /// Web header "Create trading account" button — native form sheet.
    private var newAccountButton: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            showCreate = true
        } label: {
            Label("নতুন trading account", systemImage: "plus.circle.fill")
                .font(.caption.weight(.bold))
                .foregroundStyle(TradingAccountsPalette.accentText(colorScheme))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(TradingAccountsPalette.coral.opacity(0.10),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .strokeBorder(TradingAccountsPalette.coral.opacity(0.3), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Bento board (list columns rolled up: balance hero + capital/expense tiles) ──

    private var heroBoard: some View {
        VStack(spacing: 10) {
            TradingAccountsHeroCard(balance: vm.totalBalance,
                                    accounts: vm.accounts.count,
                                    active: vm.activeCount,
                                    profit: vm.totalProfit)
            HStack(spacing: 10) {
                TradingAccountsStatTile(label: "Initial capital", value: vm.totalCapital,
                                        format: { AlmaSwiftTheme.takaShort($0) },
                                        sub: "সব অ্যাকাউন্টের মূলধন",
                                        tint: TradingAccountsPalette.accentText(colorScheme),
                                        accent: TradingAccountsPalette.coral)
                TradingAccountsStatTile(label: "Expenses", value: vm.totalExpenses,
                                        format: { AlmaSwiftTheme.takaShort($0) },
                                        sub: "মোট অপারেটিং খরচ",
                                        tint: colorScheme == .dark ? TradingAccountsPalette.amber500
                                                                   : TradingAccountsPalette.amber600,
                                        accent: TradingAccountsPalette.amber500)
            }
        }
        .padding(.top, 4)
    }

    // ── Search (web SearchInput: title / UID / staff, server-side, debounced) ──

    private var searchRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search title, UID, staff…", text: Binding(
                get: { vm.search },
                set: { newValue in
                    vm.search = newValue
                    searchDebounce?.cancel()
                    searchDebounce = Task { // server-side search, debounced
                        try? await Task.sleep(nanoseconds: 450_000_000)
                        if !Task.isCancelled { await vm.load() }
                    }
                }))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Status chips (web Select → chips: All/Active/Paused/Completed/Closed) ──

    private var statusChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TradingAccountsVM.statusOptions, id: \.value) { opt in
                    chip(opt.label,
                         tint: opt.value == "ALL" ? TradingAccountsPalette.sage
                             : TradingAccountsPalette.status(opt.value, colorScheme),
                         active: vm.status == opt.value) {
                        vm.status = opt.value
                        Task { await vm.load() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func chip(_ label: String, tint: Color, active: Bool,
                      action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label).font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? tint : .secondary)
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

    // ── Shared bits ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(TradingAccountsPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        ForEach(0..<5, id: \.self) { _ in
            Color.clear.frame(height: 96)
                .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .tradingAccountsShimmer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "creditcard").font(.largeTitle).foregroundStyle(.secondary)
            Text("কোনো ট্রেডিং অ্যাকাউন্ট নেই").foregroundStyle(.secondary)
            Text("অ্যাকাউন্ট তৈরি / এডিট ওয়েবে হয়").font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 60)
        .padding(.bottom, 30)
    }

    private var webEscape: some View {
        Button {
            openWeb("/trading/accounts", "Trading accounts")
        } label: {
            Label("সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Row (web mobile card: title + 50/50 pill · staff · UID · balance · progress)

@available(iOS 17.0, *)
private struct TradingAccountsRowCard: View {
    let account: TradingAccountsRow
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(account.accountTitle)
                            .font(.subheadline.weight(.semibold)).lineLimit(1)
                        if account.partnershipEnabled == true { partnershipPill }
                    }
                    Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 6)
                statusPill
            }
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("BALANCE").font(.system(size: 8, weight: .bold)).tracking(0.4)
                        .foregroundStyle(.secondary)
                    Text(TradingAccountsFormat.taka(account.currentBalance ?? 0))
                        .font(.footnote.weight(.bold).monospacedDigit())
                        .foregroundStyle(TradingAccountsPalette.balance(account.currentBalance ?? 0, colorScheme))
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 1) {
                    Text("PROFIT").font(.system(size: 8, weight: .bold)).tracking(0.4)
                        .foregroundStyle(.secondary)
                    Text(TradingAccountsFormat.taka(account.totalProfit ?? 0))
                        .font(.footnote.weight(.bold).monospacedDigit())
                        .foregroundStyle(TradingAccountsPalette.signed(account.totalProfit ?? 0, colorScheme))
                }
            }
            progressLine
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture(perform: onTap)
    }

    private var subtitle: String {
        var bits: [String] = []
        bits.append(account.assignedUserName ?? "Unassigned")
        bits.append(account.binanceUid?.isEmpty == false ? account.binanceUid! : "No UID")
        if let t = account.accountType, !t.isEmpty { bits.append(t.replacingOccurrences(of: "_", with: " ")) }
        return bits.joined(separator: " · ")
    }

    /// Web 50/50 partnership pill — gold, with the net-staff-owes hint when non-zero.
    private var partnershipPill: some View {
        let tint = TradingAccountsPalette.accentText(colorScheme)
        let owed = account.partnershipNetStaffOwes ?? 0
        return HStack(spacing: 3) {
            Text("50/50")
            if owed != 0 {
                Text("· ৳\(Int(abs(owed).rounded()).formatted())")
            }
        }
        .font(.system(size: 9, weight: .bold))
        .foregroundStyle(tint)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(tint.opacity(0.10), in: Capsule())
        .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
    }

    private var statusPill: some View {
        let tint = TradingAccountsPalette.status(account.status, colorScheme)
        return Text(account.status ?? "—")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(tint.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
    }

    /// Web goal-progress cell (Progress + N%).
    private var progressLine: some View {
        let pct = min(max(account.merchantProgress ?? 0, 0), 100)
        return HStack(spacing: 8) {
            TradingAccountsProgressBar(value: pct,
                                       tint: TradingAccountsPalette.accentText(colorScheme))
            Text("\(Int(pct.rounded()))%")
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }
}

@available(iOS 17.0, *)
private struct TradingAccountsProgressBar: View {
    let value: Double            // 0…100
    let tint: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                Capsule().fill(tint)
                    .frame(width: geo.size.width * CGFloat(value) / 100)
            }
        }
        .frame(height: 5)
    }
}

// MARK: - Detail sheet (web /trading/accounts/[id] parity, read-only)

@available(iOS 17.0, *)
private struct TradingAccountsDetailSheet: View {
    let row: TradingAccountsRow
    let vm: TradingAccountsVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var detail: TradingAccountsDetail? = nil
    @State private var loading = true
    @State private var loadError: String? = nil
    /// NP-6: web hides approve/reject-delete from non-SUPER_ADMIN — same owner
    /// probe the Dashboard dock uses (owner-only route answers 403 to others).
    @State private var superAdmin = false

    private var account: TradingAccountsRow { detail?.account ?? row }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                if loading {
                    loadingBlock
                } else if let err = loadError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(TradingAccountsPalette.red500)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                } else if let summary = detail?.summary {
                    if summary.currentBalance < 0 { riskWarning }
                    kpiGrid(summary)
                    accountCard(summary)
                    if account.partnershipEnabled == true { partnershipCard }
                    if let today = detail?.today { todayCard(today) }
                    if let ranges = detail?.ranges { rangesStrip(ranges) }
                    recentTradesCard
                    recentExpensesCard
                    // NP-6 (TR-01/TR-02): trades admin · daily summary · screenshot
                    // history/upload · partnership settlement — all native.
                    TradingAccountAdminSection(
                        accountId: account.id,
                        accountTitle: account.accountTitle,
                        partnershipEnabled: account.partnershipEnabled == true,
                        isSuperAdmin: superAdmin)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                }
                webLink
            }
            .padding(18)
        }
        .presentationBackground { TradingAccountsAurora() }
        .task {
            do {
                detail = try await vm.loadDetail(id: row.id)
                // Owner probe (403 for everyone else) — gates approve/reject-delete UI.
                struct TodosEnvelope: Decodable {}
                if let _: TodosEnvelope = try? await AlmaAPI.shared.get("/api/assistant/todos") {
                    superAdmin = true
                }
                if detail?.summary == nil { loadError = "অ্যাকাউন্ট ডেটা পাওয়া যায়নি" }
            } catch {
                if !TradingAccountsVM.isCancellation(error) {
                    loadError = error.localizedDescription
                }
            }
            loading = false
        }
    }

    // ── The ONE spinner while the summary loads (AlmaStarburstSpinner family) ──

    private var loadingBlock: some View {
        HStack(spacing: 10) {
            AlmaStarburstLoader(mode: .searching, size: 22)
            Text("লোড হচ্ছে…").font(.footnote).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(TradingAccountsFormat.initials(account.accountTitle))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TradingAccountsPalette.sage)
                .frame(width: 44, height: 44)
                .background(TradingAccountsPalette.sage.opacity(0.16), in: Circle())
                .overlay(Circle().strokeBorder(TradingAccountsPalette.sage.opacity(0.35), lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(account.accountTitle).font(.headline)
                Text("\(account.binanceUid?.isEmpty == false ? account.binanceUid! : "No UID") · \(account.assignedUserName ?? "Unassigned")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            statusPill(account.status ?? "—")
        }
    }

    private func statusPill(_ status: String) -> some View {
        let tint = TradingAccountsPalette.status(status, colorScheme)
        return Text(status)
            .font(.caption2.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 1))
    }

    /// Web tone-red risk card when the balance dips below zero.
    private var riskWarning: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Risk warning: account balance is negative.")
                .font(.footnote.weight(.bold))
                .foregroundStyle(colorScheme == .dark ? TradingAccountsPalette.red400
                                                      : TradingAccountsPalette.red500)
            Text("ব্যালেন্স শূন্যের নিচে নামলে Super Admin নোটিফিকেশন তৈরি হয়")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(TradingAccountsPalette.red500.opacity(colorScheme == .dark ? 0.14 : 0.08),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(TradingAccountsPalette.red500.opacity(0.35), lineWidth: 1))
    }

    // ── KPI grid (web 2 KpiCard rows: balance/capital/trades/USDT/profit/loss/…)  ──

    private func kpiGrid(_ s: TradingAccountsSummary) -> some View {
        let cols = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
        return LazyVGrid(columns: cols, spacing: 10) {
            statCell("Current balance", TradingAccountsFormat.taka(s.currentBalance),
                     TradingAccountsPalette.balance(s.currentBalance, colorScheme))
            statCell("Initial capital", TradingAccountsFormat.taka(s.startingCapital),
                     TradingAccountsPalette.accentText(colorScheme))
            statCell("Total trades", "\(s.totalTrades)", .primary)
            statCell("USDT balance", TradingAccountsFormat.usdt(s.usdtBalance), .primary)
            statCell("Total profit", TradingAccountsFormat.taka(s.totalProfit),
                     TradingAccountsPalette.signed(1, colorScheme))
            statCell("Total loss", TradingAccountsFormat.taka(s.totalLoss),
                     TradingAccountsPalette.signed(-1, colorScheme))
            statCell("Expenses", TradingAccountsFormat.taka(s.totalExpenses),
                     colorScheme == .dark ? TradingAccountsPalette.amber500 : TradingAccountsPalette.amber600)
            statCell("Withdrawals", TradingAccountsFormat.taka(s.totalWithdrawals), .secondary)
            statCell("ROI", String(format: "%.2f%%", s.roiPct),
                     TradingAccountsPalette.signed(s.roiPct, colorScheme))
            statCell("Net P/L", TradingAccountsFormat.taka(s.netOperationalProfit),
                     TradingAccountsPalette.signed(s.netOperationalProfit, colorScheme))
        }
    }

    private func statCell(_ label: String, _ value: String, _ tint: Color) -> some View {
        VStack(spacing: 3) {
            Text(value).font(.subheadline.weight(.bold).monospacedDigit()).foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.6)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Account card (web left card: type/start · staff · commission · capital rows) ──

    private func accountCard(_ s: TradingAccountsSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ACCOUNT").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            statRow("Type", (account.accountType ?? "—").replacingOccurrences(of: "_", with: " "))
            statRow("Started", TradingAccountsFormat.day(account.startDate))
            statRow("Assigned staff", account.assignedUserName ?? "Unassigned")
            statRow("Commission", commissionLabel)
            statRow("Deposits", TradingAccountsFormat.taka(s.deposits))
            statRow("Withdrawals", TradingAccountsFormat.taka(s.totalWithdrawals))
            statRow("Adjustments", TradingAccountsFormat.taka(s.adjustments))
            statRow("Net ROI", String(format: "%.2f%%", s.roiPct),
                    tint: TradingAccountsPalette.signed(s.roiPct, colorScheme))
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("Merchant goal progress").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text("\(Int(min(max(s.merchantProgress, 0), 100).rounded()))%")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(TradingAccountsPalette.accentText(colorScheme))
                }
                TradingAccountsProgressBar(value: min(max(s.merchantProgress, 0), 100),
                                           tint: TradingAccountsPalette.accentText(colorScheme))
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var commissionLabel: String {
        switch account.commissionType {
        case "PERCENTAGE": return String(format: "%.2f%% of profit", account.commissionRate ?? 0)
        case "FIXED": return TradingAccountsFormat.taka(account.fixedCommission ?? 0)
        default: return "None"
        }
    }

    // ── Partnership (web 50/50 blocks — settle stays on the web) ──

    private var partnershipCard: some View {
        let tint = TradingAccountsPalette.accentText(colorScheme)
        let owed = account.partnershipNetStaffOwes
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("PARTNERSHIP").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                Text("50/50").font(.system(size: 9, weight: .bold)).foregroundStyle(tint)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(tint.opacity(0.10), in: Capsule())
                    .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
            }
            statRow("Staff share", String(format: "%.0f%%", account.staffSharePercent ?? 50))
            if let owed {
                statRow("Net staff owes", TradingAccountsFormat.taka(owed),
                        tint: owed > 0 ? (colorScheme == .dark ? TradingAccountsPalette.amber500
                                                               : TradingAccountsPalette.amber600)
                                       : TradingAccountsPalette.signed(1, colorScheme))
            }
            statRow("Last settled", TradingAccountsFormat.day(account.lastPartnershipSettledAt))
            Text("সেটেলমেন্ট ওয়েবে হয়").font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Today Summary (web right card: trades / buy / sell / profit / loss / net) ──

    private func todayCard(_ t: TradingAccountsDay) -> some View {
        let cols = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8),
                    GridItem(.flexible(), spacing: 8)]
        return VStack(alignment: .leading, spacing: 10) {
            Text("TODAY SUMMARY").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            LazyVGrid(columns: cols, spacing: 8) {
                todayCell("Trades", "\(t.tradesCount)", .primary)
                todayCell("Buy USDT", TradingAccountsFormat.usdt(t.buyUsdtVolume), .primary)
                todayCell("Sell USDT", TradingAccountsFormat.usdt(t.sellUsdtVolume), .primary)
                todayCell("Profit", TradingAccountsFormat.taka(t.profit),
                          TradingAccountsPalette.signed(1, colorScheme))
                todayCell("Loss", TradingAccountsFormat.taka(t.loss),
                          TradingAccountsPalette.signed(-1, colorScheme))
                todayCell("Fees", TradingAccountsFormat.taka(t.fees),
                          colorScheme == .dark ? TradingAccountsPalette.amber500 : TradingAccountsPalette.amber600)
                todayCell("Expenses", TradingAccountsFormat.taka(t.expenses),
                          TradingAccountsPalette.signed(-1, colorScheme))
                todayCell("Net result", TradingAccountsFormat.taka(t.netResult),
                          TradingAccountsPalette.signed(t.netResult, colorScheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func todayCell(_ label: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(.system(size: 8, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.7)
            Text(value).font(.caption.weight(.bold).monospacedDigit()).foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Color.primary.opacity(0.04),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // ── Ranges strip (web: Today / Yesterday / Last 7 days / currentMonth cards) ──

    private func rangesStrip(_ r: TradingAccountsRanges) -> some View {
        let items: [(String, TradingAccountsDay)] = [
            ("Today", r.today), ("Yesterday", r.yesterday),
            ("Last 7 days", r.last7), ("This month", r.currentMonth),
        ].compactMap { label, day in day.map { (label, $0) } }
        let cols = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
        return LazyVGrid(columns: cols, spacing: 10) {
            ForEach(items, id: \.0) { label, day in
                VStack(alignment: .leading, spacing: 3) {
                    Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.4)
                        .foregroundStyle(.secondary)
                    Text(TradingAccountsFormat.taka(day.netResult))
                        .font(.subheadline.weight(.bold).monospacedDigit())
                        .foregroundStyle(TradingAccountsPalette.signed(day.netResult, colorScheme))
                        .lineLimit(1).minimumScaleFactor(0.6)
                    Text("\(day.tradesCount) trades · \(TradingAccountsFormat.usdt(day.usdtVolume)) USDT")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            }
        }
    }

    // ── Recent trades (web TRADES tab, read-only slice) ──

    @ViewBuilder private var recentTradesCard: some View {
        let trades = detail?.recentTrades ?? []
        VStack(alignment: .leading, spacing: 10) {
            Text("RECENT TRADES").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if trades.isEmpty {
                Text("কোনো ট্রেড নেই").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(trades.prefix(10)) { t in
                    HStack(spacing: 8) {
                        Text(t.tradeType)
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(t.tradeType == "BUY"
                                ? TradingAccountsPalette.accentText(colorScheme)
                                : TradingAccountsPalette.signed(1, colorScheme))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background((t.tradeType == "BUY"
                                ? TradingAccountsPalette.coral
                                : TradingAccountsPalette.green400).opacity(0.13), in: Capsule())
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(TradingAccountsFormat.usdt(t.usdtAmount)) USDT")
                                .font(.caption.weight(.semibold).monospacedDigit())
                                .strikethrough(t.deletedAt != nil)
                            Text(TradingAccountsFormat.dateTime(t.tradeDate))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        // Web: BUY rows show muted P/L, SELL rows signed green/red.
                        Text(TradingAccountsFormat.taka(t.netProfit))
                            .font(.caption.weight(.bold).monospacedDigit())
                            .foregroundStyle(t.tradeType == "BUY" ? .secondary
                                : TradingAccountsPalette.signed(t.netProfit, colorScheme))
                    }
                    .opacity(t.deletedAt == nil ? 1 : 0.55)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Recent expenses (web EXPENSES tab, read-only slice) ──

    @ViewBuilder private var recentExpensesCard: some View {
        let expenses = detail?.recentExpenses ?? []
        if !expenses.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("RECENT EXPENSES").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                ForEach(expenses.prefix(8)) { e in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(e.expenseType).font(.caption.weight(.semibold)).lineLimit(1)
                            Text(TradingAccountsFormat.day(e.expenseDate))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if account.partnershipEnabled == true, let by = e.paidBy {
                            Text(by == "OWNER" ? "Owner" : "Staff")
                                .font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Color.primary.opacity(0.06), in: Capsule())
                        }
                        Text(TradingAccountsFormat.taka(e.amount))
                            .font(.caption.weight(.bold).monospacedDigit())
                            .foregroundStyle(TradingAccountsPalette.signed(-1, colorScheme))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .tradingAccountsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    private func statRow(_ label: String, _ value: String, tint: Color = .primary) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.bold)).foregroundStyle(tint)
                .multilineTextAlignment(.trailing)
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/trading/accounts/\(row.id)", row.accountTitle)
        } label: {
            Label("সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Formatting helpers

private enum TradingAccountsFormat {
    /// Web Money: ৳ + en-BD grouping, whole taka.
    static func taka(_ v: Double) -> String {
        "৳\(Int(v.rounded()).formatted())"
    }

    /// USDT volumes — up to 2 decimals, grouped.
    static func usdt(_ v: Double) -> String {
        v.formatted(.number.precision(.fractionLength(0...2)))
    }

    /// ISO date → yyyy-MM-dd (web startDate.slice(0, 10)).
    static func day(_ iso: String?) -> String {
        guard let iso, iso.count >= 10 else { return "—" }
        return String(iso.prefix(10))
    }

    /// ISO datetime → "yyyy-MM-dd HH:mm".
    static func dateTime(_ iso: String?) -> String {
        guard let iso, iso.count >= 16 else { return day(iso) }
        return String(iso.prefix(16)).replacingOccurrences(of: "T", with: " ")
    }

    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (page-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct TradingAccountsAurora: View {
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
    func tradingAccountsGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct TradingAccountsShimmer: ViewModifier {
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
    func tradingAccountsShimmer() -> some View { modifier(TradingAccountsShimmer()) }
}

// MARK: - Bento components (page-owned copies of the Dashboard board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func tradingAccountsMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct TradingAccountsCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        TradingAccountsCountUpText(value: shown, format: format)
            .animation(tradingAccountsMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if tradingAccountsMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct TradingAccountsCountUpText: View, Animatable {
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
private func tradingAccountsBentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
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
private struct TradingAccountsStatTile: View {
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
            TradingAccountsCountUp(target: value, format: format)
                .font(.system(size: 17, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background { tradingAccountsBentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
/// deep indigo base + violet/coral washes + a sage hint). Combined-balance count-up
/// plus the Accounts / Active / Profit split — the web table's roll-up numbers.
@available(iOS 17.0, *)
private struct TradingAccountsHeroCard: View {
    let balance: Int
    let accounts: Int
    let active: Int
    let profit: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("মোট ব্যালেন্স · TRADING").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(TradingAccountsPalette.sage)
            TradingAccountsCountUp(target: balance, format: { AlmaSwiftTheme.takaShort($0) })
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(balance < 0 ? TradingAccountsPalette.red400 : .white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            Text("সব ট্রেডিং অ্যাকাউন্টের কারেন্ট ব্যালেন্স")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Accounts", value: accounts, format: { "\($0)" },
                         tint: .white, sub: "মোট অ্যাকাউন্ট")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Active", value: active, format: { "\($0)" },
                         tint: TradingAccountsPalette.sage, sub: "চালু আছে")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Profit", value: profit, format: { AlmaSwiftTheme.takaShort($0) },
                         tint: TradingAccountsPalette.green400, sub: "মোট প্রফিট")
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
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.32), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.sage.opacity(0.30), .clear],
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

    private func heroStat(label: String, value: Int, format: @escaping (Int) -> String,
                          tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            TradingAccountsCountUp(target: value, format: format)
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Trading Accounts — Light") {
    TradingAccountsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}

// MARK: - Create / edit form (owner 2026-07-11: native writes — web TradingAccountModal
// parity: same fields, same payload, partnership + commission blocks included).

@available(iOS 17.0, *)
private struct TradingAccountsFormSheet: View {
    let vm: TradingAccountsVM
    let editing: TradingAccountsRow?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    @State private var accountTitle = ""
    @State private var startingCapital = ""
    @State private var accountType = "BINANCE_P2P"
    @State private var binanceUid = ""
    @State private var merchantTarget = ""
    @State private var status = "ACTIVE"
    @State private var assignedUserId = ""
    @State private var partnershipEnabled = false
    @State private var staffSharePercent = "50"
    @State private var commissionType = "NONE"
    @State private var commissionRate = ""
    @State private var fixedCommission = ""
    @State private var completionBonus = ""
    @State private var notes = ""
    @State private var startDate = Date()
    @State private var submitting = false
    @State private var errorText: String? = nil
    @State private var confirming = false

    private func num(_ s: String) -> Double { Double(s.replacingOccurrences(of: ",", with: "")) ?? 0 }
    private var canSubmit: Bool {
        !accountTitle.trimmingCharacters(in: .whitespaces).isEmpty && num(startingCapital) > 0
    }
    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(editing == nil ? "Create trading account" : "Edit trading account")
                        .font(.subheadline.weight(.bold))
                    Text("নিজস্ব capital, staff, খরচ ও ROI-সহ স্বাধীন merchant wallet।")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Close") { dismiss() }
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .buttonStyle(.plain)
            }
            .padding(.horizontal, 18).padding(.top, 20).padding(.bottom, 12)
            Divider().opacity(0.4)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    field("Account Name *", text: $accountTitle, keyboard: .default)
                    field("Initial Capital (BDT) *", text: $startingCapital)
                    labeledPicker("Account type", selection: $accountType, options: [
                        ("Binance P2P", "BINANCE_P2P"), ("Merchant", "MERCHANT"),
                        ("Staff operated", "STAFF_OPERATED"), ("Other", "OTHER"),
                    ])
                    field("Binance UID", text: $binanceUid, keyboard: .default)
                    field("Merchant Goal / Monthly Target", text: $merchantTarget)
                    labeledPicker("Status", selection: $status, options: [
                        ("Active", "ACTIVE"), ("Paused", "PAUSED"),
                        ("Completed", "COMPLETED"), ("Closed", "CLOSED"),
                    ])
                    staffPicker
                    DatePicker("Start date", selection: $startDate, displayedComponents: .date)
                        .font(.subheadline)

                    // Partnership block (web: 50-50 loss share).
                    VStack(alignment: .leading, spacing: 10) {
                        Text("PARTNERSHIP / 50-50 LOSS SHARE")
                            .font(.system(size: 9, weight: .bold)).tracking(1).foregroundStyle(.secondary)
                        Toggle("Enable partnership settlement", isOn: $partnershipEnabled)
                            .font(.subheadline)
                            .tint(TradingAccountsPalette.coral)
                        if partnershipEnabled {
                            field("Staff share % (default 50)", text: $staffSharePercent)
                            Text("Partnership ON হলে trade commission auto-disable হবে — loss/expense settlement আলাদা হিসাবে হবে।")
                                .font(.caption2)
                                .foregroundStyle(scheme == .dark ? TradingAccountsPalette.amber500
                                                                 : TradingAccountsPalette.amber600)
                        }
                    }
                    .padding(12)
                    .background(Color.primary.opacity(0.04),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))

                    // Commission block (disabled while partnership on — web parity).
                    VStack(alignment: .leading, spacing: 10) {
                        Text("OPTIONAL STAFF COMMISSION")
                            .font(.system(size: 9, weight: .bold)).tracking(1).foregroundStyle(.secondary)
                        if partnershipEnabled {
                            Text("Commission disabled while partnership is active.")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Group {
                            labeledPicker("Commission type", selection: $commissionType, options: [
                                ("No commission", "NONE"), ("Percentage of profit", "PERCENTAGE"),
                                ("Fixed per profitable sell", "FIXED"),
                            ])
                            field("Commission % of profit", text: $commissionRate)
                            field("Fixed commission BDT", text: $fixedCommission)
                            field("Merchant completion bonus BDT", text: $completionBonus)
                        }
                        .disabled(partnershipEnabled)
                        .opacity(partnershipEnabled ? 0.5 : 1)
                    }
                    .padding(12)
                    .background(Color.primary.opacity(0.04),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))

                    field("Notes", text: $notes, keyboard: .default)
                    Text("Wallet formula: Initial Capital + Net Profit - Expenses - Withdrawals. Account expenses also feed global finance and management reports.")
                        .font(.caption2).foregroundStyle(.secondary)
                    if let errorText {
                        Text(errorText).font(.caption2.weight(.semibold))
                            .foregroundStyle(TradingAccountsPalette.red500)
                    }
                }
                .padding(18)
            }
            .scrollDismissesKeyboard(.interactively)

            Divider().opacity(0.4)
            Button {
                confirming = true
            } label: {
                HStack(spacing: 8) {
                    if submitting { ProgressView().tint(.white) }
                    Text(submitting ? "Saving…" : "Save account").font(.subheadline.weight(.bold))
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
        .onAppear(perform: prefill)
        .confirmationDialog(
            editing == nil
                ? "\"\(accountTitle)\" তৈরি করবেন? Capital \(AlmaSwiftTheme.takaShort(Int(num(startingCapital).rounded())))"
                : "\"\(accountTitle)\" আপডেট করবেন?",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, সেভ করুন") { submit() }
            Button("বাতিল", role: .cancel) {}
        }
    }

    private func prefill() {
        guard let a = editing else { return }
        accountTitle = a.accountTitle
        startingCapital = a.startingCapital.map { String(format: "%.0f", $0) } ?? ""
        accountType = a.accountType ?? "BINANCE_P2P"
        binanceUid = a.binanceUid ?? ""
        merchantTarget = a.merchantTarget.map { String(format: "%.0f", $0) } ?? ""
        status = a.status ?? "ACTIVE"
        assignedUserId = a.assignedUserId ?? ""
        partnershipEnabled = a.partnershipEnabled ?? false
        staffSharePercent = a.staffSharePercent.map { String(format: "%.0f", $0) } ?? "50"
        commissionType = a.commissionType ?? "NONE"
        commissionRate = a.commissionRate.map { String(format: "%.2f", $0) } ?? ""
        fixedCommission = a.fixedCommission.map { String(format: "%.0f", $0) } ?? ""
        completionBonus = a.completionBonus.map { String(format: "%.0f", $0) } ?? ""
        notes = a.notes ?? ""
        if let s = a.startDate, let d = Self.dateFormatter.date(from: String(s.prefix(10))) {
            startDate = d
        }
    }

    private func submit() {
        guard canSubmit, !submitting else { return }
        submitting = true; errorText = nil
        let payload = TradingAccountsVM.AccountPayload(
            accountTitle: accountTitle.trimmingCharacters(in: .whitespaces),
            binanceUid: binanceUid,
            accountType: accountType,
            status: status,
            startingCapital: num(startingCapital),
            merchantTarget: merchantTarget.isEmpty ? nil : num(merchantTarget),
            commissionType: commissionType,
            commissionRate: num(commissionRate),
            fixedCommission: num(fixedCommission),
            completionBonus: num(completionBonus),
            startDate: Self.dateFormatter.string(from: startDate),
            assignedUserId: assignedUserId.isEmpty ? nil : assignedUserId,
            notes: notes,
            partnershipEnabled: partnershipEnabled,
            staffSharePercent: num(staffSharePercent) > 0 ? num(staffSharePercent) : 50,
            action: editing == nil ? nil : "update")
        Task {
            defer { submitting = false }
            let ok = await vm.saveAccount(payload, editingId: editing?.id)
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { dismiss() } else { errorText = vm.toast }
        }
    }

    // ── Small form atoms ──

    private func field(_ placeholder: String, text: Binding<String>,
                       keyboard: UIKeyboardType = .decimalPad) -> some View {
        TextField(placeholder, text: text)
            .keyboardType(keyboard)
            .font(.subheadline)
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(Color.primary.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }

    private func labeledPicker(_ label: String, selection: Binding<String>,
                               options: [(String, String)]) -> some View {
        Menu {
            ForEach(options, id: \.1) { opt in
                Button(opt.0) { selection.wrappedValue = opt.1 }
            }
        } label: {
            HStack {
                Text(options.first(where: { $0.1 == selection.wrappedValue })?.0 ?? label)
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

    private var staffPicker: some View {
        Menu {
            Button("Unassigned") { assignedUserId = "" }
            ForEach(vm.staff) { s in
                Button("\(s.name)\(s.role.map { " · \($0)" } ?? "")") { assignedUserId = s.id }
            }
        } label: {
            HStack {
                Text(assignedUserId.isEmpty
                     ? "Unassigned"
                     : (vm.staff.first(where: { $0.id == assignedUserId })?.name ?? "Staff"))
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Image(systemName: "person.crop.circle").font(.caption)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(Color.primary.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        }
    }
}
