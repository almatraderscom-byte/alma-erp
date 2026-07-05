//
//  PayrollSwiftUI.swift
//  ALMA ERP — S7: the Payroll tab as a native SwiftUI screen (STRICTLY READ-ONLY).
//
//  Payroll is financially sensitive (recently-fixed wallet/salary ledger logic), so
//  this screen mirrors the web /payroll page as summaries + lists + detail sheets
//  ONLY. Every mutating action — pay, adjust, correct, approve, run accrual, toggle
//  automation — goes through the web escape hatch. No POST/PATCH is ever sent.
//
//  GET-only endpoints (same ones the web page reads):
//    /api/payroll/wallet/summary?business_id=…           → wallets + totals + pending requests
//    /api/hr/dashboard?business_id=…                     → KPIs + legacy GAS roll + timeline
//    /api/payroll/wallet/accruals/preview?business_id=…  → monthly accrual preview
//    /api/payroll/wallet/accruals/history?business_id=…  → accrual run history
//    /api/payroll/wallet/automation                      → automation setting
//
//  Carried lessons: lenient decoding (try? per field, flexInt for stringly numbers),
//  cancellation-safe pull-to-refresh, auth-expired card, page-private aurora/glass.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum PayrollPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let red400 = Color(red: 0.973, green: 0.443, blue: 0.443)         // #F87171
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
    /// Positive money reads green; brighter variant over the dark aurora.
    static func pos(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? green400 : emerald600
    }
    /// Accrual run status — web: SUCCESS txt-pos · RUNNING amber-500 · else txt-neg.
    static func runStatus(_ s: String, _ scheme: ColorScheme) -> Color {
        switch s {
        case "SUCCESS": return pos(scheme)
        case "RUNNING": return amber500
        default: return red500
        }
    }
}

// MARK: - Lenient number decoding (Prisma Decimals arrive as strings sometimes)

private func payrollFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) {
        if let i = Int(s) { return i }
        if let d = Double(s) { return Int(d.rounded()) }
    }
    return nil
}

// MARK: - Models (same field names the web types declare — src/types/payroll-wallet.ts)

/// One employee's lifetime wallet summary (whole-taka BDT).
struct PayrollWalletTotalsModel: Decodable, Equatable {
    let lifetimeEarned: Int
    let lifetimeWithdrawn: Int
    let totalAccrued: Int
    let totalBonuses: Int
    let totalCommissions: Int
    let totalOvertime: Int
    let totalReimbursements: Int
    let totalMealDeductions: Int
    let totalPenalties: Int
    let outstandingAdvance: Int
    let currentBalance: Int
    let companyLiability: Int
    let availableWithdrawable: Int
    let thisMonthSalaryAdded: Int
    let entryCount: Int

    private enum Keys: String, CodingKey {
        case lifetimeEarned, lifetimeWithdrawn, totalAccrued, totalBonuses, totalCommissions
        case totalOvertime, totalReimbursements, totalMealDeductions, totalPenalties
        case outstandingAdvance, currentBalance, companyLiability, availableWithdrawable
        case thisMonthSalaryAdded, entryCount
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        lifetimeEarned = payrollFlexInt(c, .lifetimeEarned) ?? 0
        lifetimeWithdrawn = payrollFlexInt(c, .lifetimeWithdrawn) ?? 0
        totalAccrued = payrollFlexInt(c, .totalAccrued) ?? 0
        totalBonuses = payrollFlexInt(c, .totalBonuses) ?? 0
        totalCommissions = payrollFlexInt(c, .totalCommissions) ?? 0
        totalOvertime = payrollFlexInt(c, .totalOvertime) ?? 0
        totalReimbursements = payrollFlexInt(c, .totalReimbursements) ?? 0
        totalMealDeductions = payrollFlexInt(c, .totalMealDeductions) ?? 0
        totalPenalties = payrollFlexInt(c, .totalPenalties) ?? 0
        outstandingAdvance = payrollFlexInt(c, .outstandingAdvance) ?? 0
        currentBalance = payrollFlexInt(c, .currentBalance) ?? 0
        companyLiability = payrollFlexInt(c, .companyLiability) ?? 0
        availableWithdrawable = payrollFlexInt(c, .availableWithdrawable) ?? 0
        thisMonthSalaryAdded = payrollFlexInt(c, .thisMonthSalaryAdded) ?? 0
        entryCount = payrollFlexInt(c, .entryCount) ?? 0
    }
}

/// One wallet ledger entry (the web's latestEntries slice — display only).
struct PayrollLedgerEntry: Decodable, Identifiable, Equatable {
    let id: String
    let date: String?
    let periodYm: String?
    let type: String?
    let note: String?
    let signedAmount: Int
    let runningBalance: Int

