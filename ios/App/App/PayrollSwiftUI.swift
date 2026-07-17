//
//  PayrollSwiftUI.swift
//  ALMA ERP — S7: the Payroll tab as a native SwiftUI screen (FULL ACTION PARITY).
//
//  Payroll is financially sensitive (recently-fixed wallet/salary ledger logic), so
//  every mutating call below copies the web page's endpoint + JSON body VERBATIM
//  (field names checked against the route handlers). Money-moving actions get a
//  native Bangla confirmation (amount + employee name) and a per-row spinner.
//
//  GET endpoints (same ones the web page reads):
//    /api/payroll/wallet/summary?business_id=…             → wallets + totals + pending requests
//    /api/payroll/wallet/summary?…&roster_only=true        → roster for the compensation picker
//    /api/hr/dashboard?business_id=…                       → KPIs + legacy GAS roll + timeline
//    /api/payroll/wallet/accruals/preview?business_id=…    → monthly accrual preview
//    /api/payroll/wallet/accruals/history?business_id=…    → accrual run history
//    /api/payroll/wallet/automation                        → automation setting
//    /api/payroll/meal-allowance/profiles?business_id=…    → meal allowance rows
//    /api/payroll/driving-mode/profiles?business_id=…      → driving mode rows
//
//  Mutations (exact web bodies — src/app/payroll/page.tsx):
//    PATCH /api/payroll/wallet/requests/{id}   {action, approvedAmount?, note:'', transactionId}
//    POST  /api/payroll/wallet/entries         {business_id, employee_id, type, amount, note, date}
//    POST  /api/payroll/wallet/accruals/run    {business_id}
//    PATCH /api/payroll/wallet/automation      {enabled}
//    PATCH /api/payroll/meal-allowance/profiles {business_id, userId, employeeId, enabled, amountBdt}
//    PATCH /api/payroll/driving-mode/profiles  {business_id, userId, employeeId, enabled}
//    POST  /api/payroll/driving-mode/start|end {business_id, userId}
//
//  Web-only remainder: PDF/CSV/Excel exports (client-side browser downloads) — small
//  "ওয়েব ভার্সন" link at the foot of the page.
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
    /// Salary credited for the current cycle (prior calendar month's periodYm).
    let currentCycleSalaryAdded: Int
    let cyclePeriodYm: String?
    /// periodYms with no salary accrual (owner rule: show WHO is due, WHICH month).
    let salaryDueMonths: [String]

    private enum Keys: String, CodingKey {
        case lifetimeEarned, lifetimeWithdrawn, totalAccrued, totalBonuses, totalCommissions
        case totalOvertime, totalReimbursements, totalMealDeductions, totalPenalties
        case outstandingAdvance, currentBalance, companyLiability, availableWithdrawable
        case thisMonthSalaryAdded, entryCount, salaryDueMonths
        case currentCycleSalaryAdded, cyclePeriodYm
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
        salaryDueMonths = (try? c.decodeIfPresent([String].self, forKey: .salaryDueMonths)) ?? []
        currentCycleSalaryAdded = payrollFlexInt(c, .currentCycleSalaryAdded) ?? 0
        cyclePeriodYm = try? c.decodeIfPresent(String.self, forKey: .cyclePeriodYm)
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
/// Recipient payout account on a pending withdrawal. The summary route reveals it
/// (number un-masked) ONLY to SUPER_ADMIN — so its presence IS the owner gate for
/// the native bKash send flow; ADMIN/HR payloads simply have payout: null.
struct PayrollPayoutMethod: Decodable, Equatable {
    let provider: String?
    let accountNumber: String?
    let accountHolder: String?
    let status: String?
}

struct PayrollPendingRequest: Decodable, Identifiable, Equatable {
    let id: String
    let employeeId: String
    let businessId: String?
    let type: String
    let status: String?
    let requestedAmount: Int
    let reason: String?
    let createdAt: String?
    let payout: PayrollPayoutMethod?

    private enum Keys: String, CodingKey { case id, employeeId, businessId, type, status, requestedAmount, reason, createdAt, payout }
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
        payout = try? c.decodeIfPresent(PayrollPayoutMethod.self, forKey: .payout)
    }
}

// MARK: - bKash send flow (owner-only: copy number → bkash:// → paste TrxID)

/// Half-done bKash send (owner tapped "copy + open bKash" and left for the bKash
/// app). UserDefaults so it survives iOS killing the app while the owner is away.
enum BkashSendPendingStore {
    private static let key = "alma.bkashSendPending.v1"
    /// After 12h a half-done send is stale — nagging the owner does more harm than good.
    private static let ttl: TimeInterval = 12 * 60 * 60

    struct Entry: Codable {
        let requestId: String
        let startedAt: Date
    }

    static func save(requestId: String) {
        let entry = Entry(requestId: requestId, startedAt: Date())
        if let data = try? JSONEncoder().encode(entry) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    static func read() -> Entry? {
        guard let data = UserDefaults.standard.data(forKey: key),
              let entry = try? JSONDecoder().decode(Entry.self, from: data) else { return nil }
        guard Date().timeIntervalSince(entry.startedAt) < ttl else {
            clear()
            return nil
        }
        return entry
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

/// Pull a bKash TrxID out of arbitrary pasteboard text: 10 uppercase alphanumerics
/// with at least one digit (e.g. BFJ90KAL2M). The digit guard rejects 10-letter
/// words; the boundary guards reject 11-digit phone numbers (the recipient number
/// we ourselves copied on the way out) and amounts. Mirrors src/lib/bkash-send-flow.ts.
func payrollExtractTrxId(_ text: String?) -> String? {
    guard let t = text?.uppercased(), !t.isEmpty else { return nil }
    let pattern = "(?<![A-Z0-9])(?=[A-Z0-9]{0,9}\\d)[A-Z0-9]{10}(?![A-Z0-9])"
    guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
    let range = NSRange(t.startIndex..., in: t)
    guard let m = re.firstMatch(in: t, range: range), let r = Range(m.range, in: t) else { return nil }
    return String(t[r])
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

// ── Mutation plumbing + settings tables (meal allowance / driving mode) ──

/// Tolerant decode for mutation responses — the payroll routes answer different
/// apiSuccess shapes; the UI only needs "2xx + decoded", details come from reload.
struct PayrollOkResponse: Decodable {
    let ok: Bool?
    private enum Keys: String, CodingKey { case ok }
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: Keys.self)
        if let c {
            ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil
        } else {
            ok = nil
        }
    }
}

/// User slice shared by the meal-allowance and driving-mode profile rows.
struct PayrollProfileUserDto: Decodable {
    let id: String?
    let name: String?
    let phone: String?
    let employeeIdGas: String?
}

struct PayrollMealProfileDto: Decodable {
    let enabled: Bool?
    let amountBdt: Int?
    private enum Keys: String, CodingKey { case enabled, amountBdt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        enabled = try? c.decodeIfPresent(Bool.self, forKey: .enabled)
        amountBdt = payrollFlexInt(c, .amountBdt)   // Prisma Decimal arrives stringly
    }
}

struct PayrollMealRowDto: Decodable {
    let user: PayrollProfileUserDto?
    let profile: PayrollMealProfileDto?
}

struct PayrollMealProfilesResponse: Decodable {
    let rows: [PayrollMealRowDto]
    private enum Keys: String, CodingKey { case ok, data, rows }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        rows = (try? c.decode([PayrollMealRowDto].self, forKey: .rows)) ?? []
    }
    /// Same mapping the web does: profile → editable row state, amount 0 → empty field.
    func rowStates() -> [PayrollMealRow] {
        rows.compactMap { r in
            guard let u = r.user, let id = u.id else { return nil }
            let amount = r.profile?.amountBdt ?? 0
            return PayrollMealRow(
                userId: id,
                name: u.name ?? "—",
                phone: u.phone,
                employeeId: u.employeeIdGas ?? "",
                enabled: r.profile?.enabled ?? false,
                amountText: amount > 0 ? String(amount) : "")
        }
    }
}

struct PayrollDrivingProfileDto: Decodable {
    let enabled: Bool?
    private enum Keys: String, CodingKey { case enabled }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        enabled = try? c.decodeIfPresent(Bool.self, forKey: .enabled)
    }
}

struct PayrollDrivingRowDto: Decodable {
    let user: PayrollProfileUserDto?
    let profile: PayrollDrivingProfileDto?
    let drivingStatus: String?
}

