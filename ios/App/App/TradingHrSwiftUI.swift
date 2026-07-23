//
//  TradingHrSwiftUI.swift
//  ALMA ERP — the Trading HR page (/trading/hr) as a native SwiftUI screen.
//
//  Mirrors the web page read surface — same endpoints, same colours, same blocks:
//    GET /api/trading/hr                          → { employees, alerts, rankings, kpis }
//    GET /api/trading/staff-summary               → { staff }   (monthly performance)
//    GET /api/trading/hr/reports?userId=&limit=40 → { reports } (daily reports feed)
//  Web-parity blocks: 8 KPI cards (Employees / Active / Managed accounts / Profit
//  green-400 / Losses red-400 / Commissions gold / Wallet blue-500 / Missing reports
//  amber-500) — recomposed as the bento hero + tiles · employee profile rows (avatar,
//  role · employee link, shift, accounts, trades, net P/L, wallet, consistency) with a
//  native detail sheet (HR profile, metrics, wallet, assigned accounts, that staffer's
//  recent reports) · HR Alert Engine · 5 ranking cards · staff performance summary ·
//  recent daily reports feed. NATIVE WRITES (verified 2026-07-17): HR profile save
//  (POST /api/trading/hr) and daily report submit (POST /api/trading/hr/reports).
//  Carried lessons: lenient per-field decoding, cancellation-safe .refreshable,
//  private renamed aurora/glass/shimmer/bento copies (parallel-session rule).
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum TradingHrPalette {
    static var coral: Color { AlmaSwiftTheme.coral }
    /// Trading accent — the ALMA sage green (#81B29A) the trading pages lead with.
    static let sage = Color(red: 0.51, green: 0.70, blue: 0.60)
    static var goldLt: Color { AlmaSwiftTheme.accentLt }
    static var goldDim: Color { AlmaSwiftTheme.accentDim }
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let red400 = Color(red: 0.973, green: 0.443, blue: 0.443)         // #F87171
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let blue500 = Color(red: 0.231, green: 0.510, blue: 0.965)        // #3B82F6
    static let slate400 = Color(red: 0.580, green: 0.639, blue: 0.722)       // #94A3B8

    /// The web's gold-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
    /// Green tint that stays legible on both canvases.
    static func green(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? green400 : emerald600
    }
    /// Amber tint pair.
    static func amber(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? amber500 : amber600
    }
    /// Web signedClass: positive green · negative red · zero muted.
    static func signed(_ value: Int, _ scheme: ColorScheme) -> Color {
        if value > 0 { return green(scheme) }
        if value < 0 { return red400 }
        return .secondary
    }
    /// Alert severity tints (web renders tone-amber for all — keep CRITICAL red).
    static func severity(_ s: String?, _ scheme: ColorScheme) -> Color {
        switch s {
        case "CRITICAL": return red500
        case "HIGH": return amber(scheme)
        default: return amber(scheme)
        }
    }
}

// MARK: - Lenient decode helpers (Prisma Decimals serialize as strings)

private func tradingHrFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) {
        if let i = Int(s) { return i }
        if let d = Double(s) { return Int(d.rounded()) }
    }
    return nil
}

private func tradingHrFlexDouble<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
    return nil
}

// MARK: - Models (same field names src/types/trading.ts declares — camelCase wire)

private struct TradingHrUser: Decodable, Equatable {
    let id: String
    let name: String
    let email: String?
    let phone: String?
    let role: String?
    let employeeIdGas: String?
    let joiningDate: String?

    private enum Keys: String, CodingKey {
        case id, name, email, phone, role, employeeIdGas, joiningDate
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        role = try? c.decodeIfPresent(String.self, forKey: .role)
        employeeIdGas = try? c.decodeIfPresent(String.self, forKey: .employeeIdGas)
        joiningDate = try? c.decodeIfPresent(String.self, forKey: .joiningDate)
    }
}

private struct TradingHrProfile: Decodable, Equatable {
    let employeeIdGas: String?
    let roleTitle: String?
    let shift: String?
    let status: String?
    let salary: Int
    let commissionType: String?
    let commissionRate: Double
    let fixedCommission: Int
    let merchantCompletionBonus: Int
    let milestoneBonus: Int
    let notes: String?
    let joiningDate: String?          // native edit-form prefill (owner 2026-07-11)

    private enum Keys: String, CodingKey {
        case employeeIdGas, roleTitle, shift, status, salary
        case commissionType, commissionRate, fixedCommission
        case merchantCompletionBonus, milestoneBonus, notes, joiningDate
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        employeeIdGas = try? c.decodeIfPresent(String.self, forKey: .employeeIdGas)
        roleTitle = try? c.decodeIfPresent(String.self, forKey: .roleTitle)
        shift = try? c.decodeIfPresent(String.self, forKey: .shift)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        salary = tradingHrFlexInt(c, .salary) ?? 0
        commissionType = try? c.decodeIfPresent(String.self, forKey: .commissionType)
        commissionRate = tradingHrFlexDouble(c, .commissionRate) ?? 0
        fixedCommission = tradingHrFlexInt(c, .fixedCommission) ?? 0
        merchantCompletionBonus = tradingHrFlexInt(c, .merchantCompletionBonus) ?? 0
        milestoneBonus = tradingHrFlexInt(c, .milestoneBonus) ?? 0
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        joiningDate = try? c.decodeIfPresent(String.self, forKey: .joiningDate)
    }
}

private struct TradingHrAssignedAccount: Decodable, Identifiable, Equatable {
    let id: String
    let accountTitle: String
    let status: String?
    let currentBalance: Int
    let netRoi: Double
    let merchantProgress: Double

    private enum Keys: String, CodingKey {
        case id, accountTitle, status, currentBalance, netRoi, merchantProgress
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        accountTitle = (try? c.decode(String.self, forKey: .accountTitle)) ?? "—"
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        currentBalance = tradingHrFlexInt(c, .currentBalance) ?? 0
        netRoi = tradingHrFlexDouble(c, .netRoi) ?? 0
        merchantProgress = tradingHrFlexDouble(c, .merchantProgress) ?? 0
    }
}

private struct TradingHrMetrics: Decodable, Equatable {
    let totalAccountsManaged: Int
    let activeAccounts: Int
    let totalTrades: Int
    let totalProfitGenerated: Int
    let totalLosses: Int
    let netResult: Int
    let merchantGrowthSuccess: Double
    let activityConsistency: Double
    let reportConsistency: Double
    let inactiveDays: Int
    let todayReportSubmitted: Bool