    private enum Keys: String, CodingKey { case id, date, periodYm, type, note, signedAmount, runningBalance }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        date = try? c.decodeIfPresent(String.self, forKey: .date)
        periodYm = try? c.decodeIfPresent(String.self, forKey: .periodYm)
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        signedAmount = payrollFlexInt(c, .signedAmount) ?? 0
        runningBalance = payrollFlexInt(c, .runningBalance) ?? 0
    }
}

/// One employee wallet row (web "Employee profitability and liabilities" table).
struct PayrollEmployeeWallet: Decodable, Identifiable, Equatable {
    let employeeId: String
    let businessId: String
    let name: String
    let monthlySalary: Int?
    let summary: PayrollWalletTotalsModel?
    let latestEntries: [PayrollLedgerEntry]

    var id: String { "\(businessId):\(employeeId)" }

    private enum Keys: String, CodingKey { case employeeId, businessId, name, monthlySalary, summary, latestEntries }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        employeeId = (try? c.decodeIfPresent(String.self, forKey: .employeeId)) ?? "—"
        businessId = (try? c.decodeIfPresent(String.self, forKey: .businessId)) ?? ""
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "—"
        monthlySalary = payrollFlexInt(c, .monthlySalary)
        summary = try? c.decodeIfPresent(PayrollWalletTotalsModel.self, forKey: .summary)
        latestEntries = (try? c.decodeIfPresent([PayrollLedgerEntry].self, forKey: .latestEntries)) ?? []
    }

    static func == (a: PayrollEmployeeWallet, b: PayrollEmployeeWallet) -> Bool { a.id == b.id }
}

/// One pending ADVANCE / WITHDRAWAL request — shown read-only, decided on the web.
struct PayrollPendingRequest: Decodable, Identifiable, Equatable {
    let id: String
    let employeeId: String
    let businessId: String?
    let type: String
    let status: String?
    let requestedAmount: Int
    let reason: String?
    let createdAt: String?

    private enum Keys: String, CodingKey { case id, employeeId, businessId, type, status, requestedAmount, reason, createdAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        employeeId = (try? c.decodeIfPresent(String.self, forKey: .employeeId)) ?? "—"
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
        type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? "—"
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        requestedAmount = payrollFlexInt(c, .requestedAmount) ?? 0
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

/// Business-level totals for the KPI strip.
struct PayrollBusinessTotals: Decodable, Equatable {
    let companyLiability: Int
    let totalCommissions: Int
    let totalBonuses: Int
    let totalMealDeductions: Int
    let totalPenalties: Int
    let currentBalance: Int

    private enum Keys: String, CodingKey {
        case companyLiability, totalCommissions, totalBonuses, totalMealDeductions, totalPenalties, currentBalance
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        companyLiability = payrollFlexInt(c, .companyLiability) ?? 0
        totalCommissions = payrollFlexInt(c, .totalCommissions) ?? 0
        totalBonuses = payrollFlexInt(c, .totalBonuses) ?? 0
        totalMealDeductions = payrollFlexInt(c, .totalMealDeductions) ?? 0
        totalPenalties = payrollFlexInt(c, .totalPenalties) ?? 0
        currentBalance = payrollFlexInt(c, .currentBalance) ?? 0
    }
}

/// /api/payroll/wallet/summary — flat today, but decode `{ ok, data: {…} }` too
/// (the codebase's apiDataSuccess wrapper appears on sibling routes).
struct PayrollSummaryResponse: Decodable {
    let wallets: [PayrollEmployeeWallet]
    let totals: PayrollBusinessTotals?
    let pendingRequests: [PayrollPendingRequest]
    let pendingAdvanceCount: Int
    let pendingWithdrawalCount: Int
    let orphanLedgerEntryCount: Int

    private enum Keys: String, CodingKey {
        case ok, data, wallets, totals, pendingRequests
        case pendingAdvanceCount, pendingWithdrawalCount, orphanLedgerEntryCount
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        wallets = (try? c.decode([PayrollEmployeeWallet].self, forKey: .wallets)) ?? []
        totals = try? c.decodeIfPresent(PayrollBusinessTotals.self, forKey: .totals)
        pendingRequests = (try? c.decode([PayrollPendingRequest].self, forKey: .pendingRequests)) ?? []
        pendingAdvanceCount = payrollFlexInt(c, .pendingAdvanceCount) ?? 0
        pendingWithdrawalCount = payrollFlexInt(c, .pendingWithdrawalCount) ?? 0
        orphanLedgerEntryCount = payrollFlexInt(c, .orphanLedgerEntryCount) ?? 0
    }
}

// ── HR dashboard slice (legacy GAS roll + timeline + salary-budget KPI) ──

struct PayrollRollRow: Decodable, Identifiable, Equatable {
    let empId: String
    let name: String
    let monthlySalary: Int
    let salaryPaid: Int
    let advanceBalance: Int
    let currentDue: Int