struct PayrollDrivingProfilesResponse: Decodable {
    let rows: [PayrollDrivingRowDto]
    private enum Keys: String, CodingKey { case ok, data, rows }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        rows = (try? c.decode([PayrollDrivingRowDto].self, forKey: .rows)) ?? []
    }
    func rowStates() -> [PayrollDrivingRow] {
        rows.compactMap { r in
            guard let u = r.user, let id = u.id else { return nil }
            return PayrollDrivingRow(
                userId: id,
                name: u.name ?? "—",
                phone: u.phone,
                employeeId: u.employeeIdGas ?? "",
                enabled: r.profile?.enabled ?? false,
                drivingStatus: r.drivingStatus)
        }
    }
}

/// Editable meal-allowance row (web MealProfileRowState).
struct PayrollMealRow: Identifiable, Equatable {
    let userId: String
    let name: String
    let phone: String?
    let employeeId: String
    var enabled: Bool
    var amountText: String
    var saving = false
    var id: String { userId }
}

/// Editable driving-mode row (web DrivingProfileRowState).
struct PayrollDrivingRow: Identifiable, Equatable {
    let userId: String
    let name: String
    let phone: String?
    let employeeId: String
    var enabled: Bool
    var drivingStatus: String?    // "ACTIVE" | "PENDING" | nil
    var saving = false
    var toggling = false
    var id: String { userId }
}

/// The web's PAYROLL_COMPENSATION_TYPES — value + label + credit/debit kind.
struct PayrollCompType: Identifiable, Equatable {
    let value: String
    let label: String
    let kind: String   // credit | debit | adjust
    var id: String { value }
    static let all: [PayrollCompType] = [
        .init(value: "SALARY_ACCRUAL", label: "💰 Salary credit (manual)", kind: "credit"),
        .init(value: "COMMISSION", label: "Commission earned", kind: "credit"),
        .init(value: "EID_BONUS", label: "Eid bonus", kind: "credit"),
        .init(value: "PERFORMANCE_BONUS", label: "Performance bonus", kind: "credit"),
        .init(value: "OVERTIME", label: "Overtime payment", kind: "credit"),
        .init(value: "REIMBURSEMENT", label: "Reimbursement", kind: "credit"),
        .init(value: "MEAL_DEDUCTION", label: "Meal deduction (debit)", kind: "debit"),
        .init(value: "PENALTY", label: "Penalty (debit)", kind: "debit"),
        .init(value: "ADJUSTMENT", label: "Manual adjustment", kind: "adjust"),
    ]
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

// MARK: - View model (GETs + the web page's exact mutations)

@available(iOS 17.0, *)
@Observable
@MainActor
final class PayrollVM {
    var businessId = "ALMA_LIFESTYLE"

    // Wallet summary
    var wallets: [PayrollEmployeeWallet] = []
    var totals: PayrollBusinessTotals? = nil
    var pendingRequests: [PayrollPendingRequest] = []
    var pendingAdvanceCount = 0
    var pendingWithdrawalCount = 0
    var orphanLedgerCount = 0

    // Roster (roster_only=true summary — includes employees with no ledger yet,
    // exactly what the web feeds its compensation employee <select>)
    var compWallets: [PayrollEmployeeWallet] = []

    // Meal allowance + driving mode admin tables
    var mealRows: [PayrollMealRow] = []
    var drivingRows: [PayrollDrivingRow] = []

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
    /// True once the wallet summary has loaded at least once this session — the
    /// bKash-pending restore uses it to tell "request resolved" from "not loaded yet".
    var didLoadSummary = false
    var loading = false
    var error: String? = nil
    var notice: String? = nil             // success line (the web's toast)
    var authExpired = false

    // Per-action busy state — per-row spinners, never a global one
    var busyRequestIds: Set<String> = []
    var accrualBusy = false
    var automationBusy = false
    var compBusy = false