    private enum Keys: String, CodingKey {
        case totalAccountsManaged, activeAccounts, totalTrades
        case totalProfitGenerated, totalLosses, netResult
        case merchantGrowthSuccess, activityConsistency, reportConsistency
        case inactiveDays, todayReportSubmitted
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        totalAccountsManaged = tradingHrFlexInt(c, .totalAccountsManaged) ?? 0
        activeAccounts = tradingHrFlexInt(c, .activeAccounts) ?? 0
        totalTrades = tradingHrFlexInt(c, .totalTrades) ?? 0
        totalProfitGenerated = tradingHrFlexInt(c, .totalProfitGenerated) ?? 0
        totalLosses = tradingHrFlexInt(c, .totalLosses) ?? 0
        netResult = tradingHrFlexInt(c, .netResult) ?? 0
        merchantGrowthSuccess = tradingHrFlexDouble(c, .merchantGrowthSuccess) ?? 0
        activityConsistency = tradingHrFlexDouble(c, .activityConsistency) ?? 0
        reportConsistency = tradingHrFlexDouble(c, .reportConsistency) ?? 0
        inactiveDays = tradingHrFlexInt(c, .inactiveDays) ?? 0
        todayReportSubmitted = (try? c.decodeIfPresent(Bool.self, forKey: .todayReportSubmitted)) ?? false
    }
}

private struct TradingHrWallet: Decodable, Equatable {
    let totalCommissions: Int
    let totalAdvances: Int
    let totalWithdrawals: Int
    let currentBalance: Int
    let availableWithdrawable: Int

    private enum Keys: String, CodingKey {
        case totalCommissions, totalAdvances, totalWithdrawals
        case currentBalance, availableWithdrawable
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        totalCommissions = tradingHrFlexInt(c, .totalCommissions) ?? 0
        totalAdvances = tradingHrFlexInt(c, .totalAdvances) ?? 0
        totalWithdrawals = tradingHrFlexInt(c, .totalWithdrawals) ?? 0
        currentBalance = tradingHrFlexInt(c, .currentBalance) ?? 0
        availableWithdrawable = tradingHrFlexInt(c, .availableWithdrawable) ?? 0
    }
}

private struct TradingHrEmployeeItem: Decodable, Identifiable, Equatable {
    let user: TradingHrUser
    let profile: TradingHrProfile?
    let assignedAccounts: [TradingHrAssignedAccount]
    let metrics: TradingHrMetrics?
    let wallet: TradingHrWallet?

    var id: String { user.id }

    private enum Keys: String, CodingKey { case user, profile, assignedAccounts, metrics, wallet }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        user = try c.decode(TradingHrUser.self, forKey: .user)
        profile = try? c.decodeIfPresent(TradingHrProfile.self, forKey: .profile)
        assignedAccounts = (try? c.decode([TradingHrAssignedAccount].self, forKey: .assignedAccounts)) ?? []
        metrics = try? c.decodeIfPresent(TradingHrMetrics.self, forKey: .metrics)
        wallet = try? c.decodeIfPresent(TradingHrWallet.self, forKey: .wallet)
    }

    static func == (a: TradingHrEmployeeItem, b: TradingHrEmployeeItem) -> Bool { a.id == b.id }
}

private struct TradingHrAlert: Decodable, Identifiable, Equatable {
    let severity: String
    let type: String
    let userId: String
    let title: String
    let message: String
    let id: String

    private enum Keys: String, CodingKey { case severity, type, userId, title, message }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        severity = (try? c.decode(String.self, forKey: .severity)) ?? "NORMAL"
        type = (try? c.decode(String.self, forKey: .type)) ?? ""
        userId = (try? c.decode(String.self, forKey: .userId)) ?? ""
        title = (try? c.decode(String.self, forKey: .title)) ?? "—"
        message = (try? c.decode(String.self, forKey: .message)) ?? ""
        id = "\(userId)·\(type)·\(title)"
    }
}

private struct TradingHrKpis: Decodable, Equatable {
    let totalEmployees: Int
    let activeEmployees: Int
    let totalManagedAccounts: Int
    let totalProfitGenerated: Int
    let totalLosses: Int
    let totalCommissions: Int
    let totalWalletBalance: Int
    let missingReports: Int

    private enum Keys: String, CodingKey {
        case totalEmployees, activeEmployees, totalManagedAccounts
        case totalProfitGenerated, totalLosses, totalCommissions
        case totalWalletBalance, missingReports
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        totalEmployees = tradingHrFlexInt(c, .totalEmployees) ?? 0
        activeEmployees = tradingHrFlexInt(c, .activeEmployees) ?? 0
        totalManagedAccounts = tradingHrFlexInt(c, .totalManagedAccounts) ?? 0
        totalProfitGenerated = tradingHrFlexInt(c, .totalProfitGenerated) ?? 0
        totalLosses = tradingHrFlexInt(c, .totalLosses) ?? 0
        totalCommissions = tradingHrFlexInt(c, .totalCommissions) ?? 0
        totalWalletBalance = tradingHrFlexInt(c, .totalWalletBalance) ?? 0
        missingReports = tradingHrFlexInt(c, .missingReports) ?? 0
    }
}

private struct TradingHrRankings: Decodable {
    let topTrader: [TradingHrEmployeeItem]
    let mostProfitable: [TradingHrEmployeeItem]
    let lowestLossRatio: [TradingHrEmployeeItem]
    let bestMerchantGrowth: [TradingHrEmployeeItem]
    let mostActive: [TradingHrEmployeeItem]

    private enum Keys: String, CodingKey {
        case topTrader, mostProfitable, lowestLossRatio, bestMerchantGrowth, mostActive
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        topTrader = (try? c.decode([TradingHrEmployeeItem].self, forKey: .topTrader)) ?? []
        mostProfitable = (try? c.decode([TradingHrEmployeeItem].self, forKey: .mostProfitable)) ?? []
        lowestLossRatio = (try? c.decode([TradingHrEmployeeItem].self, forKey: .lowestLossRatio)) ?? []
        bestMerchantGrowth = (try? c.decode([TradingHrEmployeeItem].self, forKey: .bestMerchantGrowth)) ?? []
        mostActive = (try? c.decode([TradingHrEmployeeItem].self, forKey: .mostActive)) ?? []
    }
}

/// GET /api/trading/hr answers flat {employees, alerts, rankings, kpis}; tolerate an
/// {ok, data:{…}} wrap too, like every native screen decoder.
private struct TradingHrResponseModel: Decodable {
    let employees: [TradingHrEmployeeItem]
    let alerts: [TradingHrAlert]
    let rankings: TradingHrRankings?
    let kpis: TradingHrKpis?