    var id: String { empId }

    private enum Keys: String, CodingKey {
        case empId = "emp_id", name
        case monthlySalary = "monthly_salary", salaryPaid = "salary_paid"
        case advanceBalance = "advance_balance", currentDue = "current_due"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        empId = (try? c.decodeIfPresent(String.self, forKey: .empId)) ?? UUID().uuidString
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "—"
        monthlySalary = payrollFlexInt(c, .monthlySalary) ?? 0
        salaryPaid = payrollFlexInt(c, .salaryPaid) ?? 0
        advanceBalance = payrollFlexInt(c, .advanceBalance) ?? 0
        currentDue = payrollFlexInt(c, .currentDue) ?? 0
    }
}

struct PayrollTimelineTx: Decodable, Identifiable, Equatable {
    let txId: String
    let date: String
    let empName: String
    let txType: String
    let amount: Int
    let periodYm: String?

    var id: String { txId }

    private enum Keys: String, CodingKey {
        case txId = "tx_id", date, empName = "emp_name", txType = "tx_type"
        case amount, periodYm = "period_ym"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        txId = (try? c.decodeIfPresent(String.self, forKey: .txId)) ?? UUID().uuidString
        date = (try? c.decodeIfPresent(String.self, forKey: .date)) ?? ""
        empName = (try? c.decodeIfPresent(String.self, forKey: .empName)) ?? "—"
        txType = (try? c.decodeIfPresent(String.self, forKey: .txType)) ?? "—"
        amount = payrollFlexInt(c, .amount) ?? 0
        periodYm = try? c.decodeIfPresent(String.self, forKey: .periodYm)
    }
}

struct PayrollHRDashboardResponse: Decodable {
    let totalMonthlySalary: Int
    let roll: [PayrollRollRow]
    let timeline: [PayrollTimelineTx]

    private enum Keys: String, CodingKey {
        case ok, data, kpis
        case roll = "employees_roll", timeline = "payroll_timeline"
    }
    private enum KpiKeys: String, CodingKey { case totalMonthlySalary = "total_monthly_salary" }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        if let k = try? c.nestedContainer(keyedBy: KpiKeys.self, forKey: .kpis) {
            totalMonthlySalary = payrollFlexInt(k, .totalMonthlySalary) ?? 0
        } else {
            totalMonthlySalary = 0
        }
        roll = (try? c.decode([PayrollRollRow].self, forKey: .roll)) ?? []
        timeline = (try? c.decode([PayrollTimelineTx].self, forKey: .timeline)) ?? []
    }
}

// ── Accrual preview / history / automation (read-only display) ──

struct PayrollAccrualPreview: Decodable, Equatable {
    let periodYm: String?
    let totalPreviewSalary: Int
    let alreadyAccruedCount: Int
    let employeeCount: Int

    private enum Keys: String, CodingKey { case ok, data, periodYm, totalPreviewSalary, alreadyAccruedCount, employees }
    private struct Blob: Decodable { init(from decoder: Decoder) throws {} }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        periodYm = try? c.decodeIfPresent(String.self, forKey: .periodYm)
        totalPreviewSalary = payrollFlexInt(c, .totalPreviewSalary) ?? 0
        alreadyAccruedCount = payrollFlexInt(c, .alreadyAccruedCount) ?? 0
        employeeCount = ((try? c.decodeIfPresent([Blob].self, forKey: .employees)) ?? nil)?.count ?? 0
    }
}

struct PayrollAccrualRun: Decodable, Identifiable, Equatable {
    let id: String
    let periodYm: String?
    let status: String
    let trigger: String?
    let createdCount: Int
    let skippedCount: Int

    private enum Keys: String, CodingKey { case id, periodYm, status, trigger, createdCount, skippedCount }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        periodYm = try? c.decodeIfPresent(String.self, forKey: .periodYm)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "—"
        trigger = try? c.decodeIfPresent(String.self, forKey: .trigger)
        createdCount = payrollFlexInt(c, .createdCount) ?? 0
        skippedCount = payrollFlexInt(c, .skippedCount) ?? 0
    }
}

struct PayrollAccrualHistoryResponse: Decodable {
    let runs: [PayrollAccrualRun]
    private enum Keys: String, CodingKey { case ok, data, runs }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        runs = (try? c.decode([PayrollAccrualRun].self, forKey: .runs)) ?? []
    }
}

struct PayrollAutomationResponse: Decodable {
    let enabled: Bool?
    let dayOfMonth: Int?
    let timezone: String?