    func load(fresh: Bool = false) async {
        loading = true
        error = nil
        defer { loading = false }
        // After a mutation the web reloads with &refresh=Date.now() to bust caches.
        var summaryQuery: [String: String?] = ["business_id": businessId]
        if fresh { summaryQuery["refresh"] = String(Int(Date().timeIntervalSince1970 * 1000)) }
        do {
            // The wallet summary is the page's primary dataset — it also decides auth.
            let summary: PayrollSummaryResponse = try await AlmaAPI.shared.get(
                "/api/payroll/wallet/summary", query: summaryQuery)
            wallets = summary.wallets
            totals = summary.totals
            pendingRequests = summary.pendingRequests
            pendingAdvanceCount = summary.pendingAdvanceCount
            pendingWithdrawalCount = summary.pendingWithdrawalCount
            orphanLedgerCount = summary.orphanLedgerEntryCount
            didLoadSummary = true
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
        // `let` (not `var`): a mutable capture in the async-let below is a Swift 6 error.
        let rosterQuery = {
            var q = summaryQuery
            q["roster_only"] = "true"
            return q
        }()
        async let rosterTask: PayrollSummaryResponse? = Self.fetch(
            "/api/payroll/wallet/summary", query: rosterQuery)
        async let hrTask: PayrollHRDashboardResponse? = Self.fetch(
            "/api/hr/dashboard", query: ["business_id": businessId])
        async let previewTask: PayrollAccrualPreview? = Self.fetch(
            "/api/payroll/wallet/accruals/preview", query: ["business_id": businessId])
        async let historyTask: PayrollAccrualHistoryResponse? = Self.fetch(
            "/api/payroll/wallet/accruals/history", query: ["business_id": businessId])
        async let automationTask: PayrollAutomationResponse? = Self.fetch(
            "/api/payroll/wallet/automation", query: [:])
        async let mealTask: PayrollMealProfilesResponse? = Self.fetch(
            "/api/payroll/meal-allowance/profiles", query: ["business_id": businessId])
        async let drivingTask: PayrollDrivingProfilesResponse? = Self.fetch(
            "/api/payroll/driving-mode/profiles", query: ["business_id": businessId])

        if let roster = await rosterTask {
            compWallets = roster.wallets
            // The web reads the orphan count off the roster call (it spans non-roster entries).
            orphanLedgerCount = roster.orphanLedgerEntryCount
        } else {
            compWallets = wallets
        }
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
        mealRows = (await mealTask)?.rowStates() ?? []
        drivingRows = (await drivingTask)?.rowStates() ?? []
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

    // ── Mutations (exact endpoints + JSON bodies the web page sends) ──

    /// Display name for an employee id — pending requests carry the id only.
    func employeeName(_ employeeId: String) -> String {
        wallets.first { $0.employeeId == employeeId }?.name
            ?? compWallets.first { $0.employeeId == employeeId }?.name
            ?? employeeId
    }

    /// APPROVE / REJECT one wallet request — web submitReview():
    /// PATCH /api/payroll/wallet/requests/{id}
    /// { action, approvedAmount (APPROVE only), note: '', transactionId }.
    func reviewRequest(_ request: PayrollPendingRequest, action: String,
                       approvedAmount: Int?, transactionId: String, paidVia: String? = nil) async {
        guard !busyRequestIds.contains(request.id) else { return }
        busyRequestIds.insert(request.id)
        notice = nil
        error = nil
        defer { busyRequestIds.remove(request.id) }
        do {
            var body: [String: AnyEncodable] = [
                "action": AnyEncodable(action),
                "note": AnyEncodable(""),
                "transactionId": AnyEncodable(transactionId.trimmingCharacters(in: .whitespacesAndNewlines)),
            ]
            if action == "APPROVE", let amount = approvedAmount {
                body["approvedAmount"] = AnyEncodable(amount)
            }
            if let paidVia, !paidVia.isEmpty {
                body["paid_via"] = AnyEncodable(paidVia)
            }
            let _: PayrollOkResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/payroll/wallet/requests/\(request.id)", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = action == "APPROVE"
                ? "অনুমোদিত — ওয়ালেট লেজার আপডেট হয়েছে"
                : "রিকোয়েস্ট বাতিল করা হয়েছে"
            withAnimation(.snappy) { pendingRequests.removeAll { $0.id == request.id } }
            await load(fresh: true)
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = error.localizedDescription
        }
    }

    /// Run the monthly salary accrual now — web runAccrual():
    /// POST /api/payroll/wallet/accruals/run  { business_id }.
    func runAccrual() async {
        guard !accrualBusy else { return }
        accrualBusy = true
        notice = nil
        error = nil
        defer { accrualBusy = false }
        do {
            let _: PayrollOkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/payroll/wallet/accruals/run", body: ["business_id": businessId])
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "মাসিক স্যালারি অ্যাক্রুয়াল চেক সম্পন্ন হয়েছে"
            await load(fresh: true)
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = error.localizedDescription
        }
    }

    /// Enable/disable the monthly automation — web toggleAutomation():
    /// PATCH /api/payroll/wallet/automation  { enabled }.
    func setAutomation(_ enabled: Bool) async {
        guard !automationBusy else { return }
        automationBusy = true
        notice = nil
        error = nil
        defer { automationBusy = false }
        do {
            let resp: PayrollAutomationResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/payroll/wallet/automation", body: ["enabled": enabled])
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            automationEnabled = resp.enabled ?? enabled
            if let day = resp.dayOfMonth { automationDay = day }
            if let tz = resp.timezone { automationTimezone = tz }
            notice = enabled ? "পেরোল অটোমেশন চালু হয়েছে" : "পেরোল অটোমেশন বন্ধ হয়েছে"
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = error.localizedDescription
        }
    }

    /// Post one compensation ledger entry — web submitCompensation():
    /// POST /api/payroll/wallet/entries
    /// { business_id, employee_id, type, amount, note, date }. Returns success.
    @discardableResult
    func postCompensation(employeeId: String, type: String, amount: Int,
                          note: String, date: Date) async -> Bool {
        guard !compBusy else { return false }
        compBusy = true
        notice = nil
        error = nil
        defer { compBusy = false }
        do {
            let body: [String: AnyEncodable] = [
                "business_id": AnyEncodable(businessId),
                "employee_id": AnyEncodable(employeeId),
                "type": AnyEncodable(type),
                "amount": AnyEncodable(amount),
                "note": AnyEncodable(note),
                "date": AnyEncodable(Self.dayFormatter.string(from: date)),
            ]
            let _: PayrollOkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/payroll/wallet/entries", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "কমপেনসেশন লেজার এন্ট্রি পোস্ট হয়েছে"
            await load(fresh: true)
            return true
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = error.localizedDescription
            return false
        }
    }

    /// Save one meal-allowance profile — web saveMealProfile():
    /// PATCH /api/payroll/meal-allowance/profiles
    /// { business_id, userId, employeeId, enabled, amountBdt (0 when disabled) }.
    func saveMealProfile(_ row: PayrollMealRow) async {
        guard let idx = mealRows.firstIndex(where: { $0.userId == row.userId }),
              !mealRows[idx].saving else { return }
        let amount = Int(row.amountText.trimmingCharacters(in: .whitespaces)) ?? 0
        if row.enabled && amount <= 0 {
            error = "চালু করার আগে সঠিক পরিমাণ (BDT) দিন"
            return
        }
        mealRows[idx].saving = true
        notice = nil
        error = nil
        do {
            let body: [String: AnyEncodable] = [
                "business_id": AnyEncodable(businessId),
                "userId": AnyEncodable(row.userId),
                "employeeId": AnyEncodable(row.employeeId),
                "enabled": AnyEncodable(row.enabled),
                "amountBdt": AnyEncodable(row.enabled ? amount : 0),
            ]
            let _: PayrollOkResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/payroll/meal-allowance/profiles", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "\(row.name) — খাবার ভাতা সেভ হয়েছে"
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = error.localizedDescription
        }
        if let i = mealRows.firstIndex(where: { $0.userId == row.userId }) {
            mealRows[i].saving = false
        }
    }

    /// Save one driving-mode profile — web saveDrivingProfile():
    /// PATCH /api/payroll/driving-mode/profiles  { business_id, userId, employeeId, enabled }.
    func saveDrivingProfile(_ row: PayrollDrivingRow) async {
        guard let idx = drivingRows.firstIndex(where: { $0.userId == row.userId }),
              !drivingRows[idx].saving else { return }
        drivingRows[idx].saving = true
        notice = nil
        error = nil
        do {
            let body: [String: AnyEncodable] = [
                "business_id": AnyEncodable(businessId),
                "userId": AnyEncodable(row.userId),
                "employeeId": AnyEncodable(row.employeeId),
                "enabled": AnyEncodable(row.enabled),
            ]
            let _: PayrollOkResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/payroll/driving-mode/profiles", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = row.enabled
                ? "\(row.name) — ড্রাইভিং মোড চালু (সেটিং) সেভ হয়েছে"
                : "\(row.name) — ড্রাইভিং মোড বন্ধ (সেটিং) সেভ হয়েছে"
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = error.localizedDescription
        }
        if let i = drivingRows.firstIndex(where: { $0.userId == row.userId }) {
            drivingRows[i].saving = false
        }
    }

    /// Start/end driving mode for a staff member NOW — web toggleDrivingNow():
    /// POST /api/payroll/driving-mode/start | /end  { business_id, userId }.
    func toggleDrivingNow(_ row: PayrollDrivingRow) async {
        guard let idx = drivingRows.firstIndex(where: { $0.userId == row.userId }),
              !drivingRows[idx].toggling else { return }
        let turningOn = row.drivingStatus != "ACTIVE"
        drivingRows[idx].toggling = true
        notice = nil
        error = nil
        do {
            let endpoint = turningOn
                ? "/api/payroll/driving-mode/start"
                : "/api/payroll/driving-mode/end"
            let body = ["business_id": businessId, "userId": row.userId]
            let _: PayrollOkResponse = try await AlmaAPI.shared.send("POST", endpoint, body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = turningOn
                ? "\(row.name) এখন ড্রাইভিং মোডে"
                : "\(row.name)-এর ড্রাইভিং মোড বন্ধ করা হলো"
            if let i = drivingRows.firstIndex(where: { $0.userId == row.userId }) {
                drivingRows[i].drivingStatus = turningOn ? "ACTIVE" : nil
            }
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = error.localizedDescription
        }
        if let i = drivingRows.firstIndex(where: { $0.userId == row.userId }) {
            drivingRows[i].toggling = false
        }
    }

    /// The web's <input type=date> value — local calendar day, Asia/Dhaka.
    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f
    }()

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
    @Environment(\.scenePhase) private var scenePhase
    @State private var vm = PayrollVM()
    @State private var selected: PayrollEmployeeWallet? = nil
    @State private var approveTarget: PayrollPendingRequest? = nil
    @State private var rejectTarget: PayrollPendingRequest? = nil
    @State private var automationTarget: Bool? = nil
    @State private var showAccrualConfirm = false
    @State private var exportShare: PayrollExportFile? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                businessChips
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err) }
                if let ok = vm.notice { successCard(ok) }
                kpiStrip
                if vm.loading && vm.wallets.isEmpty && !vm.authExpired {
                    loadingRows
                } else {
                    PayrollCompensationCard(vm: vm)
                    automationSection
                    pendingRequestsSection
                    walletsSection
                    PayrollMealAllowanceCard(vm: vm)
                    PayrollDrivingModeCard(vm: vm)
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
        .task {
            await vm.load()
            restoreBkashPending()
        }
        // Coming back from the bKash app (or a relaunch after iOS killed us there):
        // re-open the approve sheet for the half-done withdrawal so the owner can
        // paste the TrxID and finish.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { restoreBkashPending() }
        }
        .onChange(of: vm.pendingRequests) { _, _ in restoreBkashPending() }
        .sheet(item: $selected) { wallet in
            PayrollEmployeeDetailSheet(wallet: wallet, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// Re-open the approve sheet for a half-done bKash send. Only presents when the
    /// request is still in the pending list; once the list has genuinely loaded and
    /// the request is gone (approved elsewhere), the stale marker is dropped.
    private func restoreBkashPending() {
        guard approveTarget == nil, let entry = BkashSendPendingStore.read() else { return }
        if let req = vm.pendingRequests.first(where: { $0.id == entry.requestId }) {
            approveTarget = req
        } else if vm.didLoadSummary && !vm.loading {
            BkashSendPendingStore.clear()
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

    // ── KPI strip (same 6 web KpiCard totals, recomposed as the bento board:
    //    dark hero anchor + 2-col glass stat tiles — values/labels/tints unchanged) ──

    private var kpiStrip: some View {
        VStack(spacing: 10) {
            // The board's one DARK anchor widget — dark in BOTH schemes. Shows the
            // three headline totals the VM already loads; count-up is display only.
            PayrollHeroCard(budget: vm.monthlySalaryBudget,
                            liability: vm.totals?.companyLiability ?? 0,
                            unpaid: vm.totals?.currentBalance ?? 0)
            // Remaining KPI totals as frosted bento stat tiles.
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)],
                      spacing: 10) {
                PayrollStatTile(label: "COMMISSION TOTALS",
                                target: vm.totals?.totalCommissions ?? 0,
                                tint: PayrollPalette.pos(colorScheme),
                                accent: AlmaSwiftTheme.sage)
                PayrollStatTile(label: "BONUS TOTALS",
                                target: vm.totals?.totalBonuses ?? 0,
                                tint: PayrollPalette.accentText(colorScheme),
                                accent: PayrollPalette.coral)
                PayrollStatTile(label: "MEAL DEDUCTIONS",
                                target: vm.totals?.totalMealDeductions ?? 0,
                                tint: PayrollPalette.red400,
                                accent: PayrollPalette.red500)
            }
        }
    }

    // ── Pending wallet requests (native approve/reject — web submitReview parity) ──

    @ViewBuilder private var pendingRequestsSection: some View {
        if !vm.pendingRequests.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("Pending wallet requests")
                ForEach(vm.pendingRequests) { req in
                    PayrollPendingRequestCard(
                        request: req,
                        employeeName: vm.employeeName(req.employeeId),
                        busy: vm.busyRequestIds.contains(req.id),
                        onApprove: {
                            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                            approveTarget = req
                        },
                        onReject: {
                            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                            rejectTarget = req
                        })
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
            .sheet(item: $approveTarget) { req in
                PayrollReviewSheet(request: req, employeeName: vm.employeeName(req.employeeId)) { amount, txn, paidVia in
                    Task { await vm.reviewRequest(req, action: "APPROVE", approvedAmount: amount, transactionId: txn, paidVia: paidVia) }
                }
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
            }
            .confirmationDialog(
                "রিকোয়েস্ট বাতিল করবেন?",
                isPresented: Binding(get: { rejectTarget != nil },
                                     set: { if !$0 { rejectTarget = nil } }),
                titleVisibility: .visible,
                presenting: rejectTarget
            ) { req in
                Button("হ্যাঁ, বাতিল করুন", role: .destructive) {
                    Task { await vm.reviewRequest(req, action: "REJECT", approvedAmount: nil, transactionId: "") }
                }
                Button("থাক", role: .cancel) {}
            } message: { req in
                Text("\(vm.employeeName(req.employeeId)) — \(req.type.replacingOccurrences(of: "_", with: " ")) ৳ \(req.requestedAmount.formatted()) বাতিল হবে।")
            }
        }
    }

    // ── Monthly payroll automation (native toggle + run-now — web parity) ──

    private var automationSection: some View {
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
                automationButtons
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
                    .background(PayrollPalette.coral.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
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
            .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    /// Enable/disable + run-now, each behind a Bangla confirmation.
    private var automationButtons: some View {
        HStack(spacing: 8) {
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                automationTarget = !(vm.automationEnabled ?? false)
            } label: {
                Group {
                    if vm.automationBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Text((vm.automationEnabled ?? false) ? "অটোমেশন বন্ধ করুন" : "অটোমেশন চালু করুন")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(PayrollPalette.accentText(colorScheme))
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(PayrollPalette.coral.opacity(0.12), in: Capsule())
                .overlay(Capsule().strokeBorder(PayrollPalette.coral.opacity(0.32), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(vm.automationBusy)
            .confirmationDialog(
                "পেরোল অটোমেশন",
                isPresented: Binding(get: { automationTarget != nil },
                                     set: { if !$0 { automationTarget = nil } }),
                titleVisibility: .visible,
                presenting: automationTarget
            ) { enabled in
                Button(enabled ? "চালু করুন" : "বন্ধ করুন",
                       role: enabled ? nil : ButtonRole.destructive) {
                    Task { await vm.setAutomation(enabled) }
                }
                Button("থাক", role: .cancel) {}
            } message: { enabled in
                Text(enabled
                     ? "প্রতি মাসের \(vm.automationDay ?? 10) তারিখে সব কর্মচারীর স্যালারি স্বয়ংক্রিয়ভাবে ওয়ালেটে জমা হবে।"
                     : "স্বয়ংক্রিয় মাসিক স্যালারি জমা বন্ধ হয়ে যাবে।")
            }

            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                showAccrualConfirm = true
            } label: {
                Group {
                    if vm.accrualBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("এখনই চালান")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(PayrollPalette.accentText(colorScheme))
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(PayrollPalette.coral.opacity(0.18), in: Capsule())
                .overlay(Capsule().strokeBorder(PayrollPalette.coral.opacity(0.45), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(vm.accrualBusy)
            .confirmationDialog(
                "এখনই স্যালারি অ্যাক্রুয়াল চালাবেন?",
                isPresented: $showAccrualConfirm,
                titleVisibility: .visible
            ) {
                Button("হ্যাঁ, চালান") {
                    Task { await vm.runAccrual() }
                }
                Button("থাক", role: .cancel) {}
            } message: {
                Text("প্রিভিউ ৳ \((vm.preview?.totalPreviewSalary ?? 0).formatted()) — \(vm.preview?.employeeCount ?? 0) জন কর্মচারীর স্যালারি ওয়ালেটে জমা হবে (আগে জমা হয়ে থাকলে স্কিপ হবে)।")
            }
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
                        // Paid-of-salary mini bar — pure visual of the two numbers already
                        // shown above (amber while due remains, green when cleared).
                        if row.monthlySalary > 0 {
                            PayrollMiniBar(fraction: CGFloat(row.salaryPaid) / CGFloat(row.monthlySalary),
                                           color: row.currentDue > 0 ? PayrollPalette.amber500
                                                                     : PayrollPalette.emerald600)
                        }
                    }
                    .padding(.vertical, 4)
                    if row.id != vm.roll.last?.id { Divider().overlay(AlmaSwiftTheme.separator(colorScheme)) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
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
            .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
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
                // Accessibility text sizes: keep the pill a pill — one line, shrink
                // instead of hyphenating ("Trad-ing" broke into a tall oval at AX sizes).
                .lineLimit(1).minimumScaleFactor(0.5)
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
            .padding(12).payrollGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    /// Success line after a mutation — the web's green toast, native form.
    private func successCard(_ message: String) -> some View {
        Label(message, systemImage: "checkmark.circle")
            .font(.footnote).foregroundStyle(PayrollPalette.pos(colorScheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).payrollGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
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
                .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .payrollShimmer()
        }
    }

    /// Native exports (owner 2026-07-11): payroll-wallet PDF + CSV built on-device
    /// ON TAP and shared via the iOS sheet; Excel stays web (CSV opens in Excel).
    private var webEscape: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                exportButton("PDF", icon: "doc.richtext") { payrollPdfFile() }
                exportButton("CSV", icon: "tablecells") { payrollCsvFile() }
            }
            Button {
                openWeb("/payroll", "Payroll")
            } label: {
                Label("ওয়েব ভার্সন (Excel export)", systemImage: "safari").font(.caption)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .sheet(item: $exportShare) { wrap in
            PayrollShareSheet(url: wrap.url)
                .presentationDetents([.medium])
        }
    }

    private func exportButton(_ label: String, icon: String,
                              make: @escaping () -> URL?) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            if let url = make() { exportShare = PayrollExportFile(url: url) }
        } label: {
            Label(label, systemImage: icon)
                .font(.caption.weight(.bold))
                .frame(maxWidth: .infinity).padding(.vertical, 9)
        }
        .buttonStyle(.bordered)
        .disabled(vm.wallets.isEmpty)
    }

    /// payrollWalletsToCsv() column parity (email is not in the native payload → blank).
    private func payrollCsvFile() -> URL? {
        func esc(_ s: String) -> String {
            s.contains(where: { ",\"\n".contains($0) }) ? "\"\(s.replacingOccurrences(of: "\"", with: "\"\""))\"" : s
        }
        let header = ["Business", "Employee ID", "Name", "Email", "Monthly Salary",
                      "Salary Earned", "Commission", "Bonuses", "Overtime", "Reimbursements",
                      "Meal Deductions", "Penalties", "Lifetime Earned", "Lifetime Withdrawn",
                      "Current Balance", "Company Liability"]
        // Built with explicit appends — the one-shot 16-element literal made the
        // Release type-checker time out ("unable to type-check in reasonable time").
        var lines: [String] = []
        for w in vm.wallets {
            let s = w.summary
            var cols: [String] = [w.businessId, w.employeeId, w.name, ""]
            cols.append(String(w.monthlySalary ?? 0))
            cols.append(String(s?.totalAccrued ?? 0))
            cols.append(String(s?.totalCommissions ?? 0))
            cols.append(String(s?.totalBonuses ?? 0))
            cols.append(String(s?.totalOvertime ?? 0))
            cols.append(String(s?.totalReimbursements ?? 0))
            cols.append(String(s?.totalMealDeductions ?? 0))
            cols.append(String(s?.totalPenalties ?? 0))
            cols.append(String(s?.lifetimeEarned ?? 0))
            cols.append(String(s?.lifetimeWithdrawn ?? 0))
            cols.append(String(s?.currentBalance ?? 0))
            cols.append(String(s?.companyLiability ?? 0))
            lines.append(cols.map(esc).joined(separator: ","))
        }
        let csv = "\u{FEFF}" + header.joined(separator: ",") + "\n" + lines.joined(separator: "\n")
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("payroll-wallet-\(vm.businessId).csv")
        try? csv.data(using: .utf8)?.write(to: url)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    /// Native wallet-ledger PDF — same data story as the web PDF (per-employee rows
    /// with earned/withdrawn/balance/liability, business total footer).
    private func payrollPdfFile() -> URL? {
        let rows = vm.wallets
        let businessId = vm.businessId
        let pageRect = CGRect(x: 0, y: 0, width: 595, height: 842)   // A4 @72dpi
        let renderer = UIGraphicsPDFRenderer(bounds: pageRect)
        let margin: CGFloat = 36
        let colX: [CGFloat] = [36, 170, 260, 340, 420, 500]   // name/salary/earned/withdrawn/balance/liability
        let data = renderer.pdfData { ctx in
            var y: CGFloat = 0
            func newPage() {
                ctx.beginPage()
                y = margin
                "Payroll wallet ledger".draw(at: CGPoint(x: margin, y: y),
                    withAttributes: [.font: UIFont.boldSystemFont(ofSize: 16)])
                y += 22
                businessId.draw(at: CGPoint(x: margin, y: y),
                    withAttributes: [.font: UIFont.systemFont(ofSize: 9), .foregroundColor: UIColor.darkGray])
                y += 20
                let headers = ["Employee", "Salary", "Earned", "Withdrawn", "Balance", "Liability"]
                for (i, h) in headers.enumerated() {
                    h.draw(at: CGPoint(x: colX[i], y: y),
                           withAttributes: [.font: UIFont.boldSystemFont(ofSize: 8)])
                }
                y += 14
            }
            newPage()
            let cell: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 8)]
            for w in rows {
                if y > pageRect.height - margin - 30 { newPage() }
                String(w.name.prefix(26)).draw(at: CGPoint(x: colX[0], y: y), withAttributes: cell)
                "৳\((w.monthlySalary ?? 0).formatted())".draw(at: CGPoint(x: colX[1], y: y), withAttributes: cell)
                "৳\((w.summary?.lifetimeEarned ?? 0).formatted())".draw(at: CGPoint(x: colX[2], y: y), withAttributes: cell)
                "৳\((w.summary?.lifetimeWithdrawn ?? 0).formatted())".draw(at: CGPoint(x: colX[3], y: y), withAttributes: cell)
                "৳\((w.summary?.currentBalance ?? 0).formatted())".draw(at: CGPoint(x: colX[4], y: y), withAttributes: cell)
                "৳\((w.summary?.companyLiability ?? 0).formatted())".draw(at: CGPoint(x: colX[5], y: y), withAttributes: cell)
                y += 12
            }
            y += 8
            let liability = rows.reduce(0) { $0 + ($1.summary?.companyLiability ?? 0) }
            "Total company liability: ৳\(liability.formatted())".draw(
                at: CGPoint(x: colX[3], y: y),
                withAttributes: [.font: UIFont.boldSystemFont(ofSize: 10)])
        }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("payroll-wallet-\(vm.businessId).pdf")
        try? data.write(to: url)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }
}

/// Identifiable wrapper so a freshly generated export can drive a .sheet(item:).
private struct PayrollExportFile: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

/// UIActivityViewController bridge — share the generated ledger file.
@available(iOS 17.0, *)
private struct PayrollShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

// MARK: - Pending request card (web request row + native Approve/Reject buttons)

@available(iOS 17.0, *)
private struct PayrollPendingRequestCard: View {
    let request: PayrollPendingRequest
    let employeeName: String
    let busy: Bool
    let onApprove: () -> Void
    let onReject: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(request.type.replacingOccurrences(of: "_", with: " ")) · \(employeeName)")
                    .font(.footnote.weight(.bold))
                    .lineLimit(1)
                Spacer()
                Text("৳ \(request.requestedAmount.formatted())")
                    .font(.footnote.weight(.bold).monospacedDigit())
                    .foregroundStyle(PayrollPalette.accentText(colorScheme))
            }
            if let reason = request.reason, !reason.isEmpty {
                Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            HStack {
                Text(request.employeeId)
                    .font(.caption2.monospaced()).foregroundStyle(.secondary)
                if let biz = request.businessId {
                    Text("· \(biz.replacingOccurrences(of: "_", with: " "))")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if let created = request.createdAt {
                    Text(String(created.prefix(10)))
                        .font(.caption2.monospaced()).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 8) {
                Spacer()
                if busy {
                    ProgressView().controlSize(.small)
                    Text("প্রসেস হচ্ছে…").font(.caption2).foregroundStyle(.secondary)
                } else {
                    Button(action: onReject) {
                        Text("বাতিল")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(PayrollPalette.red500)
                            .padding(.horizontal, 14).padding(.vertical, 6)
                            .background(PayrollPalette.red500.opacity(0.10), in: Capsule())
                            .overlay(Capsule().strokeBorder(PayrollPalette.red500.opacity(0.35), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    Button(action: onApprove) {
                        Text("অনুমোদন")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(PayrollPalette.accentText(colorScheme))
                            .padding(.horizontal, 14).padding(.vertical, 6)
                            .background(PayrollPalette.coral.opacity(0.18), in: Capsule())
                            .overlay(Capsule().strokeBorder(PayrollPalette.coral.opacity(0.45), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(PayrollPalette.amber500.opacity(0.07), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(PayrollPalette.amber500.opacity(0.25), lineWidth: 1))
    }
}

// MARK: - Approve sheet (web review modal parity — amount + txn id for withdrawals)

@available(iOS 17.0, *)
private struct PayrollReviewSheet: View {
    let request: PayrollPendingRequest
    let employeeName: String
    let onConfirm: (_ approvedAmount: Int, _ transactionId: String, _ paidVia: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var amountText: String
    @State private var txn = ""
    @State private var paidVia = ""
    /// True when this sheet was re-opened after the owner came back from the bKash
    /// app (a BkashSendPendingStore entry exists for this request).
    @State private var resumedFromBkash = false
    @State private var submitted = false
    @FocusState private var focused: Bool

    private static let paidViaOptions: [(String, String)] = [
        ("CASH", "ক্যাশ"), ("BKASH", "বিকাশ"), ("NAGAD", "নগদ"), ("BANK", "ব্যাংক"),
    ]

    init(request: PayrollPendingRequest, employeeName: String,
         onConfirm: @escaping (_ approvedAmount: Int, _ transactionId: String, _ paidVia: String) -> Void) {
        self.request = request
        self.employeeName = employeeName
        self.onConfirm = onConfirm
        _amountText = State(initialValue: String(request.requestedAmount))
    }

    private var amount: Int? { Int(amountText.trimmingCharacters(in: .whitespaces)) }
    // Cash handovers have no transaction reference; every other channel keeps one.
    private var needsTxn: Bool { request.type == "WITHDRAWAL" && paidVia != "CASH" }
    private var txnTrimmed: String { txn.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// Owner-only bKash send flow: the server includes payout (number revealed)
    /// only for SUPER_ADMIN, so payout presence is the role gate.
    private var bkashPayoutNumber: String? {
        guard request.type == "WITHDRAWAL", paidVia == "BKASH",
              let payout = request.payout, payout.provider == "BKASH",
              let number = payout.accountNumber, !number.isEmpty, number != "—" else { return nil }
        return number
    }
    private var valid: Bool {
        guard let a = amount, a > 0, a <= request.requestedAmount else { return false }
        guard !paidVia.isEmpty else { return false }
        return !needsTxn || !txnTrimmed.isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Approve wallet request").font(.headline)
                Text("\(employeeName) · \(request.type.replacingOccurrences(of: "_", with: " ")) · চাওয়া হয়েছে ৳ \(request.requestedAmount.formatted())")
                    .font(.caption).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 6) {
                    Text("APPROVED AMOUNT").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                    TextField("Amount", text: $amountText)
                        .keyboardType(.numberPad)
                        .focused($focused)
                        .padding(12)
                        .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                }
                if let a = amount, a > request.requestedAmount {
                    Text("চাওয়া পরিমাণের (৳ \(request.requestedAmount.formatted())) বেশি অনুমোদন করা যাবে না")
                        .font(.caption2).foregroundStyle(PayrollPalette.amber600)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("কীভাবে টাকা দিলেন").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                    HStack(spacing: 8) {
                        ForEach(Self.paidViaOptions, id: \.0) { value, label in
                            Button {
                                paidVia = value
                            } label: {
                                Text(label)
                                    .font(.caption.weight(.bold))
                                    .padding(.horizontal, 13).padding(.vertical, 7)
                                    .background(paidVia == value ? PayrollPalette.coral : Color.clear, in: Capsule())
                                    .foregroundStyle(paidVia == value ? .white : .secondary)
                                    .overlay(Capsule().strokeBorder(paidVia == value ? PayrollPalette.coral : Color.secondary.opacity(0.35), lineWidth: 1))
                            }
                        }
                    }
                    if paidVia.isEmpty {
                        Text("ক্যাশ/বিকাশ/নগদ/ব্যাংক — একটা বাছাই আবশ্যক; লেনদেনের খাতায় লেখা থাকবে।")
                            .font(.caption2).foregroundStyle(PayrollPalette.amber600)
                    }
                }
                if let number = bkashPayoutNumber {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(resumedFromBkash
                             ? "বিকাশ থেকে ফিরেছেন — TrxID পেস্ট করে অনুমোদন শেষ করুন"
                             : "প্রাপকের বিকাশ" + (request.payout?.accountHolder.map { " · \($0)" } ?? ""))
                            .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                        Text(number).font(.callout.weight(.bold)).monospaced()
                        if !resumedFromBkash {
                            Button {
                                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                                UIPasteboard.general.string = number
                                BkashSendPendingStore.save(requestId: request.id)
                                if let url = URL(string: "bkash://") {
                                    UIApplication.shared.open(url)
                                }
                            } label: {
                                Label("নম্বর কপি করে বিকাশ খুলুন", systemImage: "arrow.up.forward.app")
                                    .font(.caption.weight(.bold))
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(PayrollPalette.coral)
                        }
                        Text(resumedFromBkash
                             ? "বিকাশের সফল স্ক্রিনে TrxID কপি করে থাকলে নিচের পেস্ট বাটনেই বসবে।"
                             : "টাকা পাঠিয়ে অ্যাপে ফিরে এলে এই শিটটাই আবার খুলবে — তখন TrxID পেস্ট করলেই শেষ।")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(PayrollPalette.coral.opacity(0.08),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                        .strokeBorder(PayrollPalette.coral.opacity(0.25), lineWidth: 1))
                }
                if needsTxn {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("TRANSACTION ID").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                        HStack(spacing: 8) {
                            TextField("যে নম্বর/ID থেকে টাকা পাঠালেন", text: $txn)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .padding(12)
                                .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                            if bkashPayoutNumber != nil {
                                // UIPasteboard read is gesture-gated by iOS (paste banner) —
                                // extract a TrxID-shaped token, never the phone number we copied.
                                Button("পেস্ট") {
                                    if let trx = payrollExtractTrxId(UIPasteboard.general.string) {
                                        txn = trx
                                    }
                                }
                                .font(.caption.weight(.bold))
                                .buttonStyle(.bordered)
                                .tint(PayrollPalette.coral)
                            }
                        }
                    }
                    Text(txnTrimmed.isEmpty ? "Transaction ID আবশ্যক" : "এই ID সহ staff-কে SMS পাঠানো হবে।")
                        .font(.caption2)
                        .foregroundStyle(txnTrimmed.isEmpty ? PayrollPalette.amber600 : Color.secondary)
                }
                Button {
                    guard let a = amount else { return }
                    submitted = true
                    if BkashSendPendingStore.read()?.requestId == request.id {
                        BkashSendPendingStore.clear()
                    }
                    dismiss()
                    onConfirm(a, txnTrimmed, paidVia)
                } label: {
                    Text("অনুমোদন করুন — ৳ \((amount ?? 0).formatted())")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(PayrollPalette.coral)
                .disabled(!valid)
            }
            .padding(18)
        }
        .presentationBackground { PayrollAurora() }
        .onAppear {
            focused = true
            // Sheet re-opened after returning from the bKash app: pre-select বিকাশ
            // and switch the copy to "paste the TrxID to finish".
            if BkashSendPendingStore.read()?.requestId == request.id {
                resumedFromBkash = true
                paidVia = "BKASH"
                focused = false
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // The sheet usually survives the round-trip to the bKash app (no relaunch);
            // returning flips it into "paste the TrxID" mode.
            if phase == .active, BkashSendPendingStore.read()?.requestId == request.id {
                resumedFromBkash = true
                paidVia = "BKASH"
            }
        }
        .onDisappear {
            // Dismissed without confirming → drop the half-done marker so the sheet
            // stops re-opening on every foreground (owner can restart from the list).
            if !submitted, BkashSendPendingStore.read()?.requestId == request.id {
                BkashSendPendingStore.clear()
            }
        }
    }
}

// MARK: - Compensation tools (web "Compensation tools" card — POST wallet entries)

@available(iOS 17.0, *)
private struct PayrollCompensationCard: View {
    let vm: PayrollVM
    @Environment(\.colorScheme) private var colorScheme
    @State private var employeeId = ""
    @State private var type = "EID_BONUS"      // web default
    @State private var amountText = ""
    @State private var note = ""
    @State private var date = Date()
    @State private var showConfirm = false

    private var roster: [PayrollEmployeeWallet] { vm.compWallets.isEmpty ? vm.wallets : vm.compWallets }
    private var selectedName: String? { roster.first { $0.employeeId == employeeId }?.name }
    private var compType: PayrollCompType {
        PayrollCompType.all.first { $0.value == type } ?? PayrollCompType.all[0]
    }
    private var amount: Int? { Int(amountText.trimmingCharacters(in: .whitespaces)) }
    private var valid: Bool {
        guard !employeeId.isEmpty, let a = amount, a != 0 else { return false }
        return type == "ADJUSTMENT" || a > 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Compensation tools")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            Text("স্যালারি ক্রেডিট, বোনাস, কমিশন, ওভারটাইম, রিইমবার্সমেন্ট, কর্তন, জরিমানা বা অ্যাডজাস্টমেন্ট — সরাসরি ওয়ালেট লেজারে পোস্ট করুন।")
                .font(.caption2).foregroundStyle(.secondary)
            employeeMenu
            typeMenu
            HStack(spacing: 8) {
                TextField(type == "ADJUSTMENT" ? "Amount (+/-)" : "Amount", text: $amountText)
                    .keyboardType(type == "ADJUSTMENT" ? .numbersAndPunctuation : .numberPad)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                DatePicker("", selection: $date, displayedComponents: .date)
                    .labelsHidden()
            }
            TextField("Note", text: $note)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            postButton
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var employeeMenu: some View {
        Menu {
            ForEach(roster) { w in
                Button {
                    employeeId = w.employeeId
                } label: {
                    if employeeId == w.employeeId {
                        Label("\(w.name) · \(w.employeeId)", systemImage: "checkmark")
                    } else {
                        Text("\(w.name) · \(w.employeeId)")
                    }
                }
            }
        } label: {
            menuLabel(selectedName.map { "\($0) · \(employeeId)" } ?? "কর্মচারী বাছাই করুন",
                      icon: "person")
        }
    }

    private var typeMenu: some View {
        Menu {
            ForEach(PayrollCompType.all) { t in
                Button {
                    type = t.value
                } label: {
                    if type == t.value {
                        Label(typeMenuTitle(t), systemImage: "checkmark")
                    } else {
                        Text(typeMenuTitle(t))
                    }
                }
            }
        } label: {
            menuLabel(typeMenuTitle(compType), icon: "tag")
        }
    }

    private func typeMenuTitle(_ t: PayrollCompType) -> String {
        t.kind == "credit" ? "\(t.label) · credit"
            : t.kind == "debit" ? "\(t.label) · debit"
            : t.label
    }

    private func menuLabel(_ text: String, icon: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).font(.caption)
            Text(text).font(.footnote).lineLimit(1)
            Spacer()
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 9, weight: .bold))
        }
        .foregroundStyle(PayrollPalette.accentText(colorScheme))
        .padding(.horizontal, 12).padding(.vertical, 9)
        .background(PayrollPalette.coral.opacity(0.08), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(PayrollPalette.coral.opacity(0.28), lineWidth: 1))
    }

    private var postButton: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            showConfirm = true
        } label: {
            Group {
                if vm.compBusy {
                    ProgressView().controlSize(.small)
                } else {
                    Text("পোস্ট করুন")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(PayrollPalette.accentText(colorScheme))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(PayrollPalette.coral.opacity(0.16), in: Capsule())
            .overlay(Capsule().strokeBorder(PayrollPalette.coral.opacity(0.4), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(!valid || vm.compBusy)
        .confirmationDialog("লেজারে পোস্ট করবেন?", isPresented: $showConfirm, titleVisibility: .visible) {
            Button("হ্যাঁ, পোস্ট করুন") {
                guard let a = amount else { return }
                Task {
                    if await vm.postCompensation(employeeId: employeeId, type: type,
                                                 amount: a, note: note, date: date) {
                        amountText = ""
                        note = ""
                    }
                }
            }
            Button("থাক", role: .cancel) {}
        } message: {
            Text("\(selectedName ?? employeeId) — \(compType.label) ৳ \((amount ?? 0).formatted()) \(compType.kind == "debit" ? "(ডেবিট — ব্যালেন্স থেকে কাটা যাবে)" : compType.kind == "credit" ? "(ক্রেডিট — ওয়ালেটে যোগ হবে)" : "(অ্যাডজাস্টমেন্ট)") লেজারে পোস্ট হবে।")
        }
    }
}

// MARK: - Meal allowance settings (web card — PATCH meal-allowance profiles)

@available(iOS 17.0, *)
private struct PayrollMealAllowanceCard: View {
    @Bindable var vm: PayrollVM
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Meal Allowance Settings")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            Text("যেদিন রান্না হয় না, চালু-করা কর্মচারীরা খাবার ভাতা রিকোয়েস্ট করতে পারবে।")
                .font(.caption2).foregroundStyle(.secondary)
            if vm.mealRows.isEmpty {
                Text("এই ব্যবসায় লিঙ্ক করা কর্মচারী নেই")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach($vm.mealRows) { $row in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.name).font(.footnote.weight(.semibold))
                            Text(row.employeeId.isEmpty ? "—" : row.employeeId)
                                .font(.caption2.monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Toggle("", isOn: $row.enabled)
                            .labelsHidden()
                            .tint(PayrollPalette.coral)
                    }
                    HStack(spacing: 8) {
                        TextField("Amount (BDT)", text: $row.amountText)
                            .keyboardType(.numberPad)
                            .disabled(!row.enabled)
                            .opacity(row.enabled ? 1 : 0.4)
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                        mealSaveButton(row)
                    }
                }
                .padding(.vertical, 4)
                if row.id != vm.mealRows.last?.id { Divider().overlay(AlmaSwiftTheme.separator(colorScheme)) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func mealSaveButton(_ row: PayrollMealRow) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            Task { await vm.saveMealProfile(row) }
        } label: {
            Group {
                if row.saving {
                    ProgressView().controlSize(.small)
                } else {
                    Text("সেভ").font(.caption.weight(.semibold))
                        .foregroundStyle(PayrollPalette.accentText(colorScheme))
                }
            }
            .frame(width: 54)
            .padding(.vertical, 8)
            .background(PayrollPalette.coral.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(PayrollPalette.coral.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(row.saving || (row.enabled && (Int(row.amountText.trimmingCharacters(in: .whitespaces)) ?? 0) <= 0))
    }
}

// MARK: - Driving mode settings (web card — profiles PATCH + start/end POST)

@available(iOS 17.0, *)
private struct PayrollDrivingModeCard: View {
    @Bindable var vm: PayrollVM
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Driving Mode Settings")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            Text("রাস্তায় যাওয়া স্টাফদের জন্য ড্রাইভিং মোড চালু করুন — চালু থাকলে এজেন্ট অফিস ফলো-আপ বন্ধ রাখে।")
                .font(.caption2).foregroundStyle(.secondary)
            if vm.drivingRows.isEmpty {
                Text("এই ব্যবসায় লিঙ্ক করা কর্মচারী নেই")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach($vm.drivingRows) { $row in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.name).font(.footnote.weight(.semibold))
                            Text(row.employeeId.isEmpty ? "—" : row.employeeId)
                                .font(.caption2.monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        statusBadge(row)
                        Toggle("", isOn: $row.enabled)
                            .labelsHidden()
                            .tint(PayrollPalette.coral)
                    }
                    HStack(spacing: 8) {
                        if row.enabled && row.drivingStatus != "PENDING" {
                            driveNowButton(row)
                        }
                        Spacer()
                        drivingSaveButton(row)
                    }
                }
                .padding(.vertical, 4)
                if row.id != vm.drivingRows.last?.id { Divider().overlay(AlmaSwiftTheme.separator(colorScheme)) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    @ViewBuilder private func statusBadge(_ row: PayrollDrivingRow) -> some View {
        if row.drivingStatus == "ACTIVE" {
            Text("Driving")
                .font(.caption2.weight(.bold))
                .foregroundStyle(PayrollPalette.pos(colorScheme))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(PayrollPalette.emerald600.opacity(0.15), in: Capsule())
        } else if row.drivingStatus == "PENDING" {
            Text("Pending")
                .font(.caption2.weight(.bold))
                .foregroundStyle(PayrollPalette.amber600)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(PayrollPalette.amber500.opacity(0.15), in: Capsule())
        }
    }

    private func driveNowButton(_ row: PayrollDrivingRow) -> some View {
        let active = row.drivingStatus == "ACTIVE"
        return Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            Task { await vm.toggleDrivingNow(row) }
        } label: {
            Group {
                if row.toggling {
                    ProgressView().controlSize(.small)
                } else {
                    Text(active ? "শেষ করুন" : "এখনই ড্রাইভিং")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(active ? PayrollPalette.red500
                                                : PayrollPalette.accentText(colorScheme))
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            .background((active ? PayrollPalette.red500 : PayrollPalette.coral).opacity(0.12),
                        in: Capsule())
            .overlay(Capsule().strokeBorder(
                (active ? PayrollPalette.red500 : PayrollPalette.coral).opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(row.toggling)
    }

    private func drivingSaveButton(_ row: PayrollDrivingRow) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            Task { await vm.saveDrivingProfile(row) }
        } label: {
            Group {
                if row.saving {
                    ProgressView().controlSize(.small)
                } else {
                    Text("সেভ").font(.caption.weight(.semibold))
                        .foregroundStyle(PayrollPalette.accentText(colorScheme))
                }
            }
            .frame(width: 54)
            .padding(.vertical, 8)
            .background(PayrollPalette.coral.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(PayrollPalette.coral.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(row.saving)
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
                // Owner rule 2026-07-11: super admin must see WHO is unpaid and WHICH month.
                if !s.salaryDueMonths.isEmpty, (wallet.monthlySalary ?? 0) > 0 {
                    Text("বেতন বাকি — " + s.salaryDueMonths.map { PayrollFormat.periodBn($0) }.joined(separator: ", "))
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(PayrollPalette.amber600)
                        .padding(.horizontal, 9).padding(.vertical, 3)
                        .background(PayrollPalette.amber600.opacity(0.14), in: Capsule())
                }
                HStack(spacing: 0) {
                    walletStat("Earned", s.lifetimeEarned, .primary)
                    walletStat("Held", s.companyLiability, PayrollPalette.pos(colorScheme))
                    walletStat("Commission", s.totalCommissions, PayrollPalette.pos(colorScheme))
                    walletStat("Deductions", s.totalMealDeductions + s.totalPenalties, PayrollPalette.red400)
                }
            }
        }
        .padding(12)
        .background { payrollBentoWash(accentTint, scheme: colorScheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.10 : 0.45), lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture(perform: onTap)
    }

    /// Soft severity wash — outstanding advance reads amber, otherwise brand violet.
    private var accentTint: Color {
        (wallet.summary?.outstandingAdvance ?? 0) > 0 ? PayrollPalette.amber500 : AlmaSwiftTheme.violet
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
    @State private var statementOpen = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                if let s = wallet.summary, !s.salaryDueMonths.isEmpty, (wallet.monthlySalary ?? 0) > 0 {
                    Text("বেতন বাকি — " + s.salaryDueMonths.map { PayrollFormat.periodBn($0) }.joined(separator: ", ")
                         + " · ৳ \((s.salaryDueMonths.count * (wallet.monthlySalary ?? 0)).formatted())")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(PayrollPalette.amber600)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(PayrollPalette.amber600.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                }
                statementButton
                summaryCard
                entriesCard
                webLink
            }
            .padding(18)
        }
        .presentationBackground { PayrollAurora() }
        .fullScreenCover(isPresented: $statementOpen) {
            WalletStatementScreen(employeeId: wallet.employeeId, businessId: wallet.businessId, allowAppeal: false)
        }
    }

    /// Boss opens the employee's FULL transparency statement (fines + appeal
    /// history + period totals) — owner spec 2026-07-11.
    private var statementButton: some View {
        Button {
            statementOpen = true
        } label: {
            HStack {
                Text("সম্পূর্ণ হিসাব — জরিমানা ও আপিলসহ")
                    .font(.caption.weight(.bold))
                Spacer()
                Image(systemName: "chevron.right").font(.caption2.weight(.bold))
            }
            .foregroundStyle(PayrollPalette.coral)
            .padding(13)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 13))
        }
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
                Divider().overlay(AlmaSwiftTheme.separator(colorScheme))
                moneyRow("Held balance (liability)", s.companyLiability, PayrollPalette.pos(colorScheme), bold: true)
                moneyRow("Withdrawable now", s.availableWithdrawable, PayrollPalette.pos(colorScheme))
                moneyRow(
                    "এই চক্রের বেতন" + (s.cyclePeriodYm.map { " (\(PayrollFormat.periodBn($0)))" } ?? ""),
                    s.currentCycleSalaryAdded,
                    s.currentCycleSalaryAdded > 0 ? PayrollPalette.pos(colorScheme) : .primary
                )
                Text("\(s.entryCount) ledger \(s.entryCount == 1 ? "entry" : "entries")")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
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
                    if entry.id != wallet.latestEntries.last?.id { Divider().overlay(AlmaSwiftTheme.separator(colorScheme)) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .payrollGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
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

    private static let bnDigits: [Character: Character] = [
        "0": "০", "1": "১", "2": "২", "3": "৩", "4": "৪",
        "5": "৫", "6": "৬", "7": "৭", "8": "৮", "9": "৯",
    ]
    private static let bnMonths = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন",
                                   "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"]

    /// "2026-06" → "জুন ২০২৬"
    static func periodBn(_ ym: String) -> String {
        let parts = ym.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2, (1...12).contains(parts[1]) else { return ym }
        let year = String(String(parts[0]).map { bnDigits[$0] ?? $0 })
        return "\(bnMonths[parts[1] - 1]) \(year)"
    }
}

// MARK: - Bento presentation (Payroll-owned copies of the Dashboard bento language —
// per-file copies by repo convention, no cross-file imports. Hero shimmer deliberately
// OMITTED (it needs blur + repeatForever); the hero here is a static gradient.)

/// Central motion gate for the bento animations — count-ups and bar sweeps freeze to
/// their final state under Reduce Motion or Low Power Mode (dashMotionOK pattern).
@available(iOS 17.0, *)
private func payrollMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number: animates 0 → target on first appear via a single Animatable
/// interpolation — no timers. Snaps straight to the final value when motion is gated.
/// PRESENTATION ONLY: `format` must be one of the file's existing money/number
/// formatters — never re-derives or reformats amounts.
@available(iOS 17.0, *)
private struct PayrollCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        PayrollCountUpText(value: shown, format: format)
            .animation(payrollMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if payrollMotionOK(reduceMotion) {
                    appeared = true          // the implicit spring above interpolates the digits
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

/// Animatable text body for PayrollCountUp — SwiftUI interpolates `value` frame-to-frame.
@available(iOS 17.0, *)
private struct PayrollCountUpText: View, Animatable {
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

/// Soft gradient mini progress bar — sweeps to its fraction on appear, frozen when
/// motion is gated. Used only where a row already displays both numbers of a fraction.
@available(iOS 17.0, *)
private struct PayrollMiniBar: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let fraction: CGFloat
    let color: Color
    var height: CGFloat = 6
    @State private var grow = false

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(scheme == .dark ? 0.10 : 0.06))
                Capsule()
                    .fill(LinearGradient(colors: [color.opacity(0.55), color],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(geo.size.width * min(max(fraction, 0), 1), height) * (grow ? 1 : 0.001))
            }
        }
        .frame(height: height)
        .onAppear {
            if payrollMotionOK(reduceMotion) {
                withAnimation(.spring(duration: 0.6, bounce: 0.18)) { grow = true }
            } else {
                var tx = Transaction(); tx.disablesAnimations = true
                withTransaction(tx) { grow = true }
            }
        }
    }
}

/// Shared bento tile backdrop: frosted glass + a soft diagonal accent wash.
@available(iOS 17.0, *)
private func payrollBentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
    ZStack {
        RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous).fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .fill(Color.white.opacity(scheme == .dark ? 0.04 : 0.35))
        LinearGradient(colors: [accent.opacity(scheme == .dark ? 0.14 : 0.10), .clear],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
}

/// Small glass stat tile — count-up value over a soft accent wash (BentoStatTile style).
@available(iOS 17.0, *)
private struct PayrollStatTile: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let target: Int
    var format: (Int) -> String = AlmaSwiftTheme.takaShort   // the strip's existing formatter
    let tint: Color
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.75)
            PayrollCountUp(target: target, format: format)
                .font(.system(size: 17, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.55)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background { payrollBentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// The dark hero KPI card — deliberately dark in BOTH schemes (the board's anchor tile):
/// salary-budget count-up plus the liability / unpaid secondary numbers the old KPI strip
/// showed, same takaShort formatting. Static gradient only — no shimmer sweep.
@available(iOS 17.0, *)
private struct PayrollHeroCard: View {
    let budget: Int
    let liability: Int
    let unpaid: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("বেতন বাজেট · MONTHLY SALARY BUDGET")
                .font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(PayrollPalette.goldLt)
            PayrollCountUp(target: budget, format: AlmaSwiftTheme.takaShort)
                .font(.system(size: 38, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "COMPANY LIABILITY", target: liability,
                         tint: PayrollPalette.green400)   // pos() reads green400 on dark
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "UNPAID BALANCE", target: unpaid, tint: .white)
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                // Deep indigo base + brand washes: violet from the top, coral from the
                // bottom, a sage hint top-right — ALMA palette only.
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.094, green: 0.082, blue: 0.157))
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.32), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [PayrollPalette.coral.opacity(0.30), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [AlmaSwiftTheme.sage.opacity(0.14), .clear],
                               center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 220)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(.white.opacity(0.16), lineWidth: 1))
        // Force dark inside the card so .primary/materials read the dark palette
        // regardless of the system scheme — this tile is always the board's dark anchor.
        .environment(\.colorScheme, .dark)
    }

    private func heroStat(label: String, target: Int, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.white.opacity(0.55))
            PayrollCountUp(target: target, format: AlmaSwiftTheme.takaShort)
                .font(.system(size: 19, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.6)
        }
    }
}

// MARK: - Aurora background + glass (Payroll-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct PayrollAurora: View {
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
    func payrollGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
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