    private enum Keys: String, CodingKey { case ok, data, employees, alerts, rankings, kpis }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        employees = (try? c.decode([TradingHrEmployeeItem].self, forKey: .employees)) ?? []
        alerts = (try? c.decode([TradingHrAlert].self, forKey: .alerts)) ?? []
        rankings = try? c.decodeIfPresent(TradingHrRankings.self, forKey: .rankings)
        kpis = try? c.decodeIfPresent(TradingHrKpis.self, forKey: .kpis)
    }
}

// ── Staff performance summary (GET /api/trading/staff-summary) ──

private struct TradingHrStaffSummaryRow: Decodable, Identifiable, Equatable {
    let userId: String
    let name: String
    let assignedAccounts: Int
    let activeAccounts: Int
    let totalManagedCapital: Int
    let totalAccountProfit: Int
    let totalAccountLoss: Int
    let commissionEarned: Int
    let withdrawableBalance: Int
    let monthlyNetResult: Int

    var id: String { userId }

    private enum Keys: String, CodingKey {
        case userId, name, assignedAccounts, activeAccounts, totalManagedCapital
        case totalAccountProfit, totalAccountLoss, commissionEarned
        case withdrawableBalance, monthlyNetResult
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        userId = (try? c.decode(String.self, forKey: .userId)) ?? UUID().uuidString
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        assignedAccounts = tradingHrFlexInt(c, .assignedAccounts) ?? 0
        activeAccounts = tradingHrFlexInt(c, .activeAccounts) ?? 0
        totalManagedCapital = tradingHrFlexInt(c, .totalManagedCapital) ?? 0
        totalAccountProfit = tradingHrFlexInt(c, .totalAccountProfit) ?? 0
        totalAccountLoss = tradingHrFlexInt(c, .totalAccountLoss) ?? 0
        commissionEarned = tradingHrFlexInt(c, .commissionEarned) ?? 0
        withdrawableBalance = tradingHrFlexInt(c, .withdrawableBalance) ?? 0
        monthlyNetResult = tradingHrFlexInt(c, .monthlyNetResult) ?? 0
    }
}

private struct TradingHrStaffSummaryResponse: Decodable {
    let staff: [TradingHrStaffSummaryRow]
    private enum Keys: String, CodingKey { case ok, data, staff }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        staff = (try? c.decode([TradingHrStaffSummaryRow].self, forKey: .staff)) ?? []
    }
}

// ── Daily reports (GET /api/trading/hr/reports?userId=&limit=40) ──

private struct TradingHrDailyReport: Decodable, Identifiable, Equatable {
    let id: String
    let userId: String?
    let reportDate: String?
    let accountIds: [String]
    let totalTrades: Int
    let dailyProfitBdt: Int
    let dailyLossBdt: Int
    let issues: String?
    let operationalNotes: String?
    let submittedAt: String?
    let userName: String?

    private enum Keys: String, CodingKey {
        case id, userId, reportDate, accountIds, totalTrades
        case dailyProfitBdt, dailyLossBdt, issues, operationalNotes, submittedAt, user
    }
    private enum UserKeys: String, CodingKey { case name }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        userId = try? c.decodeIfPresent(String.self, forKey: .userId)
        reportDate = try? c.decodeIfPresent(String.self, forKey: .reportDate)
        accountIds = (try? c.decode([String].self, forKey: .accountIds)) ?? []
        totalTrades = tradingHrFlexInt(c, .totalTrades) ?? 0
        dailyProfitBdt = tradingHrFlexInt(c, .dailyProfitBdt) ?? 0
        dailyLossBdt = tradingHrFlexInt(c, .dailyLossBdt) ?? 0
        issues = try? c.decodeIfPresent(String.self, forKey: .issues)
        operationalNotes = try? c.decodeIfPresent(String.self, forKey: .operationalNotes)
        submittedAt = try? c.decodeIfPresent(String.self, forKey: .submittedAt)
        let u = try? c.nestedContainer(keyedBy: UserKeys.self, forKey: .user)
        userName = u.flatMap { try? $0.decodeIfPresent(String.self, forKey: .name) }
    }
}

private struct TradingHrReportsResponse: Decodable {
    let reports: [TradingHrDailyReport]
    private enum Keys: String, CodingKey { case ok, data, reports }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        reports = (try? c.decode([TradingHrDailyReport].self, forKey: .reports)) ?? []
    }
}

// MARK: - Formatting helpers