    private enum Keys: String, CodingKey { case ok, data, setting, enabled, dayOfMonth, timezone }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let mid = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        let c = (try? mid.nestedContainer(keyedBy: Keys.self, forKey: .setting)) ?? mid
        enabled = try? c.decodeIfPresent(Bool.self, forKey: .enabled)
        dayOfMonth = payrollFlexInt(c, .dayOfMonth)
        timezone = try? c.decodeIfPresent(String.self, forKey: .timezone)
    }
}

// MARK: - Businesses (payroll is business-scoped — src/lib/businesses.ts)

struct PayrollBusiness: Identifiable, Equatable {
    let id: String
    let label: String
    static let all: [PayrollBusiness] = [
        .init(id: "ALMA_LIFESTYLE", label: "Alma"),
        .init(id: "CREATIVE_DIGITAL_IT", label: "CDIT"),
        .init(id: "ALMA_TRADING", label: "Trading"),
    ]
}

// MARK: - View model (READ-ONLY: only GETs, no mutation methods exist here)

@available(iOS 17.0, *)
@Observable
final class PayrollVM {
    var businessId = "ALMA_LIFESTYLE"

    // Wallet summary
    var wallets: [PayrollEmployeeWallet] = []
    var totals: PayrollBusinessTotals? = nil
    var pendingRequests: [PayrollPendingRequest] = []
    var pendingAdvanceCount = 0
    var pendingWithdrawalCount = 0
    var orphanLedgerCount = 0

    // HR dashboard slice
    var monthlySalaryBudget = 0
    var roll: [PayrollRollRow] = []
    var timeline: [PayrollTimelineTx] = []

    // Automation (display only)
    var preview: PayrollAccrualPreview? = nil
    var runs: [PayrollAccrualRun] = []
    var automationEnabled: Bool? = nil
    var automationDay: Int? = nil
    var automationTimezone: String? = nil

    // UI state
    var typeFilter = "ALL"          // ALL | SALARY_ACCRUAL | COMMISSION | PENALTY | ADVANCE | WITHDRAWAL
    var monthFilter: String? = nil  // nil = all months (timeline)
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            // The wallet summary is the page's primary dataset — it also decides auth.
            let summary: PayrollSummaryResponse = try await AlmaAPI.shared.get(
                "/api/payroll/wallet/summary", query: ["business_id": businessId])
            wallets = summary.wallets
            totals = summary.totals
            pendingRequests = summary.pendingRequests
            pendingAdvanceCount = summary.pendingAdvanceCount
            pendingWithdrawalCount = summary.pendingWithdrawalCount
            orphanLedgerCount = summary.orphanLedgerEntryCount
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
            return
        }

        // Secondary blocks — best-effort in parallel; a failure never blanks the page.
        async let hrTask: PayrollHRDashboardResponse? = Self.fetch(
            "/api/hr/dashboard", query: ["business_id": businessId])
        async let previewTask: PayrollAccrualPreview? = Self.fetch(
            "/api/payroll/wallet/accruals/preview", query: ["business_id": businessId])
        async let historyTask: PayrollAccrualHistoryResponse? = Self.fetch(
            "/api/payroll/wallet/accruals/history", query: ["business_id": businessId])
        async let automationTask: PayrollAutomationResponse? = Self.fetch(
            "/api/payroll/wallet/automation", query: [:])

        if let hr = await hrTask {
            monthlySalaryBudget = hr.totalMonthlySalary
            roll = hr.roll
            timeline = hr.timeline
        }
        preview = await previewTask
        runs = (await historyTask)?.runs ?? []
        if let auto = await automationTask {
            automationEnabled = auto.enabled
            automationDay = auto.dayOfMonth
            automationTimezone = auto.timezone
        }
    }

    private static func fetch<T: Decodable>(_ path: String, query: [String: String?]) async -> T? {
        try? await AlmaAPI.shared.get(path, query: query)
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    func setBusiness(_ id: String) async {
        guard id != businessId else { return }
        businessId = id
        monthFilter = nil
        await load()
    }

    // ── Derived (pure display filters, same logic as the web page) ──

    var filteredWallets: [PayrollEmployeeWallet] {
        wallets.filter { w in
            typeFilter == "ALL" || w.latestEntries.contains { $0.type == typeFilter }
        }
    }

    var timelineMonths: [String] {
        Array(Set(timeline.compactMap { $0.date.count >= 7 ? String($0.date.prefix(7)) : nil }))
            .sorted(by: >)
    }

    var filteredTimeline: [PayrollTimelineTx] {
        guard let m = monthFilter else { return Array(timeline.prefix(60)) }
        return Array(timeline.filter { $0.date.hasPrefix(m) }.prefix(60))
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct PayrollScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = PayrollVM()
    @State private var selected: PayrollEmployeeWallet? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                businessChips
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err) }
                kpiStrip
                if vm.loading && vm.wallets.isEmpty && !vm.authExpired {
                    loadingRows
                } else {
                    pendingRequestsSection
                    automationSection
                    walletsSection
                    legacyRollSection
                    timelineSection
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(PayrollAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { wallet in
            PayrollEmployeeDetailSheet(wallet: wallet, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Business selector (web: business context switcher) ──

    private var businessChips: some View {
        HStack(spacing: 8) {
            ForEach(PayrollBusiness.all) { biz in
                payrollChip(biz.label, active: vm.businessId == biz.id) {
                    Task { await vm.setBusiness(biz.id) }
                }
            }
            Spacer()
            let pending = vm.pendingAdvanceCount + vm.pendingWithdrawalCount
            if pending > 0 {
                Text("\(pending)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(PayrollPalette.accentText(colorScheme))
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(PayrollPalette.coral.opacity(0.18), in: Capsule())
                    .overlay(Capsule().strokeBorder(PayrollPalette.coral.opacity(0.4), lineWidth: 1))
            }
        }
        .padding(.top, 4)
    }

    // ── KPI strip (web's 6 KpiCards, exact labels + value colours) ──

    private var kpiStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("MONTHLY SALARY BUDGET", vm.monthlySalaryBudget, .primary)
                kpiCard("COMPANY LIABILITY", vm.totals?.companyLiability ?? 0, PayrollPalette.pos(colorScheme))
                kpiCard("COMMISSION TOTALS", vm.totals?.totalCommissions ?? 0, PayrollPalette.pos(colorScheme))
                kpiCard("BONUS TOTALS", vm.totals?.totalBonuses ?? 0, PayrollPalette.accentText(colorScheme))
                kpiCard("MEAL DEDUCTIONS", vm.totals?.totalMealDeductions ?? 0, PayrollPalette.red400)
                kpiCard("UNPAID BALANCE", vm.totals?.currentBalance ?? 0, .primary)
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    private func kpiCard(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(AlmaSwiftTheme.takaShort(value))
                .font(.headline.weight(.bold).monospacedDigit())
                .foregroundStyle(tint)
        }
        .frame(minWidth: 96, alignment: .leading)
        .padding(12)
        .payrollGlass(colorScheme, corner: 14)
    }

    // ── Pending wallet requests (READ-ONLY — decision happens on the web) ──

    @ViewBuilder private var pendingRequestsSection: some View {
        if !vm.pendingRequests.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("Pending wallet requests")
                ForEach(vm.pendingRequests) { req in
                    PayrollPendingRequestCard(request: req)
                }
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    openWeb("/payroll", "Payroll")
                } label: {
                    Label("অনুমোদন / বাতিল — ওয়েবে রিভিউ করুন", systemImage: "safari")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(PayrollPalette.accentText(colorScheme))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(PayrollPalette.coral.opacity(0.13), in: Capsule())
                        .overlay(Capsule().strokeBorder(PayrollPalette.coral.opacity(0.35), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .payrollGlass(colorScheme, corner: 16)
        }
    }

    // ── Monthly payroll automation (display only — toggles/run live on the web) ──

    @ViewBuilder private var automationSection: some View {
        if vm.preview != nil || !vm.runs.isEmpty || vm.automationEnabled != nil {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    sectionHeader("Monthly payroll automation")
                    Spacer()
                    if let enabled = vm.automationEnabled {
                        Text(enabled ? "চালু" : "বন্ধ")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(enabled ? PayrollPalette.pos(colorScheme) : .secondary)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background((enabled ? PayrollPalette.emerald600 : Color.secondary).opacity(0.12),
                                        in: Capsule())
                    }
                }
                Text("Runs on day \(vm.automationDay ?? 10) · credits previous month salary · \(vm.automationTimezone ?? "Asia/Dhaka")")
                    .font(.caption).foregroundStyle(.secondary)
                if let p = vm.preview {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("MONTHLY PREVIEW\(p.periodYm.map { " · \($0)" } ?? "")")
                            .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                        Text("৳ \(p.totalPreviewSalary.formatted())")
                            .font(.headline.weight(.bold).monospacedDigit())
                            .foregroundStyle(PayrollPalette.pos(colorScheme))
                        Text("\(p.employeeCount) linked employees · \(p.alreadyAccruedCount) already accrued")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(PayrollPalette.coral.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(PayrollPalette.coral.opacity(0.25), lineWidth: 1))
                }
                if !vm.runs.isEmpty {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("ACCRUAL HISTORY")
                            .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                        ForEach(vm.runs.prefix(6)) { run in
                            HStack(spacing: 8) {
                                Text(run.periodYm ?? "—")
                                    .font(.caption.monospaced()).foregroundStyle(.secondary)
                                Text(run.status)
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(PayrollPalette.runStatus(run.status, colorScheme))
                                Spacer()
                                Text(run.trigger ?? "—")
                                    .font(.caption2).foregroundStyle(.secondary)
                                Text("+\(run.createdCount) / skip \(run.skippedCount)")
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(PayrollPalette.accentText(colorScheme))
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .payrollGlass(colorScheme, corner: 16)
        }
    }

    // ── Employee wallets (web "Employee profitability and liabilities") ──

    @ViewBuilder private var walletsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Employee wallets")
            if vm.orphanLedgerCount > 0 {
                Text("\(vm.orphanLedgerCount) orphan ledger \(vm.orphanLedgerCount == 1 ? "entry" : "entries") — ওয়েবে রিভিউ করুন")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(PayrollPalette.amber600)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        typeChips
        if vm.filteredWallets.isEmpty && !vm.loading {
            emptyState("এখনো ওয়ালেট লেজার নেই")
        }
        ForEach(vm.filteredWallets) { wallet in
            PayrollWalletCard(wallet: wallet) {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                withAnimation(.spring(duration: 0.35, bounce: 0.15)) { selected = wallet }
            }
        }
    }

    /// Ledger-type filter — the web's ALL/SALARY_ACCRUAL/… pill row, native chips.
    private var typeChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(["ALL", "SALARY_ACCRUAL", "COMMISSION", "PENALTY", "ADVANCE", "WITHDRAWAL"], id: \.self) { t in
                    payrollChip(t.replacingOccurrences(of: "_", with: " "), active: vm.typeFilter == t) {
                        withAnimation(.snappy) { vm.typeFilter = t }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    // ── Legacy GAS rolling balances ──

    @ViewBuilder private var legacyRollSection: some View {
        if !vm.roll.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("Legacy GAS rolling balances")
                ForEach(vm.roll) { row in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(row.name).font(.footnote.weight(.semibold))
                        HStack(spacing: 0) {
                            rollStat("Salary", row.monthlySalary, .primary)
                            rollStat("Paid", row.salaryPaid, .secondary)
                            rollStat("Advance", max(0, row.advanceBalance), PayrollPalette.amber600)
                            rollStat("Due", max(0, row.currentDue), PayrollPalette.accentText(colorScheme))
                        }
                    }
                    .padding(.vertical, 4)
                    if row.id != vm.roll.last?.id { Divider().opacity(0.4) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .payrollGlass(colorScheme, corner: 16)
        }
    }

    private func rollStat(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(AlmaSwiftTheme.takaShort(value))
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // ── Timeline (recent payroll transactions, native month Menu picker) ──

    @ViewBuilder private var timelineSection: some View {
        if !vm.timeline.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    sectionHeader("Timeline (recent)")
                    Spacer()
                    monthMenu
                }
                ForEach(vm.filteredTimeline) { tx in
                    HStack(spacing: 8) {
                        Text(String(tx.date.prefix(10)))
                            .font(.caption2.monospaced()).foregroundStyle(.secondary)
                        Text("\(tx.empName) · \(tx.txType.replacingOccurrences(of: "_", with: " "))")
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                        Spacer()
                        Text("৳ \(tx.amount.formatted())")
                            .font(.caption.weight(.bold).monospacedDigit())
                            .foregroundStyle(PayrollPalette.accentText(colorScheme))
                    }
                    .padding(.vertical, 3)
                }
                if vm.filteredTimeline.isEmpty {
                    Text("এই মাসে কোনো লেনদেন নেই")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .payrollGlass(colorScheme, corner: 16)
        }
    }

    /// Native month picker — a Menu over the periods present in the timeline.
    private var monthMenu: some View {
        Menu {
            Button {
                vm.monthFilter = nil
            } label: {
                if vm.monthFilter == nil { Label("সব মাস", systemImage: "checkmark") }
                else { Text("সব মাস") }
            }
            ForEach(vm.timelineMonths, id: \.self) { m in
                Button {
                    vm.monthFilter = m
                } label: {
                    if vm.monthFilter == m { Label(m, systemImage: "checkmark") }
                    else { Text(m) }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "calendar")
                Text(vm.monthFilter ?? "সব মাস")
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(PayrollPalette.accentText(colorScheme))
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(PayrollPalette.coral.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(PayrollPalette.coral.opacity(0.30), lineWidth: 1))
        }
    }

    // ── Shared bits ──

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
    }

    private func payrollChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? PayrollPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? PayrollPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? PayrollPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(PayrollPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).payrollGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .payrollGlass(colorScheme, corner: 16)
    }

    private func emptyState(_ message: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: "wallet.pass").font(.largeTitle).foregroundStyle(.secondary)
            Text(message).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 110)
                .payrollGlass(colorScheme, corner: 16)
                .payrollShimmer()
        }
    }

    /// THE escape hatch — every payroll action (pay / adjust / correct / approve /
    /// run accrual / automation toggles / exports) happens on the web page.
    private var webEscape: some View {
        Button {
            openWeb("/payroll", "Payroll")
        } label: {
            Label("সব অ্যাকশন (পে · অ্যাডজাস্ট · অনুমোদন) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Pending request card (read-only row — web's request card minus buttons)

@available(iOS 17.0, *)
private struct PayrollPendingRequestCard: View {
    let request: PayrollPendingRequest
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(request.type.replacingOccurrences(of: "_", with: " ")) · \(request.employeeId)")
                    .font(.footnote.weight(.bold))
                Spacer()
                Text("৳ \(request.requestedAmount.formatted())")
                    .font(.footnote.weight(.bold).monospacedDigit())
                    .foregroundStyle(PayrollPalette.accentText(colorScheme))
            }
            if let reason = request.reason, !reason.isEmpty {
                Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack {
                if let biz = request.businessId {
                    Text(biz.replacingOccurrences(of: "_", with: " "))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if let created = request.createdAt {
                    Text(String(created.prefix(10)))
                        .font(.caption2.monospaced()).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(PayrollPalette.amber500.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10)
            .strokeBorder(PayrollPalette.amber500.opacity(0.25), lineWidth: 1))
    }
}

// MARK: - Wallet row card (mirrors one web mobile card, iOS-set: avatar + 2×2 stats)

@available(iOS 17.0, *)
private struct PayrollWalletCard: View {
    let wallet: PayrollEmployeeWallet
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text(PayrollFormat.initials(wallet.name))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(PayrollPalette.accentText(colorScheme))
                    .frame(width: 34, height: 34)
                    .background(PayrollPalette.coral.opacity(0.16), in: Circle())
                    .overlay(Circle().strokeBorder(PayrollPalette.coral.opacity(0.35), lineWidth: 1))
                VStack(alignment: .leading, spacing: 1) {
                    Text(wallet.name).font(.footnote.weight(.semibold))
                    Text(wallet.employeeId)
                        .font(.caption2.monospaced()).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
            if let s = wallet.summary {
                HStack(spacing: 0) {
                    walletStat("Earned", s.lifetimeEarned, .primary)
                    walletStat("Held", s.companyLiability, PayrollPalette.pos(colorScheme))
                    walletStat("Commission", s.totalCommissions, PayrollPalette.pos(colorScheme))
                    walletStat("Deductions", s.totalMealDeductions + s.totalPenalties, PayrollPalette.red400)
                }
            }
        }
        .padding(12)
        .payrollGlass(colorScheme, corner: 16)
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .onTapGesture(perform: onTap)
    }

    private func walletStat(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(AlmaSwiftTheme.takaShort(value))
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(tint)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Employee detail sheet (read-only wallet breakdown + latest ledger entries)

@available(iOS 17.0, *)
private struct PayrollEmployeeDetailSheet: View {
    let wallet: PayrollEmployeeWallet
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                summaryCard
                entriesCard
                webLink
            }
            .padding(18)
        }
        .presentationBackground { PayrollAurora() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(PayrollFormat.initials(wallet.name))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(PayrollPalette.accentText(colorScheme))
                .frame(width: 42, height: 42)
                .background(PayrollPalette.coral.opacity(0.16), in: Circle())
                .overlay(Circle().strokeBorder(PayrollPalette.coral.opacity(0.35), lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(wallet.name).font(.headline)
                HStack(spacing: 6) {
                    Text(wallet.employeeId).font(.caption.monospaced()).foregroundStyle(.secondary)
                    if let salary = wallet.monthlySalary, salary > 0 {
                        Text("· \(AlmaSwiftTheme.takaShort(salary))/মাস")
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    @ViewBuilder private var summaryCard: some View {
        if let s = wallet.summary {
            VStack(alignment: .leading, spacing: 10) {
                Text("WALLET SUMMARY")
                    .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                moneyRow("Lifetime earned", s.lifetimeEarned, .primary)
                moneyRow("Lifetime withdrawn", s.lifetimeWithdrawn, .secondary)
                moneyRow("Salary accrued", s.totalAccrued, .primary)
                moneyRow("Commission", s.totalCommissions, PayrollPalette.pos(colorScheme))
                moneyRow("Bonuses", s.totalBonuses, PayrollPalette.accentText(colorScheme))
                moneyRow("Overtime", s.totalOvertime, .primary)
                moneyRow("Reimbursements", s.totalReimbursements, .primary)
                moneyRow("Meal deductions", s.totalMealDeductions, PayrollPalette.red400)
                moneyRow("Penalties", s.totalPenalties, PayrollPalette.red400)
                moneyRow("Outstanding advance", s.outstandingAdvance, PayrollPalette.amber600)
                Divider().opacity(0.4)
                moneyRow("Held balance (liability)", s.companyLiability, PayrollPalette.pos(colorScheme), bold: true)
                moneyRow("Withdrawable now", s.availableWithdrawable, PayrollPalette.pos(colorScheme))
                moneyRow("This month salary added", s.thisMonthSalaryAdded, .primary)
                Text("\(s.entryCount) ledger \(s.entryCount == 1 ? "entry" : "entries")")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .payrollGlass(colorScheme, corner: 14)
        }
    }

    private func moneyRow(_ label: String, _ value: Int, _ tint: Color, bold: Bool = false) -> some View {
        HStack {
            Text(label).font(bold ? .footnote.weight(.bold) : .footnote).foregroundStyle(.secondary)
            Spacer()
            Text("৳ \(value.formatted())")
                .font((bold ? Font.footnote.weight(.bold) : .footnote.weight(.semibold)).monospacedDigit())
                .foregroundStyle(tint)
        }
    }

    @ViewBuilder private var entriesCard: some View {
        if !wallet.latestEntries.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("LATEST LEDGER ENTRIES")
                    .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                ForEach(wallet.latestEntries) { entry in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text((entry.type ?? "—").replacingOccurrences(of: "_", with: " "))
                                .font(.caption.weight(.semibold))
                            Spacer()
                            Text("\(entry.signedAmount >= 0 ? "+" : "−")৳\(abs(entry.signedAmount).formatted())")
                                .font(.caption.weight(.bold).monospacedDigit())
                                .foregroundStyle(entry.signedAmount >= 0
                                                 ? PayrollPalette.pos(colorScheme) : PayrollPalette.red400)
                        }
                        HStack(spacing: 6) {
                            if let date = entry.date {
                                Text(String(date.prefix(10)))
                                    .font(.caption2.monospaced()).foregroundStyle(.secondary)
                            }
                            if let period = entry.periodYm {
                                Text("· \(period)").font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("ব্যালেন্স ৳\(entry.runningBalance.formatted())")
                                .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        if let note = entry.note, !note.isEmpty {
                            Text(note).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    .padding(.vertical, 3)
                    if entry.id != wallet.latestEntries.last?.id { Divider().opacity(0.35) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .payrollGlass(colorScheme, corner: 14)
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            let encoded = wallet.employeeId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? wallet.employeeId
            openWeb("/employees/\(encoded)", wallet.name)
        } label: {
            Label("পুরো লেজার + অ্যাকশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Formatting helpers

private enum PayrollFormat {
    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (Payroll-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct PayrollAurora: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            if scheme == .dark {
                LinearGradient(stops: [
                    .init(color: Color(red: 0.075, green: 0.063, blue: 0.196), location: 0.0),  // deep indigo
                    .init(color: Color(red: 0.216, green: 0.125, blue: 0.439), location: 0.32), // violet
                    .init(color: Color(red: 0.478, green: 0.176, blue: 0.494), location: 0.62), // purple-magenta
                    .init(color: Color(red: 0.706, green: 0.255, blue: 0.404), location: 1.0),  // pink
                ], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [AlmaSwiftTheme.violet.opacity(0.35), .clear],
                               center: .init(x: 0.15, y: 0.18), startRadius: 10, endRadius: 420)
                RadialGradient(colors: [Color(red: 0.93, green: 0.42, blue: 0.55).opacity(0.30), .clear],
                               center: .init(x: 0.9, y: 0.85), startRadius: 20, endRadius: 480)
            } else {
                AlmaSwiftTheme.rootBg(.light)
                LinearGradient(stops: [
                    .init(color: Color(red: 0.902, green: 0.882, blue: 0.973), location: 0.0),  // pale violet
                    .init(color: Color(red: 0.949, green: 0.941, blue: 0.972), location: 0.45), // cream
                    .init(color: Color(red: 0.988, green: 0.918, blue: 0.925), location: 1.0),  // pale pink
                ], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [AlmaSwiftTheme.violet.opacity(0.14), .clear],
                               center: .init(x: 0.12, y: 0.15), startRadius: 10, endRadius: 380)
                RadialGradient(colors: [AlmaSwiftTheme.coral.opacity(0.12), .clear],
                               center: .init(x: 0.9, y: 0.9), startRadius: 20, endRadius: 420)
            }
        }
        .ignoresSafeArea()
    }
}

@available(iOS 17.0, *)
private extension View {
    func payrollGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct PayrollShimmer: ViewModifier {
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
    func payrollShimmer() -> some View { modifier(PayrollShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Payroll — Light") {
    PayrollScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