private enum TradingHrFormat {
    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
    /// ISO timestamp / date string → "2026-07-10" style day (first 10 chars).
    static func day(_ iso: String?) -> String {
        guard let iso, iso.count >= 10 else { return iso ?? "—" }
        return String(iso.prefix(10))
    }
    /// Whole-taka signed display: ৳12,340 / -৳560.
    static func taka(_ amount: Int) -> String {
        amount < 0 ? "-৳\(abs(amount).formatted())" : "৳\(amount.formatted())"
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
private final class TradingHrVM {
    fileprivate var employees: [TradingHrEmployeeItem] = []
    fileprivate var alerts: [TradingHrAlert] = []
    fileprivate var rankings: TradingHrRankings? = nil
    fileprivate var kpis: TradingHrKpis? = nil
    fileprivate var staffSummary: [TradingHrStaffSummaryRow] = []
    fileprivate var reports: [TradingHrDailyReport] = []
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        // The three fetches mirror the web hooks (useTradingHr / useTradingStaffSummary /
        // useTradingEmployeeReports). HR is primary and drives auth/error state; the
        // summary + reports blocks degrade to empty on their own failures.
        async let summaryTask: TradingHrStaffSummaryResponse? = try? AlmaAPI.shared.get(
            "/api/trading/staff-summary")
        async let reportsTask: TradingHrReportsResponse? = try? AlmaAPI.shared.get(
            "/api/trading/hr/reports", query: ["limit": "40"])
        do {
            let hr: TradingHrResponseModel = try await AlmaAPI.shared.get("/api/trading/hr")
            employees = hr.employees
            alerts = hr.alerts
            rankings = hr.rankings
            kpis = hr.kpis
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
        }
        let (summary, reps) = await (summaryTask, reportsTask)
        if Task.isCancelled { return }
        staffSummary = summary?.staff ?? []
        reports = reps?.reports ?? []
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    /// One staffer's recent reports for the detail sheet.
    fileprivate func reports(for userId: String) async -> [TradingHrDailyReport] {
        do {
            let resp: TradingHrReportsResponse = try await AlmaAPI.shared.get(
                "/api/trading/hr/reports", query: ["userId": userId, "limit": "40"])
            return resp.reports
        } catch {
            return []
        }
    }

    // ── Native writes (owner 2026-07-11) — web saveHrProfile / submitEmployeeReport. ──

    var toast: String? = nil

    struct ProfilePayload: Encodable {
        let userId: String
        let employeeIdGas: String
        let roleTitle: String
        let shift: String
        let status: String
        let salary: Int
        let commissionType: String
        let commissionRate: Double
        let fixedCommission: Int
        let merchantCompletionBonus: Int
        let milestoneBonus: Int
        let joiningDate: String
        let notes: String
    }
    struct ReportPayload: Encodable {
        let userId: String
        let reportDate: String
        let accountIds: [String]
        let totalTrades: Int
        let dailyProfitBdt: Double
        let dailyLossBdt: Double
        let issues: String
        let screenshotProof: String
        let operationalNotes: String
    }
    private struct WriteResponse: Decodable { let ok: Bool?, error: String? }

    func saveProfile(_ p: ProfilePayload) async -> Bool {
        await write(success: "Trading employee profile saved") {
            try await AlmaAPI.shared.send("POST", "/api/trading/hr", body: p)
        }
    }
    func submitReport(_ p: ReportPayload) async -> Bool {
        await write(success: "Daily employee report submitted") {
            try await AlmaAPI.shared.send("POST", "/api/trading/hr/reports", body: p)
        }
    }
    private func write(success: String, _ op: () async throws -> WriteResponse) async -> Bool {
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

// MARK: - Screen

@available(iOS 17.0, *)
struct TradingHrScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = TradingHrVM()
    @State private var selectedId: String? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                kpiBoard
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.employees.isEmpty { loadingRows }
                employeesBlock
                alertsBlock
                rankingsBlock
                staffSummaryBlock
                reportsFeedBlock
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(TradingHrAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: Binding(
            get: { vm.employees.first(where: { $0.id == selectedId }) },
            set: { selectedId = $0?.id })) { employee in
            TradingHrDetailSheet(employee: employee, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── KPI board (web: 8 KpiCards) — bento language: profit-generated = the dark
    //    hero anchor with employees/active/accounts split, the money KPIs = accent
    //    tiles. Same numbers, same tints — presentation only. ──

    private var kpiBoard: some View {
        let k = vm.kpis
        return VStack(spacing: 10) {
            TradingHrBentoHeroCard(profit: k?.totalProfitGenerated ?? 0,
                                   employees: k?.totalEmployees ?? vm.employees.count,
                                   active: k?.activeEmployees ?? 0,
                                   accounts: k?.totalManagedAccounts ?? 0)
            HStack(spacing: 10) {
                TradingHrBentoStatTile(label: "Losses", value: k?.totalLosses ?? 0,
                                       format: { AlmaSwiftTheme.takaShort($0) },
                                       sub: "মোট লস",
                                       tint: TradingHrPalette.red400,
                                       accent: TradingHrPalette.red500)
                TradingHrBentoStatTile(label: "Commissions", value: k?.totalCommissions ?? 0,
                                       format: { AlmaSwiftTheme.takaShort($0) },
                                       sub: "স্টাফ কমিশন",
                                       tint: TradingHrPalette.accentText(colorScheme),
                                       accent: TradingHrPalette.coral)
            }
            HStack(spacing: 10) {
                TradingHrBentoStatTile(label: "Wallet balance", value: k?.totalWalletBalance ?? 0,
                                       format: { AlmaSwiftTheme.takaShort($0) },
                                       sub: "স্টাফ ওয়ালেট",
                                       tint: TradingHrPalette.blue500,
                                       accent: TradingHrPalette.blue500)
                TradingHrBentoStatTile(label: "Missing reports", value: k?.missingReports ?? 0,
                                       format: { "\($0)" },
                                       sub: "আজকের বাকি রিপোর্ট",
                                       tint: TradingHrPalette.amber(colorScheme),
                                       accent: TradingHrPalette.amber500)
            }
        }
        .padding(.top, 4)
    }

    // ── Trading employee profiles (web table → contact-style rows) ──

    @ViewBuilder private var employeesBlock: some View {
        if !vm.employees.isEmpty {
            sectionHeader("Trading Employee Profiles", trailing: "Business scoped")
            ForEach(vm.employees) { em in
                TradingHrEmployeeRow(employee: em) {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    selectedId = em.id
                }
            }
        } else if !vm.loading && vm.error == nil && !vm.authExpired {
            emptyState("No trading employees yet")
        }
    }

    // ── HR Alert Engine (web right column card) ──

    @ViewBuilder private var alertsBlock: some View {
        if !vm.alerts.isEmpty {
            sectionHeader("HR Alert Engine")
            VStack(spacing: 0) {
                ForEach(Array(vm.alerts.prefix(10).enumerated()), id: \.offset) { idx, alert in
                    if idx > 0 { Divider().opacity(0.4) }
                    HStack(alignment: .top, spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(alert.title).font(.caption.weight(.bold))
                            Text(alert.message).font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 6)
                        Text(alert.severity)
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(TradingHrPalette.severity(alert.severity, colorScheme))
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(TradingHrPalette.severity(alert.severity, colorScheme).opacity(0.12),
                                        in: Capsule())
                            .overlay(Capsule().strokeBorder(
                                TradingHrPalette.severity(alert.severity, colorScheme).opacity(0.35),
                                lineWidth: 0.8))
                    }
                    .padding(.vertical, 10)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 4)
            .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    // ── Rankings (web 5 RankingCards) ──

    @ViewBuilder private var rankingsBlock: some View {
        if let r = vm.rankings {
            sectionHeader("Performance Rankings")
            TradingHrRankingCard(title: "Top Trader", rows: r.topTrader,
                                 metric: { "\($0.metrics?.totalTrades ?? 0) trades" })
            TradingHrRankingCard(title: "Most Profitable", rows: r.mostProfitable,
                                 metric: { TradingHrFormat.taka($0.metrics?.netResult ?? 0) })
            TradingHrRankingCard(title: "Lowest Loss Ratio", rows: r.lowestLossRatio,
                                 metric: { "Loss ৳\(($0.metrics?.totalLosses ?? 0).formatted())" })
            TradingHrRankingCard(title: "Merchant Growth", rows: r.bestMerchantGrowth,
                                 metric: { "\(Int(($0.metrics?.merchantGrowthSuccess ?? 0).rounded()))%" })
            TradingHrRankingCard(title: "Most Active", rows: r.mostActive,
                                 metric: { "\(Int(($0.metrics?.activityConsistency ?? 0).rounded()))%" })
        }
    }

    // ── Staff performance summary (GET /api/trading/staff-summary — this month) ──

    @ViewBuilder private var staffSummaryBlock: some View {
        if !vm.staffSummary.isEmpty {
            sectionHeader("Staff Performance · This Month")
            VStack(spacing: 0) {
                ForEach(Array(vm.staffSummary.enumerated()), id: \.element.id) { idx, row in
                    if idx > 0 { Divider().opacity(0.4) }
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.name).font(.caption.weight(.bold)).lineLimit(1)
                            Text("\(row.assignedAccounts) accounts · \(row.activeAccounts) active · capital \(AlmaSwiftTheme.takaShort(row.totalManagedCapital))")
                                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 6)
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(TradingHrFormat.taka(row.monthlyNetResult))
                                .font(.caption.weight(.bold).monospacedDigit())
                                .foregroundStyle(TradingHrPalette.signed(row.monthlyNetResult, colorScheme))
                            Text("কমিশন ৳\(row.commissionEarned.formatted()) · তোলা যাবে ৳\(row.withdrawableBalance.formatted())")
                                .font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .padding(.vertical, 10)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 4)
            .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    // ── Recent daily reports feed (GET /api/trading/hr/reports, limit 40) ──

    @ViewBuilder private var reportsFeedBlock: some View {
        if !vm.reports.isEmpty {
            sectionHeader("Recent Daily Reports")
            VStack(spacing: 0) {
                ForEach(Array(vm.reports.prefix(15).enumerated()), id: \.element.id) { idx, report in
                    if idx > 0 { Divider().opacity(0.4) }
                    TradingHrReportRow(report: report, showName: true)
                        .padding(.vertical, 10)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 4)
            .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    // ── Shared bits ──

    private func sectionHeader(_ title: String, trailing: String? = nil) -> some View {
        HStack {
            Text(title).font(.footnote.weight(.bold))
            Spacer()
            if let trailing {
                Text(trailing.uppercased())
                    .font(.system(size: 9, weight: .bold)).tracking(0.5)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 2)
        .padding(.top, 8)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(TradingHrPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        ForEach(0..<5, id: \.self) { _ in
            Color.clear.frame(height: 72)
                .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .tradingHrShimmer()
        }
    }

    private func emptyState(_ title: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "person.2").font(.largeTitle).foregroundStyle(.secondary)
            Text(title).foregroundStyle(.secondary)
        }
        .padding(.top, 40)
        .padding(.bottom, 20)
    }

    /// Mutations (profile save / report submit) live on the web page.
    private var webEscape: some View {
        Button {
            openWeb("/trading/hr", "Trading HR")
        } label: {
            Label("প্রোফাইল/রিপোর্ট এডিট — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Employee row (web table row → avatar · role/link · P/L + wallet)

@available(iOS 17.0, *)
private struct TradingHrEmployeeRow: View {
    let employee: TradingHrEmployeeItem
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 12) {
            avatar
            VStack(alignment: .leading, spacing: 2) {
                Text(employee.user.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(subtitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                HStack(spacing: 6) {
                    shiftPill
                    Text("\(employee.metrics?.totalAccountsManaged ?? 0) acct · \(employee.metrics?.totalTrades ?? 0) trades")
                        .font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 3) {
                Text(TradingHrFormat.taka(employee.metrics?.netResult ?? 0))
                    .font(.footnote.weight(.bold).monospacedDigit())
                    .foregroundStyle(TradingHrPalette.signed(employee.metrics?.netResult ?? 0, colorScheme))
                Text("ওয়ালেট ৳\((employee.wallet?.currentBalance ?? 0).formatted())")
                    .font(.system(size: 9).monospacedDigit())
                    .foregroundStyle(TradingHrPalette.blue500)
                Text("consistency \(Int((employee.metrics?.activityConsistency ?? 0).rounded()))%")
                    .font(.system(size: 9)).foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture(perform: onTap)
    }

    private var avatar: some View {
        Text(TradingHrFormat.initials(employee.user.name))
            .font(.caption.weight(.bold))
            .foregroundStyle(TradingHrPalette.sage)
            .frame(width: 38, height: 38)
            .background(TradingHrPalette.sage.opacity(0.14), in: Circle())
            .overlay(Circle().strokeBorder(TradingHrPalette.sage.opacity(0.35), lineWidth: 1))
    }

    /// Web: roleTitle || user.role · employeeIdGas || 'No employee link'.
    private var subtitle: String {
        let role = employee.profile?.roleTitle?.isEmpty == false
            ? employee.profile!.roleTitle! : (employee.user.role ?? "STAFF")
        let link = employee.user.employeeIdGas?.isEmpty == false
            ? employee.user.employeeIdGas! : "No employee link"
        return "\(role) · \(link)"
    }

    private var shiftPill: some View {
        let shift = employee.profile?.shift ?? "DAY"
        let night = shift == "NIGHT"
        return Text(shift)
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(night ? AlmaSwiftTheme.violet : TradingHrPalette.amber(colorScheme))
            .padding(.horizontal, 5).padding(.vertical, 1.5)
            .background((night ? AlmaSwiftTheme.violet : TradingHrPalette.amber500).opacity(0.12),
                        in: Capsule())
    }
}

// MARK: - Report row (feed + detail sheet share the same line)

@available(iOS 17.0, *)
private struct TradingHrReportRow: View {
    let report: TradingHrDailyReport
    var showName = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(TradingHrFormat.day(report.reportDate))
                        .font(.caption.monospaced().weight(.semibold))
                        .foregroundStyle(TradingHrPalette.sage)
                    if showName, let name = report.userName, !name.isEmpty {
                        Text(name).font(.caption.weight(.semibold)).lineLimit(1)
                    }
                }
                Text("\(report.totalTrades) trades · \(report.accountIds.count) accounts")
                    .font(.caption2).foregroundStyle(.secondary)
                if let issues = report.issues, !issues.isEmpty {
                    Text(issues).font(.caption2)
                        .foregroundStyle(TradingHrPalette.amber(colorScheme))
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 2) {
                Text("+৳\(report.dailyProfitBdt.formatted())")
                    .font(.caption.weight(.bold).monospacedDigit())
                    .foregroundStyle(TradingHrPalette.green(colorScheme))
                if report.dailyLossBdt != 0 {
                    Text("-৳\(report.dailyLossBdt.formatted())")
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(TradingHrPalette.red400)
                }
            }
        }
    }
}

// MARK: - Ranking card (web RankingCard parity)

@available(iOS 17.0, *)
private struct TradingHrRankingCard: View {
    let title: String
    let rows: [TradingHrEmployeeItem]
    let metric: (TradingHrEmployeeItem) -> String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption.weight(.bold))
            if rows.isEmpty {
                Text("No data yet").font(.caption2).foregroundStyle(.secondary)
            } else {
                ForEach(Array(rows.prefix(5).enumerated()), id: \.element.id) { idx, row in
                    HStack(spacing: 6) {
                        Text("\(idx + 1). \(row.user.name)")
                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 6)
                        Text(metric(row))
                            .font(.caption2.monospaced().weight(.semibold))
                            .foregroundStyle(TradingHrPalette.accentText(colorScheme))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }
}

// MARK: - Detail sheet (HR profile + metrics + wallet + accounts + that staffer's reports)

@available(iOS 17.0, *)
private struct TradingHrDetailSheet: View {
    let employee: TradingHrEmployeeItem
    let vm: TradingHrVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var reports: [TradingHrDailyReport] = []
    @State private var reportsLoading = true
    @State private var editingProfile = false
    @State private var addingReport = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                writeButtons
                profileCard
                metricsCard
                walletCard
                accountsCard
                reportsCard
                webLink
            }
            .padding(18)
        }
        .presentationBackground { TradingHrAurora() }
        .task {
            reports = await vm.reports(for: employee.user.id)
            reportsLoading = false
        }
        .sheet(isPresented: $editingProfile) {
            TradingHrProfileSheet(employee: employee, vm: vm)
        }
        .sheet(isPresented: $addingReport) {
            TradingHrReportSheet(employee: employee, vm: vm) {
                Task { reports = await vm.reports(for: employee.user.id) }
            }
        }
    }

    /// Native writes (owner 2026-07-11): profile save + daily report — web parity.
    private var writeButtons: some View {
        HStack(spacing: 10) {
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                editingProfile = true
            } label: {
                Label("Profile সম্পাদনা", systemImage: "pencil")
                    .font(.caption.weight(.bold))
                    .frame(maxWidth: .infinity).padding(.vertical, 9)
            }
            .buttonStyle(.bordered)
            .tint(TradingHrPalette.sage)
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                addingReport = true
            } label: {
                Label("Daily report", systemImage: "square.and.pencil")
                    .font(.caption.weight(.bold))
                    .frame(maxWidth: .infinity).padding(.vertical, 9)
            }
            .buttonStyle(.bordered)
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text(TradingHrFormat.initials(employee.user.name))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TradingHrPalette.sage)
                .frame(width: 44, height: 44)
                .background(TradingHrPalette.sage.opacity(0.14), in: Circle())
                .overlay(Circle().strokeBorder(TradingHrPalette.sage.opacity(0.35), lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(employee.user.name).font(.headline)
                Text("\(employee.profile?.roleTitle?.isEmpty == false ? employee.profile!.roleTitle! : (employee.user.role ?? "STAFF")) · \(employee.user.employeeIdGas ?? "No employee link")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            statusPill
        }
    }

    private var statusPill: some View {
        let status = employee.profile?.status ?? "ACTIVE"
        let tint: Color = status == "ACTIVE"
            ? TradingHrPalette.green(colorScheme)
            : (status == "INACTIVE" ? TradingHrPalette.red500 : TradingHrPalette.amber(colorScheme))
        return Text(status)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 0.8))
    }

    // ── HR profile (web modal fields, read-only: salary / shift / commission / notes) ──

    private var profileCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("HR PROFILE").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            statRow("Salary", "৳\((employee.profile?.salary ?? 0).formatted())",
                    tint: TradingHrPalette.accentText(colorScheme))
            statRow("Shift", employee.profile?.shift ?? "DAY")
            statRow("Commission", commissionLine)
            if (employee.profile?.merchantCompletionBonus ?? 0) > 0 {
                statRow("Completion bonus", "৳\(employee.profile!.merchantCompletionBonus.formatted())")
            }
            if (employee.profile?.milestoneBonus ?? 0) > 0 {
                statRow("Milestone bonus", "৳\(employee.profile!.milestoneBonus.formatted())")
            }
            if let joining = employee.user.joiningDate, !joining.isEmpty {
                statRow("Joining date", TradingHrFormat.day(joining))
            }
            if let phone = employee.user.phone, !phone.isEmpty {
                statRow("Phone", phone)
            }
            if let notes = employee.profile?.notes, !notes.isEmpty {
                statRow("Notes", notes, tint: TradingHrPalette.amber(colorScheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var commissionLine: String {
        switch employee.profile?.commissionType {
        case "PERCENTAGE":
            let rate = employee.profile?.commissionRate ?? 0
            return "Profit \(rate.formatted())%"
        case "FIXED":
            return "Fixed ৳\((employee.profile?.fixedCommission ?? 0).formatted())"
        default:
            return "None"
        }
    }

    // ── Performance metrics (web table columns, expanded) ──

    private var metricsCard: some View {
        let m = employee.metrics
        return VStack(alignment: .leading, spacing: 8) {
            Text("PERFORMANCE").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            statRow("Accounts", "\(m?.totalAccountsManaged ?? 0) total · \(m?.activeAccounts ?? 0) active")
            statRow("Trades", "\((m?.totalTrades ?? 0).formatted())",
                    tint: TradingHrPalette.accentText(colorScheme))
            statRow("Profit generated", TradingHrFormat.taka(m?.totalProfitGenerated ?? 0),
                    tint: TradingHrPalette.green(colorScheme))
            statRow("Losses", TradingHrFormat.taka(m?.totalLosses ?? 0),
                    tint: TradingHrPalette.red400)
            statRow("Net P/L", TradingHrFormat.taka(m?.netResult ?? 0),
                    tint: TradingHrPalette.signed(m?.netResult ?? 0, colorScheme))
            statRow("Merchant growth", "\(Int((m?.merchantGrowthSuccess ?? 0).rounded()))%")
            statRow("Activity consistency", "\(Int((m?.activityConsistency ?? 0).rounded()))%")
            statRow("Report consistency", "\(Int((m?.reportConsistency ?? 0).rounded()))%")
            statRow("Today's report",
                    (m?.todayReportSubmitted ?? false) ? "Submitted" : "Missing",
                    tint: (m?.todayReportSubmitted ?? false)
                        ? TradingHrPalette.green(colorScheme)
                        : TradingHrPalette.amber(colorScheme))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Wallet (web wallet column, expanded) ──

    @ViewBuilder private var walletCard: some View {
        if let w = employee.wallet {
            VStack(alignment: .leading, spacing: 8) {
                Text("WALLET").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                statRow("Current balance", "৳\(w.currentBalance.formatted())",
                        tint: TradingHrPalette.blue500)
                statRow("Withdrawable", "৳\(w.availableWithdrawable.formatted())",
                        tint: TradingHrPalette.green(colorScheme))
                statRow("Commissions", "৳\(w.totalCommissions.formatted())")
                statRow("Advances", "৳\(w.totalAdvances.formatted())")
                statRow("Withdrawals", "৳\(w.totalWithdrawals.formatted())")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    // ── Assigned accounts ──

    @ViewBuilder private var accountsCard: some View {
        if !employee.assignedAccounts.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("ASSIGNED ACCOUNTS").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                ForEach(employee.assignedAccounts) { account in
                    HStack(spacing: 8) {
                        Circle()
                            .fill(account.status == "ACTIVE"
                                  ? TradingHrPalette.green(colorScheme) : TradingHrPalette.slate400)
                            .frame(width: 6, height: 6)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(account.accountTitle).font(.caption.weight(.semibold)).lineLimit(1)
                            Text("ROI \(account.netRoi.formatted())% · merchant \(Int(account.merchantProgress.rounded()))%")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 6)
                        Text("৳\(account.currentBalance.formatted())")
                            .font(.caption.weight(.bold).monospacedDigit())
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    // ── That staffer's recent daily reports ──

    private var reportsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("RECENT REPORTS").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            if reportsLoading {
                HStack(spacing: 8) {
                    AlmaMiniLoader()
                    Text("লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary)
                }
            } else if reports.isEmpty {
                Text("কোনো রিপোর্ট পাওয়া যায়নি").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(reports.prefix(10)) { report in
                    TradingHrReportRow(report: report)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingHrGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func statRow(_ label: String, _ value: String, tint: Color = .primary) -> some View {
        HStack(alignment: .top) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.bold)).foregroundStyle(tint)
                .multilineTextAlignment(.trailing)
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/trading/hr", "Trading HR")
        } label: {
            Label("প্রোফাইল/রিপোর্ট এডিট — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Aurora background + glass (Trading-HR-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct TradingHrAurora: View {
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
    func tradingHrGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct TradingHrShimmer: ViewModifier {
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
    func tradingHrShimmer() -> some View { modifier(TradingHrShimmer()) }
}

// MARK: - Bento components (Trading-HR-owned copies of the Dashboard board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func tradingHrMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct TradingHrCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        TradingHrCountUpText(value: shown, format: format)
            .animation(tradingHrMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if tradingHrMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct TradingHrCountUpText: View, Animatable {
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
private func tradingHrBentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
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
private struct TradingHrBentoStatTile: View {
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
            TradingHrCountUp(target: value, format: format)
                .font(.system(size: 17, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background { tradingHrBentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
/// deep indigo base + violet/coral washes + a sage hint). Profit-generated count-up
/// plus the Employees / Active / Accounts split — the same numbers the KPI row showed.
@available(iOS 17.0, *)
private struct TradingHrBentoHeroCard: View {
    let profit: Int
    let employees: Int
    let active: Int
    let accounts: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("প্রফিট জেনারেটেড · TRADING HR").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(TradingHrPalette.sage)
            TradingHrCountUp(target: profit, format: { AlmaSwiftTheme.takaShort($0) })
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            Text("সব স্টাফের মোট জেনারেট করা প্রফিট")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Employees", value: employees, tint: .white, sub: "মোট স্টাফ")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Active", value: active, tint: TradingHrPalette.sage, sub: "সক্রিয়")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Accounts", value: accounts, tint: TradingHrPalette.goldLt, sub: "ম্যানেজড")
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

    private func heroStat(label: String, value: Int, tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            TradingHrCountUp(target: value, format: { "\($0)" })
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Trading HR — Light") {
    TradingHrScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}

// MARK: - Native write sheets (owner 2026-07-11 — web HR profile form + daily report
// form, POST /api/trading/hr and /api/trading/hr/reports verbatim).

@available(iOS 17.0, *)
private struct TradingHrProfileSheet: View {
    let employee: TradingHrEmployeeItem
    let vm: TradingHrVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    @State private var employeeIdGas = ""
    @State private var roleTitle = ""
    @State private var shift = "DAY"
    @State private var status = "ACTIVE"
    @State private var salary = ""
    @State private var commissionType = "NONE"
    @State private var commissionRate = ""
    @State private var fixedCommission = ""
    @State private var completionBonus = ""
    @State private var milestoneBonus = ""
    @State private var joiningDate = ""
    @State private var notes = ""
    @State private var submitting = false
    @State private var confirming = false
    @State private var errorText: String? = nil

    private func num(_ s: String) -> Double { Double(s.replacingOccurrences(of: ",", with: "")) ?? 0 }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("HR profile — \(employee.user.name)").font(.subheadline.weight(.bold))
                    Text("Salary পরিবর্তন wallet accrual-এ প্রভাব ফেলে।")
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
                    field("Employee ID (GAS)", text: $employeeIdGas)
                    field("Role title", text: $roleTitle)
                    Picker("Shift", selection: $shift) {
                        Text("Day").tag("DAY")
                        Text("Night").tag("NIGHT")
                        Text("Rotating").tag("ROTATING")
                    }
                    .pickerStyle(.segmented)
                    Picker("Status", selection: $status) {
                        Text("Active").tag("ACTIVE")
                        Text("Inactive").tag("INACTIVE")
                        Text("On leave").tag("ON_LEAVE")
                    }
                    .pickerStyle(.segmented)
                    field("Salary (BDT)", text: $salary, keyboard: .numberPad)
                    Menu {
                        Button("No commission") { commissionType = "NONE" }
                        Button("Percentage of profit") { commissionType = "PERCENTAGE" }
                        Button("Fixed per profitable sell") { commissionType = "FIXED" }
                    } label: {
                        HStack {
                            Text(commissionType == "NONE" ? "No commission"
                                 : commissionType == "PERCENTAGE" ? "Percentage of profit"
                                 : "Fixed per profitable sell")
                                .font(.subheadline.weight(.semibold))
                            Spacer()
                            Image(systemName: "chevron.up.chevron.down").font(.caption2)
                        }
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12).padding(.vertical, 11)
                        .background(Color.primary.opacity(0.06),
                                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    }
                    field("Commission % of profit", text: $commissionRate)
                    field("Fixed commission BDT", text: $fixedCommission, keyboard: .numberPad)
                    field("Merchant completion bonus BDT", text: $completionBonus, keyboard: .numberPad)
                    field("Milestone bonus BDT", text: $milestoneBonus, keyboard: .numberPad)
                    field("Joining date (YYYY-MM-DD)", text: $joiningDate, keyboard: .numbersAndPunctuation)
                    field("Notes", text: $notes, keyboard: .default)
                    if let errorText {
                        Text(errorText).font(.caption2.weight(.semibold))
                            .foregroundStyle(TradingHrPalette.red500)
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
                    Text(submitting ? "Saving…" : "Save profile").font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(!submitting ? AlmaSwiftTheme.coral : AlmaSwiftTheme.coral.opacity(0.4),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(submitting)
            .padding(.horizontal, 18).padding(.vertical, 14)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .background(AlmaSwiftTheme.rootBg(scheme))
        .onAppear(perform: prefill)
        .confirmationDialog(
            "\(employee.user.name)-এর HR profile সেভ করবেন? Salary ৳\(Int(num(salary)).formatted())",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, সেভ করুন") { submit() }
            Button("বাতিল", role: .cancel) {}
        }
    }

    private func prefill() {
        let p = employee.profile
        employeeIdGas = p?.employeeIdGas ?? employee.user.employeeIdGas ?? ""
        roleTitle = p?.roleTitle ?? ""
        shift = p?.shift ?? "DAY"
        status = p?.status ?? "ACTIVE"
        salary = p.map { String($0.salary) } ?? ""
        commissionType = p?.commissionType ?? "NONE"
        commissionRate = p.map { String($0.commissionRate) } ?? ""
        fixedCommission = p.map { String($0.fixedCommission) } ?? ""
        completionBonus = p.map { String($0.merchantCompletionBonus) } ?? ""
        milestoneBonus = p.map { String($0.milestoneBonus) } ?? ""
        joiningDate = String((p?.joiningDate ?? employee.user.joiningDate ?? "").prefix(10))
        notes = p?.notes ?? ""
    }

    private func submit() {
        guard !submitting else { return }
        submitting = true; errorText = nil
        Task {
            defer { submitting = false }
            let ok = await vm.saveProfile(.init(
                userId: employee.user.id,
                employeeIdGas: employeeIdGas,
                roleTitle: roleTitle,
                shift: shift,
                status: status,
                salary: Int(num(salary)),
                commissionType: commissionType,
                commissionRate: num(commissionRate),
                fixedCommission: Int(num(fixedCommission)),
                merchantCompletionBonus: Int(num(completionBonus)),
                milestoneBonus: Int(num(milestoneBonus)),
                joiningDate: joiningDate,
                notes: notes))
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { dismiss() } else { errorText = vm.toast }
        }
    }

    private func field(_ placeholder: String, text: Binding<String>,
                       keyboard: UIKeyboardType = .decimalPad) -> some View {
        TextField(placeholder, text: text)
            .keyboardType(keyboard)
            .font(.subheadline)
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(Color.primary.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }
}

@available(iOS 17.0, *)
private struct TradingHrReportSheet: View {
    let employee: TradingHrEmployeeItem
    let vm: TradingHrVM
    var onDone: (() -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    @State private var reportDate = Date()
    @State private var selectedAccountIds: Set<String> = []
    @State private var totalTrades = ""
    @State private var profit = ""
    @State private var loss = ""
    @State private var issues = ""
    @State private var opNotes = ""
    @State private var submitting = false
    @State private var confirming = false

    private func num(_ s: String) -> Double { Double(s.replacingOccurrences(of: ",", with: "")) ?? 0 }
    private static let ymd: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Daily report — \(employee.user.name)").font(.subheadline.weight(.bold))
                    Text("দিনের ট্রেড সংখ্যা ও P/L।").font(.caption2).foregroundStyle(.secondary)
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
                    DatePicker("Report date", selection: $reportDate, displayedComponents: .date)
                        .font(.subheadline)
                    if !employee.assignedAccounts.isEmpty {
                        Text("ACCOUNTS").font(.system(size: 9, weight: .bold)).tracking(1)
                            .foregroundStyle(.secondary)
                        ForEach(employee.assignedAccounts) { a in
                            Toggle(a.accountTitle, isOn: Binding(
                                get: { selectedAccountIds.contains(a.id) },
                                set: { on in
                                    if on { selectedAccountIds.insert(a.id) }
                                    else { selectedAccountIds.remove(a.id) }
                                }))
                                .font(.subheadline)
                                .tint(TradingHrPalette.sage)
                        }
                    }
                    field("Total trades", text: $totalTrades, keyboard: .numberPad)
                    field("Daily profit (BDT)", text: $profit)
                    field("Daily loss (BDT)", text: $loss)
                    field("Issues", text: $issues, keyboard: .default)
                    field("Operational notes", text: $opNotes, keyboard: .default)
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
                    Text(submitting ? "Submitting…" : "Submit report").font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(!submitting ? TradingHrPalette.sage : TradingHrPalette.sage.opacity(0.4),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(submitting)
            .padding(.horizontal, 18).padding(.vertical, 14)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .background(AlmaSwiftTheme.rootBg(scheme))
        .confirmationDialog(
            "Report সাবমিট করবেন? Net ৳\(Int(num(profit) - num(loss)).formatted())",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("হ্যাঁ, সাবমিট করুন") { submit() }
            Button("বাতিল", role: .cancel) {}
        }
    }

    private func submit() {
        guard !submitting else { return }
        submitting = true
        Task {
            defer { submitting = false }
            let ok = await vm.submitReport(.init(
                userId: employee.user.id,
                reportDate: Self.ymd.string(from: reportDate),
                accountIds: Array(selectedAccountIds),
                totalTrades: Int(num(totalTrades)),
                dailyProfitBdt: num(profit),
                dailyLossBdt: num(loss),
                issues: issues,
                screenshotProof: "",
                operationalNotes: opNotes))
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { onDone?(); dismiss() }
        }
    }

    private func field(_ placeholder: String, text: Binding<String>,
                       keyboard: UIKeyboardType = .decimalPad) -> some View {
        TextField(placeholder, text: text)
            .keyboardType(keyboard)
            .font(.subheadline)
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(Color.primary.opacity(0.06),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }
}
