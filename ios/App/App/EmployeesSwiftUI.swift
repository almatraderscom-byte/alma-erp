//
//  EmployeesSwiftUI.swift
//  ALMA ERP — the Employees tab (/employees + /employees/[id]) as a native SwiftUI screen.
//
//  Mirrors the web pages 1:1 — same endpoints, same colours, same blocks:
//    GET /api/hr/employees?business_id=…&include_users=1        → roster + linked users
//    GET /api/payroll/wallet/{emp_id}?business_id=…             → wallet summary + ledger + user photo
//    GET /api/attendance?business_id=…&employee_id=…            → attendance records + summary
//  Web-parity blocks: stats strip (Total/Active/Roles) · search (name/ID/phone) · role
//  filter · contact-list rows (photo avatar via /api/users/{id}/profile-image, status
//  capsule, Linked marker) · native detail sheet with profile header, tel:///WhatsApp,
//  wallet summary strip (Bangla balance note verbatim), attendance summary + recent
//  rows, recent wallet ledger + legacy GAS payroll history.
//  ACTION PARITY (2026-07-06, owner order — every web option works natively):
//    POST  /api/hr/employees                                    → add employee (incl. create-from-user)
//    PATCH /api/hr/employees/link                               → link_user_to_employee / clear_user_link
//    POST  /api/hr/payroll                                      → payroll entry (deposit/advance/salary_payment/adjustment)
//    PATCH /api/hr/employees/{emp_id}/salary                    → edit monthly salary
//    POST  /api/payroll/salary-corrections                      → salary correction request (approvals-gated, like web)
//    POST  /api/payroll/wallet/entries/reverse-accrual          → reverse a SALARY_ACCRUAL
//    DELETE /api/attendance/{recordId}                          → reset one attendance day
//    GET   /api/approvals?status=PENDING&module=PAYROLL         → pending SALARY_CORRECTION rows
//  Money/destructive writes go through Bangla confirmationDialogs (employee name +
//  amount); bodies match the web handlers verbatim. Salary slip PDF + profile photo
//  upload stay web-only (client-side PDF/upload) behind a small "ওয়েব ভার্সন" link.
//  Carried lessons: lenient per-field decoding, per-row busy state, cancellation-safe
//  .refreshable, private renamed aurora/glass/shimmer copies (parallel-session rule).
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum EmployeePalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Web getStatusColor: Active tone-green · Inactive tone-red · else tone-amber.
    static func status(_ s: String?) -> Color {
        switch s {
        case "Active": return emerald600
        case "Inactive": return red500
        default: return amber600
        }
    }
    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

/// Lenient number pull — the ERP JSON mixes Int / Double / numeric strings
/// (Prisma Decimals serialize as strings).
private func employeeFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) {
        if let i = Int(s) { return i }
        if let d = Double(s) { return Int(d.rounded()) }
    }
    return nil
}

// MARK: - Models (same field names the web page types declare — src/types/hr.ts)

struct EmployeeRosterItem: Decodable, Identifiable, Equatable {
    let empId: String
    let businessId: String?
    let name: String
    let phone: String?
    let email: String?
    let address: String?
    let role: String?
    let joiningDate: String?
    let monthlySalary: Int
    let status: String?
    let notes: String?

    var id: String { empId }

    private enum Keys: String, CodingKey {
        case emp_id, business_id, name, phone, email, address, role
        case joining_date, monthly_salary, status, notes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        empId = (try? c.decode(String.self, forKey: .emp_id)) ?? ""
        businessId = try? c.decodeIfPresent(String.self, forKey: .business_id)
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        address = try? c.decodeIfPresent(String.self, forKey: .address)
        role = try? c.decodeIfPresent(String.self, forKey: .role)
        joiningDate = try? c.decodeIfPresent(String.self, forKey: .joining_date)
        monthlySalary = employeeFlexInt(c, .monthly_salary) ?? 0
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
    }

    static func == (a: EmployeeRosterItem, b: EmployeeRosterItem) -> Bool { a.empId == b.empId }
}

/// The `users` array from include_users=1 — full web LinkableUser shape, powering
/// avatars, the add-employee "create from user" picker and the link/orphan flows.
struct EmployeeLinkedUser: Decodable, Equatable, Identifiable {
    let id: String
    let name: String?
    let email: String?
    let phone: String?
    let role: String?
    let businessAccess: String?
    let employeeIdGas: String?
    let salaryHint: String?
    let joiningDate: String?
    let linked: Bool?
    let linkState: String?          // linked | orphan | unlinked
    let linkedEmployeeId: String?
    let orphanEmployeeId: String?
    let matchedEmployeeId: String?
    let matchedEmployeeName: String?
    let selectable: Bool?

    private enum Keys: String, CodingKey {
        case id, name, email, phone, role, businessAccess, employeeIdGas, salaryHint
        case joiningDate, linked, linkState, linkedEmployeeId, orphanEmployeeId
        case matchedEmployeeId, matchedEmployeeName, selectable
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        role = try? c.decodeIfPresent(String.self, forKey: .role)
        businessAccess = try? c.decodeIfPresent(String.self, forKey: .businessAccess)
        employeeIdGas = try? c.decodeIfPresent(String.self, forKey: .employeeIdGas)
        // salaryHint arrives as string OR number on the web type — normalize to string.
        if let s = try? c.decodeIfPresent(String.self, forKey: .salaryHint) { salaryHint = s }
        else if let n = employeeFlexInt(c, .salaryHint) { salaryHint = String(n) }
        else { salaryHint = nil }
        joiningDate = try? c.decodeIfPresent(String.self, forKey: .joiningDate)
        linked = try? c.decodeIfPresent(Bool.self, forKey: .linked)
        linkState = try? c.decodeIfPresent(String.self, forKey: .linkState)
        linkedEmployeeId = try? c.decodeIfPresent(String.self, forKey: .linkedEmployeeId)
        orphanEmployeeId = try? c.decodeIfPresent(String.self, forKey: .orphanEmployeeId)
        matchedEmployeeId = try? c.decodeIfPresent(String.self, forKey: .matchedEmployeeId)
        matchedEmployeeName = try? c.decodeIfPresent(String.self, forKey: .matchedEmployeeName)
        selectable = try? c.decodeIfPresent(Bool.self, forKey: .selectable)
    }
}

/// GET /api/hr/employees answers flat ({employees, total, users}); tolerate an
/// {ok, data:{…}} wrap too, like the other native screens.
struct EmployeesListResponse: Decodable {
    let employees: [EmployeeRosterItem]
    let users: [EmployeeLinkedUser]

    private enum Keys: String, CodingKey { case ok, data, employees, users }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        employees = (try? c.decode([EmployeeRosterItem].self, forKey: .employees)) ?? []
        users = (try? c.decode([EmployeeLinkedUser].self, forKey: .users)) ?? []
    }
}

// ── Detail: wallet (GET /api/payroll/wallet/{emp_id}) ──

struct EmployeeWalletUserRef: Decodable, Equatable {
    let id: String?
    let profileImageUrl: String?
    private enum Keys: String, CodingKey { case id, profileImageUrl }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        profileImageUrl = try? c.decodeIfPresent(String.self, forKey: .profileImageUrl)
    }
}

struct EmployeeWalletTotals: Decodable, Equatable {
    let lifetimeEarned: Int
    let lifetimeWithdrawn: Int
    let currentBalance: Int
    let companyLiability: Int

    private enum Keys: String, CodingKey {
        case lifetimeEarned, lifetimeWithdrawn, currentBalance, companyLiability
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        lifetimeEarned = employeeFlexInt(c, .lifetimeEarned) ?? 0
        lifetimeWithdrawn = employeeFlexInt(c, .lifetimeWithdrawn) ?? 0
        currentBalance = employeeFlexInt(c, .currentBalance) ?? 0
        companyLiability = employeeFlexInt(c, .companyLiability) ?? 0
    }
}

struct EmployeeWalletEntry: Decodable, Identifiable, Equatable {
    let entryId: String?
    let date: String?
    let periodYm: String?
    let type: String?
    let note: String?
    /// Unsigned entry amount (web `entry.amount`) — the salary-correction flow keys off it.
    let amount: Int
    let signedAmount: Int
    let runningBalance: Int
    /// Stable list identity even when the ledger row has no id.
    let id: String

    private enum Keys: String, CodingKey {
        case id, date, periodYm, type, note, amount, signedAmount, runningBalance
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        entryId = try? c.decodeIfPresent(String.self, forKey: .id)
        date = try? c.decodeIfPresent(String.self, forKey: .date)
        periodYm = try? c.decodeIfPresent(String.self, forKey: .periodYm)
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        amount = employeeFlexInt(c, .amount) ?? 0
        signedAmount = employeeFlexInt(c, .signedAmount) ?? 0
        runningBalance = employeeFlexInt(c, .runningBalance) ?? 0
        id = entryId ?? "\(date ?? "?")·\(type ?? "?")·\(signedAmount)·\(runningBalance)"
    }
}

struct EmployeeWalletDetail: Decodable {
    let user: EmployeeWalletUserRef?
    let summary: EmployeeWalletTotals?
    let entries: [EmployeeWalletEntry]

    private enum Keys: String, CodingKey { case ok, data, user, summary, entries }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        user = try? c.decodeIfPresent(EmployeeWalletUserRef.self, forKey: .user)
        summary = try? c.decodeIfPresent(EmployeeWalletTotals.self, forKey: .summary)
        entries = (try? c.decode([EmployeeWalletEntry].self, forKey: .entries)) ?? []
    }
}

// ── Detail: attendance (GET /api/attendance — apiDataSuccess {ok, data:{…}} wrap) ──

struct EmployeeAttendanceSummary: Decodable, Equatable {
    let presentDays: Int
    let lateCount: Int
    let totalPenalties: Int
    let waivedPenalties: Int
    let averageWorkMinutes: Int

    private enum Keys: String, CodingKey {
        case presentDays, lateCount, totalPenalties, waivedPenalties, averageWorkMinutes
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        presentDays = employeeFlexInt(c, .presentDays) ?? 0
        lateCount = employeeFlexInt(c, .lateCount) ?? 0
        totalPenalties = employeeFlexInt(c, .totalPenalties) ?? 0
        waivedPenalties = employeeFlexInt(c, .waivedPenalties) ?? 0
        averageWorkMinutes = employeeFlexInt(c, .averageWorkMinutes) ?? 0
    }
}

struct EmployeeAttendanceRecord: Decodable, Identifiable, Equatable {
    let id: String
    let attendanceDate: String?
    let checkInAt: String?
    let checkOutAt: String?
    let totalWorkMinutes: Int
    let lateMinutes: Int
    let penaltyAmount: Int

    private enum Keys: String, CodingKey {
        case id, attendanceDate, checkInAt, checkOutAt, totalWorkMinutes, lateMinutes, penaltyAmount
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        attendanceDate = try? c.decodeIfPresent(String.self, forKey: .attendanceDate)
        checkInAt = try? c.decodeIfPresent(String.self, forKey: .checkInAt)
        checkOutAt = try? c.decodeIfPresent(String.self, forKey: .checkOutAt)
        totalWorkMinutes = employeeFlexInt(c, .totalWorkMinutes) ?? 0
        lateMinutes = employeeFlexInt(c, .lateMinutes) ?? 0
        penaltyAmount = employeeFlexInt(c, .penaltyAmount) ?? 0
    }
}

struct EmployeeAttendanceDetail: Decodable {
    let records: [EmployeeAttendanceRecord]
    let summary: EmployeeAttendanceSummary?

    private enum Keys: String, CodingKey { case ok, data, records, summary }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        records = (try? c.decode([EmployeeAttendanceRecord].self, forKey: .records)) ?? []
        summary = try? c.decodeIfPresent(EmployeeAttendanceSummary.self, forKey: .summary)
    }
}

// ── Legacy GAS payroll history (GET /api/hr/payroll?emp_id=…) ──

struct EmployeePayrollTx: Decodable, Identifiable, Equatable {
    let txId: String
    let date: String?
    let txType: String?
    let amount: Int
    let periodYm: String?
    let note: String?
    var id: String { txId }

    private enum Keys: String, CodingKey { case tx_id, date, tx_type, amount, period_ym, note }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        txId = (try? c.decode(String.self, forKey: .tx_id)) ?? UUID().uuidString
        date = try? c.decodeIfPresent(String.self, forKey: .date)
        txType = try? c.decodeIfPresent(String.self, forKey: .tx_type)
        amount = employeeFlexInt(c, .amount) ?? 0
        periodYm = try? c.decodeIfPresent(String.self, forKey: .period_ym)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
    }
}

struct EmployeePayrollListResponse: Decodable {
    let transactions: [EmployeePayrollTx]
    private enum Keys: String, CodingKey { case ok, data, transactions }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        transactions = (try? c.decode([EmployeePayrollTx].self, forKey: .transactions)) ?? []
    }
}

// ── Write responses (web handler shapes verbatim) ──

/// POST /api/hr/employees → {ok, emp_id?, error?}
struct EmployeeSaveResponse: Decodable {
    let ok: Bool?
    let empId: String?
    let error: String?
    private enum Keys: String, CodingKey { case ok, emp_id, error }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        empId = try? c.decodeIfPresent(String.self, forKey: .emp_id)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }
}

/// POST /api/hr/payroll → {ok, tx_id?, error?, wallet?{ok, skipped?, hint?, …}}
struct EmployeePayrollWalletMirror: Decodable {
    let ok: Bool?
    let skipped: String?
    let hint: String?
    let existingType: String?
    let existingPeriodYm: String?
}

struct EmployeePayrollAddResponse: Decodable {
    let ok: Bool?
    let error: String?
    let wallet: EmployeePayrollWalletMirror?
}

/// PATCH /api/hr/employees/{emp_id}/salary → {ok, error?, new_salary?}
struct EmployeeSalaryPatchResponse: Decodable {
    let ok: Bool?
    let error: String?
    let newSalary: Int?
    private enum Keys: String, CodingKey { case ok, error, new_salary }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        newSalary = employeeFlexInt(c, .new_salary)
    }
}

/// Generic {ok?, error?} — link PATCH, reverse-accrual POST, attendance DELETE.
struct EmployeeOkResponse: Decodable {
    let ok: Bool?
    let error: String?
    private enum Keys: String, CodingKey { case ok, error }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }
}

// ── Pending salary corrections (GET /api/approvals?…&module=PAYROLL) ──

struct EmployeeCorrectionSnapshot: Decodable, Equatable {
    let employeeId: String?
    let periodYm: String?
    let currentAmount: Int
    let proposedAmount: Int
    let requestedReason: String?
    let reversalCount: Int

    private enum Keys: String, CodingKey {
        case employeeId, periodYm, currentAmount, proposedAmount, requestedReason, reversals
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        employeeId = try? c.decodeIfPresent(String.self, forKey: .employeeId)
        periodYm = try? c.decodeIfPresent(String.self, forKey: .periodYm)
        currentAmount = employeeFlexInt(c, .currentAmount) ?? 0
        proposedAmount = employeeFlexInt(c, .proposedAmount) ?? 0
        requestedReason = try? c.decodeIfPresent(String.self, forKey: .requestedReason)
        var count = 0
        if var arr = try? c.nestedUnkeyedContainer(forKey: .reversals) {
            struct Blank: Decodable {}
            while !arr.isAtEnd { _ = try? arr.decode(Blank.self); count += 1 }
        }
        reversalCount = count
    }
}

struct EmployeePendingCorrection: Decodable, Identifiable, Equatable {
    let id: String
    let type: String?
    let createdAt: String?
    let reason: String?
    let requesterName: String?
    let payload: EmployeeCorrectionSnapshot?

    private enum Keys: String, CodingKey { case id, type, createdAt, reason, requester, payloadSnapshot }
    private enum RequesterKeys: String, CodingKey { case name }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        let r = try? c.nestedContainer(keyedBy: RequesterKeys.self, forKey: .requester)
        requesterName = r.flatMap { try? $0.decodeIfPresent(String.self, forKey: .name) }
        payload = try? c.decodeIfPresent(EmployeeCorrectionSnapshot.self, forKey: .payloadSnapshot)
    }
}

struct EmployeeApprovalsListResponse: Decodable {
    let approvals: [EmployeePendingCorrection]
    private enum Keys: String, CodingKey { case ok, data, approvals }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        approvals = (try? c.decode([EmployeePendingCorrection].self, forKey: .approvals)) ?? []
    }
}

// MARK: - View models

/// The web BusinessContext default — HR roster lives in the primary business.
private let employeesBusinessId = "ALMA_LIFESTYLE"

@available(iOS 17.0, *)
@Observable
final class EmployeesVM {
    var employees: [EmployeeRosterItem] = []
    /// Full LinkableUser list from include_users=1 — add-employee picker + link flows.
    var users: [EmployeeLinkedUser] = []
    /// emp_id → linked userId (photo avatars, "Linked" marker — web usersByEmployeeId).
    var linkedUserIdByEmpId: [String: String] = [:]
    var loading = false
    var saving = false                     // add-employee POST in flight
    var linkBusyUserId: String? = nil      // per-row spinner for link/clear actions
    var error: String? = nil
    var notice: String? = nil              // success line (the web's toast)
    var authExpired = false

    /// Users with no link and no stale ID — the "Link roster row to user" choices.
    var unlinkableUsers: [EmployeeLinkedUser] {
        users.filter { $0.linked != true && ($0.orphanEmployeeId ?? "").isEmpty }
    }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: EmployeesListResponse = try await AlmaAPI.shared.get(
                "/api/hr/employees",
                query: ["business_id": employeesBusinessId, "include_users": "1"])
            employees = resp.employees
            users = resp.users
            var map: [String: String] = [:]
            for u in resp.users where u.linked == true {
                if let empId = u.linkedEmployeeId, !u.id.isEmpty { map[empId] = u.id }
            }
            linkedUserIdByEmpId = map
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
        }
    }

    /// POST /api/hr/employees — same payload keys the web form submits.
    /// Returns nil on success, or a user-facing error string.
    func saveEmployee(_ payload: [String: AnyEncodable]) async -> String? {
        saving = true
        defer { saving = false }
        do {
            let resp: EmployeeSaveResponse = try await AlmaAPI.shared.send(
                "POST", "/api/hr/employees", body: payload)
            guard resp.ok == true else { return resp.error ?? "Employee save failed" }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "Employee saved"
            await load()
            return nil
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
        }
    }

    /// PATCH /api/hr/employees/link — web patchUserLink verbatim
    /// ({business_id, action, user_id[, employee_id]}). Nil on success.
    func patchLink(action: String, userId: String, employeeId: String? = nil,
                   successNotice: String) async -> String? {
        linkBusyUserId = userId
        defer { linkBusyUserId = nil }
        do {
            var body: [String: String] = [
                "business_id": employeesBusinessId,
                "action": action,
                "user_id": userId,
            ]
            if let employeeId, !employeeId.isEmpty { body["employee_id"] = employeeId }
            let resp: EmployeeOkResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/hr/employees/link", body: body)
            if resp.ok == false { return resp.error ?? "Link update failed" }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = successNotice
            await load()
            return nil
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
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

/// Detail sheet data + actions — everything the web detail page fetches and writes.
@available(iOS 17.0, *)
@Observable
final class EmployeeDetailVM {
    var wallet: EmployeeWalletDetail? = nil
    var attendance: EmployeeAttendanceDetail? = nil
    var legacy: [EmployeePayrollTx] = []
    var pendingCorrections: [EmployeePendingCorrection] = []
    var loading = false
    var error: String? = nil
    var notice: String? = nil               // success/warning line (web toast parity)
    var actionError: String? = nil

    // Per-action busy state — never one global spinner.
    var paying = false
    var savingSalary = false
    var correctionSubmitting = false
    var reversingEntryId: String? = nil
    var resettingAttendanceId: String? = nil

    /// Ran anything that changed the roster (salary edit)? The list screen refreshes.
    var rosterDirty = false

    func load(empId: String) async {
        loading = true
        error = nil
        defer { loading = false }
        let encoded = empId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? empId
        // The four fetches are independent — a failure in one must not blank the rest.
        async let walletTask: EmployeeWalletDetail? = try? AlmaAPI.shared.get(
            "/api/payroll/wallet/\(encoded)", query: ["business_id": employeesBusinessId])
        async let attendanceTask: EmployeeAttendanceDetail? = try? AlmaAPI.shared.get(
            "/api/attendance", query: ["business_id": employeesBusinessId, "employee_id": empId])
        async let legacyTask: EmployeePayrollListResponse? = try? AlmaAPI.shared.get(
            "/api/hr/payroll", query: ["business_id": employeesBusinessId, "emp_id": empId])
        async let correctionsTask: EmployeeApprovalsListResponse? = try? AlmaAPI.shared.get(
            "/api/approvals", query: ["status": "PENDING", "module": "PAYROLL", "limit": "80"])
        let (w, a, l, p) = await (walletTask, attendanceTask, legacyTask, correctionsTask)
        if Task.isCancelled { return }
        wallet = w
        attendance = a
        legacy = l?.transactions ?? []
        // Web filter parity: SALARY_CORRECTION rows whose payload targets this employee.
        pendingCorrections = (p?.approvals ?? []).filter {
            $0.type == "SALARY_CORRECTION" && $0.payload?.employeeId == empId
        }
        if w == nil && a == nil {
            error = "বিস্তারিত লোড করা যায়নি — আবার চেষ্টা করুন।"
        }
    }

    /// Accrual rows the correction flow can target (web salaryAccrualEntries).
    var salaryAccrualEntries: [EmployeeWalletEntry] {
        (wallet?.entries ?? []).filter { $0.type == "SALARY_ACCRUAL" && $0.entryId != nil }
    }
    /// Entries a correction may reverse (web reversalCandidateEntries).
    var reversalCandidateEntries: [EmployeeWalletEntry] {
        (wallet?.entries ?? []).filter {
            $0.entryId != nil && ($0.type == "WITHDRAWAL" || $0.type == "ADJUSTMENT")
        }
    }

    private func fail(_ error: Error, fallback: String) {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        actionError = (error as? AlmaAPIError)?.localizedDescription
            ?? (error.localizedDescription.isEmpty ? fallback : error.localizedDescription)
    }

    /// POST /api/hr/payroll — web submitPay/executePay verbatim
    /// ({emp_id, tx_type, amount, date, period_ym, note, business_id}).
    func addPayroll(empId: String, txType: String, amount: Double,
                    date: String, periodYm: String, note: String) async -> Bool {
        paying = true
        actionError = nil
        notice = nil
        defer { paying = false }
        do {
            let body: [String: AnyEncodable] = [
                "emp_id": AnyEncodable(empId),
                "tx_type": AnyEncodable(txType),
                "amount": AnyEncodable(amount),
                "date": AnyEncodable(date),
                "period_ym": AnyEncodable(periodYm),
                "note": AnyEncodable(note),
                "business_id": AnyEncodable(employeesBusinessId),
            ]
            let resp: EmployeePayrollAddResponse = try await AlmaAPI.shared.send(
                "POST", "/api/hr/payroll", body: body)
            guard resp.ok == true else {
                actionError = "Failed: \(resp.error ?? "unknown error")"
                return false
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            if resp.wallet?.ok == false || resp.wallet?.skipped != nil {
                notice = "Legacy roll saved but \(Self.walletSkipMessage(resp.wallet))"
            } else {
                notice = "Payroll logged + wallet updated"
            }
            await load(empId: empId)
            return true
        } catch {
            fail(error, fallback: "Payroll entry failed")
            return false
        }
    }

    /// Web payrollWalletSkipMessage verbatim.
    static func walletSkipMessage(_ wallet: EmployeePayrollWalletMirror?) -> String {
        if let hint = wallet?.hint, !hint.isEmpty { return hint }
        switch wallet?.skipped {
        case "period_type_already_exists":
            return "\(wallet?.existingType ?? "Entry") for \(wallet?.existingPeriodYm ?? "this period") already exists. Use Adjustment to modify, or update the existing row."
        case "wallet_entry_already_mirrored": return "This entry was already mirrored (retry detected)."
        case "not_wallet_admin": return "You do not have permission to update the wallet ledger."
        case "wallet_context_denied": return "Wallet access denied for this business."
        case "missing_employee_or_amount": return "Invalid employee ID or amount."
        case "legacy_write_failed": return "Legacy roll save failed before wallet mirror."
        case "legacy_type_not_wallet_mirrored": return "This tx_type is not mirrored to wallet."
        case "p2002_unknown_constraint": return "Wallet mirror blocked by a unique constraint."
        default: return "Wallet not updated: \(wallet?.skipped ?? "unknown")"
        }
    }

    /// PATCH /api/hr/employees/{emp_id}/salary — web submitSalary verbatim
    /// ({amount, businessId, effectiveDate, reason?} — note the camelCase keys).
    func patchSalary(empId: String, amount: Int, effectiveDate: String, reason: String) async -> Bool {
        savingSalary = true
        actionError = nil
        notice = nil
        defer { savingSalary = false }
        do {
            var body: [String: AnyEncodable] = [
                "amount": AnyEncodable(amount),
                "businessId": AnyEncodable(employeesBusinessId),
                "effectiveDate": AnyEncodable(effectiveDate),
            ]
            let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { body["reason"] = AnyEncodable(trimmed) }
            let encoded = empId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? empId
            let resp: EmployeeSalaryPatchResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/hr/employees/\(encoded)/salary", body: body)
            guard resp.ok == true else {
                actionError = resp.error ?? "Failed to update salary"
                return false
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "Salary updated to ৳\((resp.newSalary ?? amount).formatted())"
            rosterDirty = true
            await load(empId: empId)
            return true
        } catch {
            fail(error, fallback: "Failed to update salary")
            return false
        }
    }

    /// POST /api/payroll/salary-corrections — web api.hr.requestSalaryCorrection
    /// verbatim; the write itself lands via the approvals system, same as the web.
    func requestCorrection(empId: String, accrualEntryId: String, periodYm: String,
                           proposedAmount: Int, reason: String,
                           reversals: [(ledgerEntryId: String, amount: Int, reason: String)]) async -> Bool {
        correctionSubmitting = true
        actionError = nil
        notice = nil
        defer { correctionSubmitting = false }
        do {
            var body: [String: AnyEncodable] = [
                "accrual_entry_id": AnyEncodable(accrualEntryId),
                "employee_id": AnyEncodable(empId),
                "business_id": AnyEncodable(employeesBusinessId),
                "period_ym": AnyEncodable(periodYm),
                "proposed_amount": AnyEncodable(proposedAmount),
                "reason": AnyEncodable(reason),
            ]
            if !reversals.isEmpty {
                body["reversals"] = AnyEncodable(reversals.map {
                    ["ledger_entry_id": AnyEncodable($0.ledgerEntryId),
                     "amount": AnyEncodable($0.amount),
                     "reason": AnyEncodable($0.reason)]
                })
            }
            let resp: EmployeeOkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/payroll/salary-corrections", body: body)
            if resp.ok == false {
                actionError = resp.error ?? "Failed to request salary correction"
                return false
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "Salary correction requested. Awaiting super admin approval."
            await load(empId: empId)
            return true
        } catch {
            fail(error, fallback: "Failed to request salary correction")
            return false
        }
    }

    /// POST /api/payroll/wallet/entries/reverse-accrual — web reverseSalaryAccrual
    /// verbatim ({business_id, accrual_entry_id}).
    func reverseAccrual(empId: String, entryId: String) async {
        guard reversingEntryId == nil else { return }
        reversingEntryId = entryId
        actionError = nil
        notice = nil
        defer { reversingEntryId = nil }
        do {
            let body: [String: String] = [
                "business_id": employeesBusinessId,
                "accrual_entry_id": entryId,
            ]
            let resp: EmployeeOkResponse = try await AlmaAPI.shared.send(
                "POST", "/api/payroll/wallet/entries/reverse-accrual", body: body)
            if resp.ok == false {
                actionError = resp.error ?? "Could not reverse accrual"
                return
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "Salary accrual reversed"
            await load(empId: empId)
        } catch {
            fail(error, fallback: "Could not reverse accrual")
        }
    }

    /// DELETE /api/attendance/{recordId} — web resetAttendanceRecord verbatim (no body).
    func resetAttendance(empId: String, recordId: String) async {
        guard resettingAttendanceId == nil else { return }
        resettingAttendanceId = recordId
        actionError = nil
        notice = nil
        defer { resettingAttendanceId = nil }
        do {
            let encoded = recordId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? recordId
            let resp: EmployeeOkResponse = try await AlmaAPI.shared.send(
                "DELETE", "/api/attendance/\(encoded)")
            if resp.ok == false {
                actionError = resp.error ?? "Could not reset attendance"
                return
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "Attendance reset — employee can check in again"
            await load(empId: empId)
        } catch {
            fail(error, fallback: "Could not reset attendance")
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct EmployeesScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = EmployeesVM()
    @State private var searchQuery = ""
    @State private var roleFilter = "ALL"
    @State private var selected: EmployeeRosterItem? = nil
    @State private var showAdd = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err) }
                if let ok = vm.notice { successCard(ok) }
                statsStrip
                addEmployeeButton
                searchBar
                roleChips
                if !vm.loading || !vm.employees.isEmpty { countLine }
                if vm.loading && vm.employees.isEmpty { loadingRows }
                ForEach(filteredEmployees) { em in
                    EmployeeRowCard(
                        employee: em,
                        linkedUserId: vm.linkedUserIdByEmpId[em.empId],
                        onTap: { selected = em })
                }
                if !vm.loading && vm.employees.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(EmployeesAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { em in
            EmployeeDetailSheet(
                employee: em,
                linkedUserId: vm.linkedUserIdByEmpId[em.empId],
                listVM: vm,
                openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showAdd) {
            EmployeeAddSheet(vm: vm)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    /// Web header "+ Add employee" (gold) — opens the create/link modal.
    private var addEmployeeButton: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            vm.notice = nil
            showAdd = true
        } label: {
            Label("+ Add employee", systemImage: "person.badge.plus")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(EmployeePalette.accentText(colorScheme))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(EmployeePalette.coral.opacity(colorScheme == .dark ? 0.24 : 0.12),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .strokeBorder(EmployeePalette.coral.opacity(0.45), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Filtering (web useMemo parity: name / emp_id / phone + role) ──

    private var filteredEmployees: [EmployeeRosterItem] {
        let needle = searchQuery.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        return vm.employees.filter { em in
            let matchesSearch = needle.isEmpty ||
                em.name.lowercased().contains(needle) ||
                em.empId.lowercased().contains(needle) ||
                (em.phone?.contains(needle) ?? false)
            let matchesRole = roleFilter == "ALL" || em.role == roleFilter
            return matchesSearch && matchesRole
        }
    }

    private var uniqueRoles: [String] {
        Array(Set(vm.employees.compactMap { $0.role }.filter { !$0.isEmpty })).sorted()
    }

    // ── Stats strip (web: Total Employees / Active / Roles) ──

    private var statsStrip: some View {
        HStack(spacing: 10) {
            statCard("Total Employees", vm.employees.count, .primary)
            statCard("Active", vm.employees.filter { $0.status == "Active" }.count,
                     EmployeePalette.emerald600)
            statCard("Roles", uniqueRoles.count, EmployeePalette.accentText(colorScheme))
        }
    }

    private func statCard(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(spacing: 3) {
            Text("\(value)").font(.title3.weight(.bold)).foregroundStyle(tint)
            Text(label).font(.caption2).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Search + role filter (web search bar parity; filtering is local → instant) ──

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search by name, ID, or phone...", text: $searchQuery)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.subheadline)
            if !searchQuery.isEmpty {
                Button {
                    searchQuery = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var roleChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                employeeChip("All roles", active: roleFilter == "ALL") { roleFilter = "ALL" }
                ForEach(uniqueRoles, id: \.self) { role in
                    employeeChip(role, active: roleFilter == role) {
                        roleFilter = roleFilter == role ? "ALL" : role
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    /// Web: "{shown} of {total} employees shown".
    private var countLine: some View {
        Text("\(filteredEmployees.count) of \(vm.employees.count) employees shown")
            .font(.caption2).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 2)
    }

    // ── Shared bits ──

    private func employeeChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? EmployeePalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? EmployeePalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? EmployeePalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(EmployeePalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func successCard(_ message: String) -> some View {
        Label(message, systemImage: "checkmark.circle")
            .font(.footnote).foregroundStyle(EmployeePalette.emerald600)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<6, id: \.self) { _ in
            Color.clear.frame(height: 72)
                .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .employeesShimmer()
        }
    }

    /// Web Empty: "No employees yet" · "Create your roster to unlock payroll tooling".
    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "person.2").font(.largeTitle).foregroundStyle(.secondary)
            Text("No employees yet").foregroundStyle(.secondary)
            Text("Create your roster to unlock payroll tooling")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 70)
        .padding(.bottom, 30)
    }

    /// Every web action is native now — keep only a small escape link.
    private var webEscape: some View {
        Button {
            openWeb("/employees", "Employees")
        } label: {
            Text("ওয়েব ভার্সন")
                .font(.caption2)
                .underline()
        }
        .buttonStyle(.plain)
        .foregroundStyle(.tertiary)
        .padding(.vertical, 4)
    }
}

// MARK: - Avatar (web EmployeeAvatar parity: photo via /api/users/{id}/profile-image
// with initials fallback — URLSession.shared shares HTTPCookieStorage, so the cookies
// AlmaAPI bridges from the WKWebView reach AsyncImage too)

@available(iOS 17.0, *)
private struct EmployeeAvatarCircle: View {
    let name: String
    let userId: String?
    var size: CGFloat = 44
    @Environment(\.colorScheme) private var colorScheme

    private var photoURL: URL? {
        guard let userId, !userId.isEmpty else { return nil }
        let encoded = userId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? userId
        return URL(string: "/api/users/\(encoded)/profile-image", relativeTo: AlmaAPI.baseURL)
    }

    var body: some View {
        ZStack {
            initialsCircle
            if let url = photoURL {
                AsyncImage(url: url) { phase in
                    if case .success(let image) = phase {
                        image.resizable().scaledToFill()
                            .frame(width: size, height: size)
                            .clipShape(Circle())
                    }
                }
            }
        }
        .overlay(Circle().strokeBorder(EmployeePalette.coral.opacity(0.35), lineWidth: 1))
    }

    private var initialsCircle: some View {
        Text(EmployeeFormat.initials(name))
            .font(.system(size: size * 0.34, weight: .bold))
            .foregroundStyle(EmployeePalette.accentText(colorScheme))
            .frame(width: size, height: size)
            .background(EmployeePalette.coral.opacity(0.16), in: Circle())
    }
}

// MARK: - Row card (contact-list style — web mobile card grid, reset as iOS rows)

@available(iOS 17.0, *)
private struct EmployeeRowCard: View {
    let employee: EmployeeRosterItem
    let linkedUserId: String?
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 12) {
            EmployeeAvatarCircle(name: employee.name, userId: linkedUserId, size: 44)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(employee.name)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    if linkedUserId != nil {
                        // Web: "Linked" marker on rows with a user account.
                        Image(systemName: "link")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(EmployeePalette.emerald600)
                    }
                }
                HStack(spacing: 6) {
                    Text(employee.role?.isEmpty == false ? employee.role! : "Staff")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.primary.opacity(0.06), in: Capsule())
                    if let phone = employee.phone, !phone.isEmpty {
                        Text(EmployeeFormat.bdPhone(phone))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 4) {
                Text(employee.status ?? "—")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(EmployeePalette.status(employee.status))
                    .padding(.horizontal, 7).padding(.vertical, 2.5)
                    .background(EmployeePalette.status(employee.status).opacity(0.12), in: Capsule())
                    .overlay(Capsule().strokeBorder(
                        EmployeePalette.status(employee.status).opacity(0.35), lineWidth: 0.8))
                Text("৳\(employee.monthlySalary.formatted())")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(EmployeePalette.accentText(colorScheme))
            }
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12).padding(.vertical, 11)
        .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }
}

// MARK: - Detail sheet (web /employees/[id] parity — profile header, wallet summary
// strip, attendance summary, ledger + legacy history, and EVERY web action natively:
// payroll entry, salary edit, salary correction, accrual reverse, attendance reset,
// account linking. Slip PDF + photo upload stay web behind the small link.)

@available(iOS 17.0, *)
private struct EmployeeDetailSheet: View {
    let employee: EmployeeRosterItem
    let linkedUserId: String?
    let listVM: EmployeesVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = EmployeeDetailVM()
    @State private var showBalanceNote = false
    @State private var showPay = false
    @State private var showSalary = false
    @State private var showCorrection = false
    @State private var showLink = false
    // Destructive row actions collect their target first, then confirm in Bangla.
    @State private var reverseTarget: EmployeeWalletEntry? = nil
    @State private var showReverseConfirm = false
    @State private var resetTarget: EmployeeAttendanceRecord? = nil
    @State private var showResetConfirm = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                contactButtons
                actionsRow
                if let err = vm.actionError { detailNotice(err, error: true) }
                if let ok = vm.notice { detailNotice(ok, error: false) }
                infoRows
                walletStrip
                pendingCorrectionsBlock
                attendanceBlock
                ledgerBlock
                legacyBlock
                webLink
            }
            .padding(18)
        }
        .presentationBackground { EmployeesAurora() }
        .task { await vm.load(empId: employee.empId) }
        .onDisappear {
            // Salary edits change the roster row — refresh the list behind us.
            if vm.rosterDirty { Task { await listVM.load() } }
        }
        .sheet(isPresented: $showPay) {
            EmployeePayrollEntrySheet(employee: employee, vm: vm)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showSalary) {
            EmployeeSalaryEditSheet(employee: employee, vm: vm)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showCorrection) {
            EmployeeCorrectionSheet(employee: employee, vm: vm)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showLink) {
            EmployeeLinkAccountSheet(employee: employee, listVM: listVM)
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
        }
        // Web confirmDialog("Reverse salary accrual") — Bangla, name + amount.
        .confirmationDialog(
            "স্যালারি অ্যাক্রুয়াল রিভার্স",
            isPresented: $showReverseConfirm,
            titleVisibility: .visible,
            presenting: reverseTarget
        ) { entry in
            Button("রিভার্স করুন", role: .destructive) {
                if let id = entry.entryId {
                    Task { await vm.reverseAccrual(empId: employee.empId, entryId: id) }
                }
            }
            Button("বাতিল", role: .cancel) {}
        } message: { entry in
            Text("\(employee.name)-এর ৳\(entry.signedAmount.formatted()) স্যালারি অ্যাক্রুয়াল পুরোটা রিভার্স হবে — সমান ADJUSTMENT ডেবিট পোস্ট হবে।")
        }
        // Web confirmDialog("Remove attendance…") — Bangla, name + date.
        .confirmationDialog(
            "অ্যাটেনডেন্স রিসেট",
            isPresented: $showResetConfirm,
            titleVisibility: .visible,
            presenting: resetTarget
        ) { row in
            Button("মুছে ফেলুন", role: .destructive) {
                Task { await vm.resetAttendance(empId: employee.empId, recordId: row.id) }
            }
            Button("বাতিল", role: .cancel) {}
        } message: { row in
            Text("\(employee.name)-এর \(String((row.attendanceDate ?? "—").prefix(10))) তারিখের অ্যাটেনডেন্স মুছে যাবে — আবার চেক-ইন করা যাবে, লেট পেনাল্টি থাকলে ফেরত হবে।")
        }
    }

    // ── Action buttons (web toolbar: + Payroll entry · Edit salary · + Request
    // correction · Link account) ──

    private var actionsRow: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                actionButton("+ Payroll entry", icon: "banknote", prominent: true) {
                    vm.actionError = nil; vm.notice = nil
                    showPay = true
                }
                actionButton("Edit salary", icon: "pencil") {
                    vm.actionError = nil; vm.notice = nil
                    showSalary = true
                }
            }
            HStack(spacing: 8) {
                actionButton("+ Request correction", icon: "arrow.uturn.backward.circle") {
                    vm.actionError = nil; vm.notice = nil
                    showCorrection = true
                }
                if linkedUserId == nil {
                    actionButton("Link account", icon: "link") {
                        listVM.notice = nil
                        showLink = true
                    }
                }
            }
        }
    }

    private func actionButton(_ label: String, icon: String, prominent: Bool = false,
                              action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            action()
        } label: {
            Label(label, systemImage: icon)
                .font(.caption.weight(.semibold))
                .lineLimit(1).minimumScaleFactor(0.8)
                .foregroundStyle(prominent ? EmployeePalette.accentText(colorScheme) : .secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .background(
                    prominent ? EmployeePalette.coral.opacity(colorScheme == .dark ? 0.24 : 0.12)
                              : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .strokeBorder(prominent ? EmployeePalette.coral.opacity(0.45)
                                            : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                                  lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func detailNotice(_ message: String, error: Bool) -> some View {
        Label(message, systemImage: error ? "exclamationmark.triangle" : "checkmark.circle")
            .font(.footnote)
            .foregroundStyle(error ? EmployeePalette.red500 : EmployeePalette.emerald600)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Profile header (big avatar + name + role · emp_id + salary) ──

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            EmployeeAvatarCircle(
                name: employee.name,
                userId: vm.wallet?.user?.id ?? linkedUserId,
                size: 64)
            VStack(alignment: .leading, spacing: 3) {
                Text(employee.name).font(.headline)
                Text("\(employee.role?.isEmpty == false ? employee.role! : "Staff") · \(employee.empId)")
                    .font(.caption).foregroundStyle(.secondary)
                Text("৳\(employee.monthlySalary.formatted())")
                    .font(.subheadline.weight(.bold).monospacedDigit())
                    .foregroundStyle(EmployeePalette.accentText(colorScheme))
                + Text("  Monthly Salary")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Text(employee.status ?? "—")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(EmployeePalette.status(employee.status))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(EmployeePalette.status(employee.status).opacity(0.12), in: Capsule())
        }
    }

    /// Same pattern as OrdersSwiftUI contactButtons — WhatsApp strips the leading 0
    /// and prefixes the 880 country code.
    private var contactButtons: some View {
        HStack(spacing: 10) {
            if let phone = employee.phone, !phone.isEmpty {
                Link(destination: URL(string: "tel://\(phone)")!) {
                    Label("Call", systemImage: "phone.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                if phone.hasPrefix("0"), let wa = URL(string: "https://wa.me/880\(phone.dropFirst())") {
                    Link(destination: wa) {
                        Label("WhatsApp", systemImage: "message.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }

    // ── Info rows (web profile header details) ──

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let phone = employee.phone, !phone.isEmpty {
                infoRow("phone", EmployeeFormat.bdPhone(phone))
            }
            if let email = employee.email, !email.isEmpty { infoRow("envelope", email) }
            if let address = employee.address, !address.isEmpty {
                infoRow("mappin.and.ellipse", address)
            }
            if let joined = employee.joiningDate, !joined.isEmpty {
                infoRow("calendar", "Joined \(String(joined.prefix(10)))")
            }
            if let notes = employee.notes, !notes.isEmpty { infoRow("note.text", notes) }
        }
        .padding(14)
        .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).frame(width: 18).foregroundStyle(.secondary)
            Text(text).font(.subheadline)
        }
    }

    // ── Wallet summary strip (web: Earned / Withdrawn / Current Balance + Bangla note) ──

    @ViewBuilder private var walletStrip: some View {
        if vm.loading && vm.wallet == nil {
            Color.clear.frame(height: 84)
                .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                .employeesShimmer()
        } else if let summary = vm.wallet?.summary {
            VStack(spacing: 8) {
                HStack(spacing: 10) {
                    walletStat("Earned", summary.lifetimeEarned, .primary)
                    walletStat("Withdrawn", summary.lifetimeWithdrawn, .primary)
                    Button {
                        withAnimation(.snappy) { showBalanceNote.toggle() }
                    } label: {
                        walletStat("Current Balance", summary.currentBalance,
                                   summary.currentBalance < 0 ? EmployeePalette.red500
                                                              : EmployeePalette.emerald600)
                    }
                    .buttonStyle(.plain)
                }
                if showBalanceNote {
                    // Web balance tooltip — exact strings.
                    Text(summary.currentBalance < 0
                         ? "এটা company আপনার থেকে পায়"
                         : "এটা আপনি company থেকে পাবেন")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(12)
            .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        } else if let err = vm.error {
            Label(err, systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(EmployeePalette.red500)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12).employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    private func walletStat(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(spacing: 2) {
            Text("৳\(value.formatted())")
                .font(.footnote.weight(.bold).monospacedDigit())
                .foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(label).font(.system(size: 9)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
    }

    // ── Attendance summary (web MiniStat grid + recent rows) ──

    @ViewBuilder private var attendanceBlock: some View {
        if let att = vm.attendance {
            VStack(alignment: .leading, spacing: 10) {
                Text("Attendance summary")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                if let s = att.summary {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            miniStat("Present days", "\(s.presentDays) days", .primary)
                            miniStat("Late days", "\(s.lateCount) days", EmployeePalette.amber600)
                            miniStat("Penalties", "৳\(s.totalPenalties.formatted())", EmployeePalette.red500)
                            miniStat("Waived", "৳\(s.waivedPenalties.formatted())", EmployeePalette.emerald600)
                            miniStat("Avg duration", EmployeeFormat.duration(s.averageWorkMinutes), .primary)
                        }
                        .padding(.vertical, 1)
                    }
                }
                if att.records.isEmpty {
                    Text("No attendance records this month.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    ForEach(att.records.prefix(7)) { row in
                        attendanceRow(row)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    private func miniStat(_ label: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 9, weight: .bold)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.caption.weight(.bold).monospacedDigit()).foregroundStyle(tint)
        }
        .frame(minWidth: 76, alignment: .leading)
        .padding(10)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }

    private func attendanceRow(_ row: EmployeeAttendanceRecord) -> some View {
        HStack(spacing: 8) {
            Text(String((row.attendanceDate ?? "—").prefix(10)))
                .font(.caption2.monospaced())
            Text("\(EmployeeFormat.time(row.checkInAt)) – \(row.checkOutAt != nil ? EmployeeFormat.time(row.checkOutAt) : "—")")
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
            Spacer()
            if row.lateMinutes > 0 {
                Text("late \(EmployeeFormat.duration(row.lateMinutes))")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(EmployeePalette.red500)
            }
            if row.penaltyAmount > 0 {
                Text("−৳\(row.penaltyAmount.formatted())")
                    .font(.caption2.monospaced())
                    .foregroundStyle(EmployeePalette.red500)
            }
            Text(EmployeeFormat.duration(row.totalWorkMinutes))
                .font(.caption2.monospaced().weight(.semibold))
            // Web "Reset" (attendance delete, admin-gated server-side) — per-row spinner.
            if vm.resettingAttendanceId == row.id {
                ProgressView().controlSize(.mini)
            } else {
                Button {
                    resetTarget = row
                    showResetConfirm = true
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(EmployeePalette.amber600)
                        .padding(4)
                }
                .buttonStyle(.plain)
                .disabled(vm.resettingAttendanceId != nil)
            }
        }
    }

    // ── Recent wallet ledger (web "Postgres wallet ledger", newest first, top 8) ──

    @ViewBuilder private var ledgerBlock: some View {
        if let wallet = vm.wallet, !wallet.entries.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Wallet ledger (recent)")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                ForEach(Array(wallet.entries.reversed().prefix(8))) { tx in
                    ledgerRow(tx)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    private func ledgerRow(_ tx: EmployeeWalletEntry) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text((tx.type ?? "—").replacingOccurrences(of: "_", with: " "))
                    .font(.caption2.weight(.semibold))
                Text(String((tx.date ?? "—").prefix(10)))
                    .font(.system(size: 9).monospaced())
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text("\(tx.signedAmount >= 0 ? "+" : "−")৳\(abs(tx.signedAmount).formatted())")
                    .font(.caption2.monospaced().weight(.bold))
                    .foregroundStyle(tx.signedAmount >= 0 ? EmployeePalette.emerald600
                                                          : EmployeePalette.red500)
                Text("৳\(tx.runningBalance.formatted())")
                    .font(.system(size: 9).monospaced())
                    .foregroundStyle(EmployeePalette.accentText(colorScheme))
            }
            // Web "Reverse" on positive SALARY_ACCRUAL rows — per-row spinner.
            if tx.type == "SALARY_ACCRUAL", tx.entryId != nil, tx.signedAmount > 0 {
                if vm.reversingEntryId == tx.entryId {
                    ProgressView().controlSize(.mini)
                } else {
                    Button {
                        reverseTarget = tx
                        showReverseConfirm = true
                    } label: {
                        Image(systemName: "arrow.uturn.backward")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(EmployeePalette.red500)
                            .padding(4)
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.reversingEntryId != nil)
                }
            }
        }
    }

    // ── Pending salary corrections (web card: amber rows awaiting super admin) ──

    @ViewBuilder private var pendingCorrectionsBlock: some View {
        if !vm.pendingCorrections.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Salary corrections (pending)")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                ForEach(vm.pendingCorrections) { row in
                    VStack(alignment: .leading, spacing: 3) {
                        if let p = row.payload {
                            Text("Pending: ৳\(p.currentAmount.formatted()) → ৳\(p.proposedAmount.formatted()) (\(p.periodYm ?? "—"))")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(EmployeePalette.amber600)
                            if p.reversalCount > 0 {
                                Text("Reversals: \(p.reversalCount) entries")
                                    .font(.system(size: 9)).foregroundStyle(.secondary)
                            }
                        }
                        Text("Requested by \(row.requesterName ?? "Admin") on \(String((row.createdAt ?? "—").prefix(10)))")
                            .font(.system(size: 9)).foregroundStyle(.secondary)
                        if let reason = row.reason ?? row.payload?.requestedReason, !reason.isEmpty {
                            Text("Reason: \(reason)")
                                .font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(EmployeePalette.amber500.opacity(0.10),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                        .strokeBorder(EmployeePalette.amber500.opacity(0.35), lineWidth: 0.8))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    // ── Legacy GAS payroll history (web bottom table, newest rows) ──

    @ViewBuilder private var legacyBlock: some View {
        if !vm.legacy.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Legacy GAS payroll history")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                ForEach(vm.legacy.prefix(10)) { tx in
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(tx.txType ?? "—").font(.caption2.weight(.semibold))
                            Text("\(String((tx.date ?? "—").prefix(10))) · \(tx.periodYm ?? "—")")
                                .font(.system(size: 9).monospaced())
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 1) {
                            Text("৳\(tx.amount.formatted())")
                                .font(.caption2.monospaced().weight(.bold))
                                .foregroundStyle(EmployeePalette.accentText(colorScheme))
                            if let note = tx.note, !note.isEmpty {
                                Text(note).font(.system(size: 9))
                                    .foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    /// Slip PDF + profile photo upload are the only web-only leftovers.
    private var webLink: some View {
        Button {
            dismiss()
            let encoded = employee.empId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? employee.empId
            openWeb("/employees/\(encoded)", employee.name)
        } label: {
            Text("ওয়েব ভার্সন (Slip PDF · ছবি আপলোড)")
                .font(.caption2)
                .underline()
        }
        .buttonStyle(.plain)
        .foregroundStyle(.tertiary)
        .padding(.top, 2)
    }
}

// MARK: - Shared form field chrome (glass inputs matching the page look)

@available(iOS 17.0, *)
private struct EmployeeField<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            content
        }
    }
}

@available(iOS 17.0, *)
private extension View {
    func employeeInputChrome(_ scheme: ColorScheme) -> some View {
        self
            .padding(.horizontal, 10).padding(.vertical, 9)
            .background(Color.white.opacity(scheme == .dark ? 0.07 : 0.5),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.12 : 0.45), lineWidth: 1))
    }
}

private func employeeIsoDate(_ date: Date) -> String {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
    return f.string(from: date)
}

// MARK: - Add employee sheet (web "Employee profile" modal — manual create OR
// create-from-user, plus the orphan clear/re-link flows; POST /api/hr/employees)

@available(iOS 17.0, *)
private struct EmployeeAddSheet: View {
    let vm: EmployeesVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var selectedUserId = ""
    @State private var empId = ""
    @State private var name = ""
    @State private var phone = ""
    @State private var email = ""
    @State private var address = ""
    @State private var role = ""
    @State private var hasJoining = false
    @State private var joiningDate = Date()
    @State private var salaryText = ""
    @State private var status = "Active"
    @State private var notes = ""
    @State private var orphanLinkEmpId = ""
    @State private var formError: String? = nil

    private var selectedUser: EmployeeLinkedUser? {
        vm.users.first { $0.id == selectedUserId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Employee profile").font(.headline)
                    Text("Create a roster profile manually or directly from an unlinked system user.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let err = formError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(EmployeePalette.red500)
                }
                fromUserBlock
                selectedUserBlock
                fieldsBlock
                footerButtons
            }
            .padding(18)
        }
        .presentationBackground { EmployeesAurora() }
    }

    // ── Create Employee From User (web left column) ──

    @ViewBuilder private var fromUserBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Create Employee From User")
                .font(.caption.weight(.bold)).foregroundStyle(EmployeePalette.accentText(colorScheme))
                .textCase(.uppercase)
            if vm.users.isEmpty {
                Text("No users available in this business scope.")
                    .font(.caption2).foregroundStyle(.secondary)
            } else {
                ForEach(vm.users) { user in
                    userRow(user)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func userRow(_ user: EmployeeLinkedUser) -> some View {
        let isSelected = selectedUserId == user.id
        let selectable = user.selectable ?? false
        let state = user.linkState ?? (user.linked == true ? "linked" : "unlinked")
        let stateColor: Color = state == "linked" ? EmployeePalette.emerald600
            : state == "orphan" ? EmployeePalette.red500 : EmployeePalette.amber600
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                guard selectable else { return }
                UISelectionFeedbackGenerator().selectionChanged()
                fillFromUser(user)
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .top, spacing: 6) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(user.name ?? "—").font(.caption.weight(.semibold))
                            Text(user.email ?? user.phone ?? "No contact")
                                .font(.system(size: 9).monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 4)
                        Text(state == "linked" ? "Linked \(user.linkedEmployeeId ?? "")"
                             : state == "orphan" ? "Stale ID" : "Unlinked")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(stateColor)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(stateColor.opacity(0.12), in: Capsule())
                    }
                    Text("\((user.role ?? "—").replacingOccurrences(of: "_", with: " ")) · \(user.phone.map(EmployeeFormat.bdPhone) ?? "No phone")")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                    if let matched = user.matchedEmployeeId, state == "unlinked" {
                        Text("Possible existing employee: \(user.matchedEmployeeName ?? "—") · \(matched)")
                            .font(.system(size: 9)).foregroundStyle(EmployeePalette.amber600)
                    }
                }
            }
            .buttonStyle(.plain)
            .opacity(selectable || state == "orphan" ? 1 : 0.6)

            // Web orphan controls: clear the stale ID, or re-link to a roster row.
            if state == "orphan", let orphanId = user.orphanEmployeeId, !orphanId.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("User has stale employee ID: \(orphanId). Re-link or clear?")
                        .font(.system(size: 9)).foregroundStyle(EmployeePalette.red500)
                    HStack(spacing: 8) {
                        if vm.linkBusyUserId == user.id {
                            ProgressView().controlSize(.mini)
                        } else {
                            Button("Clear and create new") {
                                Task {
                                    formError = await vm.patchLink(
                                        action: "clear_user_link", userId: user.id,
                                        successNotice: "Stale employee ID cleared — you can create a new roster row from this user")
                                }
                            }
                            .font(.system(size: 10, weight: .semibold))
                            .buttonStyle(.bordered).controlSize(.mini)
                        }
                    }
                    HStack(spacing: 6) {
                        Picker("Link to roster row…", selection: Binding(
                            get: { selectedUserId == user.id ? orphanLinkEmpId : "" },
                            set: { selectedUserId = user.id; orphanLinkEmpId = $0 })) {
                            Text("Link to roster row…").tag("")
                            ForEach(vm.employees) { em in
                                Text("\(em.name) · \(em.empId)").tag(em.empId)
                            }
                        }
                        .pickerStyle(.menu)
                        .font(.caption2)
                        Button("Link") {
                            Task {
                                guard selectedUserId == user.id, !orphanLinkEmpId.isEmpty else {
                                    formError = "Select a roster employee to link"
                                    return
                                }
                                formError = await vm.patchLink(
                                    action: "link_user_to_employee", userId: user.id,
                                    employeeId: orphanLinkEmpId,
                                    successNotice: "Linked \(user.name ?? "user") to \(orphanLinkEmpId)")
                                if formError == nil { orphanLinkEmpId = "" }
                            }
                        }
                        .font(.system(size: 10, weight: .semibold))
                        .buttonStyle(.borderedProminent).controlSize(.mini)
                        .disabled(selectedUserId != user.id || orphanLinkEmpId.isEmpty
                                  || vm.linkBusyUserId != nil)
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(10)
        .background(
            isSelected ? EmployeePalette.coral.opacity(colorScheme == .dark ? 0.20 : 0.10)
                       : Color.white.opacity(colorScheme == .dark ? 0.05 : 0.35),
            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(isSelected ? EmployeePalette.coral.opacity(0.5)
                                     : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                          lineWidth: 1))
    }

    /// Web fillFromUser parity — prefill the form from the tapped user.
    private func fillFromUser(_ user: EmployeeLinkedUser) {
        selectedUserId = user.id
        name = user.name ?? ""
        phone = user.phone ?? ""
        email = user.email ?? ""
        role = (user.role ?? "").replacingOccurrences(of: "_", with: " ")
        if let jd = user.joiningDate, jd.count >= 10 {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd"
            if let d = f.date(from: String(jd.prefix(10))) {
                joiningDate = d
                hasJoining = true
            }
        } else {
            hasJoining = false
        }
        salaryText = user.salaryHint ?? ""
        if (user.orphanEmployeeId ?? "").isEmpty,
           let existing = user.employeeIdGas ?? user.matchedEmployeeId {
            empId = existing
        } else {
            empId = ""
        }
    }

    @ViewBuilder private var selectedUserBlock: some View {
        if let user = selectedUser {
            VStack(alignment: .leading, spacing: 3) {
                Text("Selected user").font(.system(size: 9, weight: .bold))
                    .textCase(.uppercase).foregroundStyle(EmployeePalette.accentText(colorScheme))
                Text(user.name ?? "—").font(.caption.weight(.bold))
                if user.linked == true {
                    Text("Already linked to \(user.linkedEmployeeId ?? "—"). Duplicate links are blocked.")
                        .font(.system(size: 9)).foregroundStyle(EmployeePalette.emerald600)
                }
                if user.linkState == "orphan" {
                    Text("Stale ID on file — clear or re-link before creating a duplicate roster row.")
                        .font(.system(size: 9)).foregroundStyle(EmployeePalette.red500)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    // ── Manual fields (web right column, same names) ──

    private var fieldsBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            EmployeeField(label: "Existing ID (optional)") {
                TextField("AUTO if empty", text: $empId)
                    .font(.caption.monospaced())
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .employeeInputChrome(colorScheme)
            }
            EmployeeField(label: "Full name (required)") {
                TextField("Name", text: $name).font(.subheadline)
                    .employeeInputChrome(colorScheme)
            }
            HStack(spacing: 10) {
                EmployeeField(label: "Phone") {
                    TextField("01…", text: $phone).font(.caption.monospaced())
                        .keyboardType(.phonePad)
                        .employeeInputChrome(colorScheme)
                }
                EmployeeField(label: "Email") {
                    TextField("email", text: $email).font(.caption)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .employeeInputChrome(colorScheme)
                }
            }
            EmployeeField(label: "Address") {
                TextField("Address", text: $address, axis: .vertical)
                    .lineLimit(2...3).font(.caption)
                    .employeeInputChrome(colorScheme)
            }
            HStack(spacing: 10) {
                EmployeeField(label: "Role") {
                    TextField("Role", text: $role).font(.caption)
                        .employeeInputChrome(colorScheme)
                }
                EmployeeField(label: "Monthly salary") {
                    TextField("0", text: $salaryText).font(.caption.monospaced())
                        .keyboardType(.decimalPad)
                        .employeeInputChrome(colorScheme)
                }
            }
            EmployeeField(label: "Joining date") {
                HStack {
                    Toggle("", isOn: $hasJoining).labelsHidden()
                    if hasJoining {
                        DatePicker("", selection: $joiningDate, displayedComponents: .date)
                            .labelsHidden()
                    } else {
                        Text("Not set").font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
            }
            EmployeeField(label: "Status") {
                Picker("Status", selection: $status) {
                    Text("Active").tag("Active")
                    Text("Inactive").tag("Inactive")
                    Text("Probation").tag("Probation")
                }
                .pickerStyle(.segmented)
            }
            EmployeeField(label: "Notes") {
                TextField("Notes", text: $notes, axis: .vertical)
                    .lineLimit(2...4).font(.caption)
                    .employeeInputChrome(colorScheme)
            }
        }
        .padding(12)
        .employeesGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var footerButtons: some View {
        HStack(spacing: 10) {
            Button {
                Task { await submit() }
            } label: {
                if vm.saving {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Text(selectedUser != nil ? "Create Employee From User" : "Save")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(EmployeePalette.coral)
            .disabled(vm.saving || selectedUser?.linked == true)
            Button("Cancel") { dismiss() }
                .buttonStyle(.bordered)
        }
    }

    /// Web submit() parity — same payload keys, same guards.
    private func submit() async {
        formError = nil
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            formError = "Name is required"
            return
        }
        let trimmedEmpId = empId.trimmingCharacters(in: .whitespacesAndNewlines)
        if let u = selectedUser, u.linked == true,
           let gas = u.employeeIdGas, !gas.isEmpty, gas != trimmedEmpId {
            formError = "\(u.name ?? "User") is already linked to \(gas)"
            return
        }
        var payload: [String: AnyEncodable] = [
            "name": AnyEncodable(trimmedName),
            "phone": AnyEncodable(phone),
            "email": AnyEncodable(email),
            "address": AnyEncodable(address),
            "role": AnyEncodable(role),
            "joining_date": AnyEncodable(hasJoining ? employeeIsoDate(joiningDate) : ""),
            "monthly_salary": AnyEncodable(Double(salaryText) ?? 0),
            "status": AnyEncodable(status),
            "notes": AnyEncodable(notes),
            "business_id": AnyEncodable("ALMA_LIFESTYLE"),
        ]
        if !trimmedEmpId.isEmpty { payload["emp_id"] = AnyEncodable(trimmedEmpId) }
        if !selectedUserId.isEmpty { payload["user_id"] = AnyEncodable(selectedUserId) }
        if let err = await vm.saveEmployee(payload) {
            formError = err
        } else {
            dismiss()
        }
    }
}

// MARK: - Link account sheet (web "Link roster row to user" modal —
// PATCH /api/hr/employees/link {action: link_user_to_employee})

@available(iOS 17.0, *)
private struct EmployeeLinkAccountSheet: View {
    let employee: EmployeeRosterItem
    let listVM: EmployeesVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var linkUserId = ""
    @State private var formError: String? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Link roster row to user").font(.headline)
                    Text(employee.empId).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
                if let err = formError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(EmployeePalette.red500)
                }
                EmployeeField(label: "User without employee link") {
                    Picker("Select user", selection: $linkUserId) {
                        Text("Select user").tag("")
                        ForEach(listVM.unlinkableUsers) { u in
                            Text("\(u.name ?? "—") · \((u.role ?? "—").replacingOccurrences(of: "_", with: " "))")
                                .tag(u.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .employeeInputChrome(colorScheme)
                }
                HStack(spacing: 10) {
                    Button {
                        Task {
                            guard !linkUserId.isEmpty else {
                                formError = "Select a user account"
                                return
                            }
                            formError = await listVM.patchLink(
                                action: "link_user_to_employee", userId: linkUserId,
                                employeeId: employee.empId,
                                successNotice: "Roster row linked to user")
                            if formError == nil { dismiss() }
                        }
                    } label: {
                        if listVM.linkBusyUserId != nil {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("Link").frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(EmployeePalette.coral)
                    .disabled(listVM.linkBusyUserId != nil)
                    Button("Cancel") { dismiss() }.buttonStyle(.bordered)
                }
            }
            .padding(18)
        }
        .presentationBackground { EmployeesAurora() }
    }
}

// MARK: - Payroll entry sheet (web "Log payroll movement" modal —
// POST /api/hr/payroll; debit types re-confirm with balance before/after)

@available(iOS 17.0, *)
private struct EmployeePayrollEntrySheet: View {
    let employee: EmployeeRosterItem
    let vm: EmployeeDetailVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    // Web LEGACY_PAY_TX_OPTIONS verbatim.
    private static let txOptions: [(value: String, label: String)] = [
        ("deposit", "💰 Credit salary (add to wallet)"),
        ("advance", "💸 Advance to employee (debit)"),
        ("salary_payment", "⚠️ Mark salary as paid out (debit - usually via approval)"),
        ("adjustment", "⚙️ Adjustment (correction)"),
    ]

    @State private var txType = "deposit"
    @State private var amountText = ""
    @State private var date = Date()
    @State private var periodYm = ""
    @State private var note = ""
    @State private var formError: String? = nil
    @State private var showConfirm = false

    private var isDebit: Bool { txType == "advance" || txType == "salary_payment" }
    private var amount: Double { Double(amountText) ?? 0 }

    /// Web payrollTxHelper verbatim.
    private var helper: (text: String, color: Color) {
        switch txType {
        case "deposit":
            return ("✓ This will INCREASE the employee's wallet balance.", EmployeePalette.emerald600)
        case "advance":
            return ("⚠ This will DECREASE balance (employee received cash early).", EmployeePalette.amber600)
        case "salary_payment":
            return ("⚠ Caution: Use only if you paid salary outside the wallet. Normal flow is employee withdrawal request → approval.", EmployeePalette.amber600)
        default:
            return ("Manual correction — can be positive or negative depending on amount sign in ledger mirror.", Color.secondary)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Log payroll movement").font(.headline)
                Text("\(employee.name) · \(employee.empId)")
                    .font(.caption).foregroundStyle(.secondary)
                if let err = formError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(EmployeePalette.red500)
                }
                EmployeeField(label: "Type") {
                    Picker("Type", selection: $txType) {
                        ForEach(Self.txOptions, id: \.value) { opt in
                            Text(opt.label).tag(opt.value)
                        }
                    }
                    .pickerStyle(.menu)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .employeeInputChrome(colorScheme)
                }
                Text(helper.text)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(helper.color)
                EmployeeField(label: "Amount (৳)") {
                    TextField("0", text: $amountText)
                        .font(.subheadline.monospaced())
                        .keyboardType(.decimalPad)
                        .employeeInputChrome(colorScheme)
                }
                HStack(spacing: 10) {
                    EmployeeField(label: "Effective date") {
                        DatePicker("", selection: $date, displayedComponents: .date)
                            .labelsHidden()
                    }
                    EmployeeField(label: "Period (YYYY-MM)") {
                        TextField("2026-05", text: $periodYm)
                            .font(.caption.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .employeeInputChrome(colorScheme)
                    }
                }
                EmployeeField(label: "Note") {
                    TextField("Note", text: $note, axis: .vertical)
                        .lineLimit(2...3).font(.caption)
                        .employeeInputChrome(colorScheme)
                }
                HStack(spacing: 10) {
                    Button {
                        formError = nil
                        guard amount > 0 else {
                            formError = "Transaction type & amount required"
                            return
                        }
                        showConfirm = true
                    } label: {
                        if vm.paying {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("Save entry").frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(EmployeePalette.coral)
                    .disabled(vm.paying)
                    Button("Cancel") { dismiss() }.buttonStyle(.bordered)
                }
            }
            .padding(18)
        }
        .presentationBackground { EmployeesAurora() }
        // Money write → Bangla confirm with name + amount; debits add the web
        // "Confirm wallet debit" balance math.
        .confirmationDialog(
            isDebit ? "ওয়ালেট ডেবিট নিশ্চিত করুন" : "পে-রোল এন্ট্রি নিশ্চিত করুন",
            isPresented: $showConfirm,
            titleVisibility: .visible
        ) {
            Button(isDebit ? "হ্যাঁ, ওয়ালেট থেকে কাটুন" : "নিশ্চিত করুন",
                   role: isDebit ? .destructive : nil) {
                Task {
                    if await vm.addPayroll(
                        empId: employee.empId, txType: txType, amount: amount,
                        date: employeeIsoDate(date), periodYm: periodYm, note: note) {
                        dismiss()
                    } else {
                        formError = vm.actionError
                    }
                }
            }
            Button("বাতিল", role: .cancel) {}
        } message: {
            if isDebit {
                let balance = vm.wallet?.summary?.currentBalance ?? 0
                Text("\(employee.name)-এর ওয়ালেট ব্যালেন্স ৳\(Int(amount.rounded()).formatted()) কমবে। এখনকার ব্যালেন্স ৳\(balance.formatted()) → এন্ট্রির পরে ৳\((balance - Int(amount.rounded())).formatted())। স্যালারি দিতে সাধারণত \"Credit salary\" ব্যবহার করুন।")
            } else {
                Text("\(employee.name)-এর ওয়ালেটে \(txType == "deposit" ? "৳\(Int(amount.rounded()).formatted()) যোগ হবে" : "৳\(Int(amount.rounded()).formatted()) অ্যাডজাস্টমেন্ট হবে")।")
            }
        }
    }
}

// MARK: - Salary edit sheet (web "Update salary" modal —
// PATCH /api/hr/employees/{emp_id}/salary)

@available(iOS 17.0, *)
private struct EmployeeSalaryEditSheet: View {
    let employee: EmployeeRosterItem
    let vm: EmployeeDetailVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var newSalaryText = ""
    @State private var effectiveDate = Date()
    @State private var reason = ""
    @State private var formError: String? = nil
    @State private var showConfirm = false

    private var newSalary: Int { Int((Double(newSalaryText) ?? 0).rounded()) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Update salary for \(employee.name)").font(.headline)
                if let err = formError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(EmployeePalette.red500)
                }
                EmployeeField(label: "Current salary") {
                    Text("৳\(employee.monthlySalary.formatted())")
                        .font(.subheadline.monospaced())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .employeeInputChrome(colorScheme)
                }
                EmployeeField(label: "New monthly salary (৳)") {
                    TextField("\(employee.monthlySalary)", text: $newSalaryText)
                        .font(.subheadline.monospaced())
                        .keyboardType(.numberPad)
                        .employeeInputChrome(colorScheme)
                }
                EmployeeField(label: "Effective from") {
                    DatePicker("", selection: $effectiveDate, displayedComponents: .date)
                        .labelsHidden()
                }
                Text("New monthly accrual will start from the effective date you choose (stored in audit for now). Past accruals are not recalculated.")
                    .font(.system(size: 9)).foregroundStyle(.secondary)
                EmployeeField(label: "Reason (optional)") {
                    TextField("e.g. annual increment, role change", text: $reason, axis: .vertical)
                        .lineLimit(2...3).font(.caption)
                        .employeeInputChrome(colorScheme)
                }
                HStack(spacing: 10) {
                    Button {
                        formError = nil
                        // Web submitSalary guards verbatim.
                        guard newSalary > 0 else {
                            formError = "Enter a valid salary amount"
                            return
                        }
                        guard newSalary <= 1_000_000 else {
                            formError = "Salary cannot exceed ৳1,000,000"
                            return
                        }
                        guard newSalary != employee.monthlySalary else {
                            formError = "New salary must differ from current salary"
                            return
                        }
                        showConfirm = true
                    } label: {
                        if vm.savingSalary {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("Save").frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(EmployeePalette.coral)
                    .disabled(vm.savingSalary)
                    Button("Cancel") { dismiss() }.buttonStyle(.bordered)
                }
            }
            .padding(18)
        }
        .presentationBackground { EmployeesAurora() }
        .confirmationDialog(
            "স্যালারি পরিবর্তন নিশ্চিত করুন",
            isPresented: $showConfirm,
            titleVisibility: .visible
        ) {
            Button("স্যালারি আপডেট করুন", role: .destructive) {
                Task {
                    if await vm.patchSalary(
                        empId: employee.empId, amount: newSalary,
                        effectiveDate: employeeIsoDate(effectiveDate),
                        reason: reason) {
                        dismiss()
                    } else {
                        formError = vm.actionError
                    }
                }
            }
            Button("বাতিল", role: .cancel) {}
        } message: {
            Text("\(employee.name)-এর মাসিক বেতন ৳\(employee.monthlySalary.formatted()) থেকে ৳\(newSalary.formatted()) হবে।")
        }
    }
}

// MARK: - Salary correction sheet (web "Request salary correction" modal —
// POST /api/payroll/salary-corrections; lands in the approvals system, same as web)

@available(iOS 17.0, *)
private struct EmployeeCorrectionSheet: View {
    let employee: EmployeeRosterItem
    let vm: EmployeeDetailVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    private struct ReversalDraft: Identifiable {
        let id = UUID()
        var ledgerEntryId = ""
        var amountText = ""
        var reason = ""
    }

    @State private var accrualId = ""
    @State private var proposedText = ""
    @State private var reason = ""
    @State private var reversals: [ReversalDraft] = []
    @State private var formError: String? = nil
    @State private var showConfirm = false

    private var selectedAccrual: EmployeeWalletEntry? {
        vm.salaryAccrualEntries.first { $0.entryId == accrualId }
    }
    private var proposedAmount: Int { Int((Double(proposedText) ?? 0).rounded()) }
    private var delta: Int? {
        guard let acc = selectedAccrual, proposedAmount != 0 else { return nil }
        return proposedAmount - acc.amount
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Request salary correction for \(employee.name)").font(.headline)
                if let err = formError {
                    Label(err, systemImage: "exclamationmark.triangle")
                        .font(.footnote).foregroundStyle(EmployeePalette.red500)
                }
                stepOne
                stepTwo
                stepThree
                stepFour
                footer
            }
            .padding(18)
        }
        .presentationBackground { EmployeesAurora() }
        .confirmationDialog(
            "সংশোধনের অনুরোধ নিশ্চিত করুন",
            isPresented: $showConfirm,
            titleVisibility: .visible
        ) {
            Button("অনুমোদনের জন্য পাঠান") {
                Task { await submit() }
            }
            Button("বাতিল", role: .cancel) {}
        } message: {
            Text("\(employee.name)-এর \(selectedAccrual?.periodYm ?? "—") অ্যাক্রুয়াল ৳\((selectedAccrual?.amount ?? 0).formatted()) → ৳\(proposedAmount.formatted()) করার অনুরোধ সুপার অ্যাডমিন অনুমোদনে যাবে।")
        }
    }

    private func stepLabel(_ text: String) -> some View {
        Text(text).font(.system(size: 9, weight: .black)).textCase(.uppercase)
            .foregroundStyle(.secondary)
    }

    private var stepOne: some View {
        VStack(alignment: .leading, spacing: 8) {
            stepLabel("Step 1 · Target accrual")
            if vm.salaryAccrualEntries.isEmpty {
                Text("No SALARY_ACCRUAL entries in this wallet yet.")
                    .font(.caption2).foregroundStyle(.secondary)
            } else {
                ForEach(vm.salaryAccrualEntries) { entry in
                    let selected = accrualId == entry.entryId
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        accrualId = entry.entryId ?? ""
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                                .foregroundStyle(selected ? EmployeePalette.coral : .secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.periodYm ?? String((entry.date ?? "—").prefix(10)))
                                    .font(.caption.weight(.bold))
                                Text("৳\(entry.amount.formatted())")
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(EmployeePalette.accentText(colorScheme))
                                if let note = entry.note, !note.isEmpty {
                                    Text(note).font(.system(size: 9))
                                        .foregroundStyle(.secondary).lineLimit(2)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(10)
                        .background(
                            selected ? EmployeePalette.coral.opacity(colorScheme == .dark ? 0.20 : 0.10)
                                     : Color.white.opacity(colorScheme == .dark ? 0.05 : 0.35),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                            .strokeBorder(selected ? EmployeePalette.coral.opacity(0.5)
                                                   : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                                          lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var stepTwo: some View {
        VStack(alignment: .leading, spacing: 8) {
            stepLabel("Step 2 · New amount")
            TextField(selectedAccrual.map { "Current ৳\($0.amount.formatted())" } ?? "Select accrual first",
                      text: $proposedText)
                .font(.subheadline.monospaced())
                .keyboardType(.numberPad)
                .disabled(selectedAccrual == nil)
                .opacity(selectedAccrual == nil ? 0.5 : 1)
                .employeeInputChrome(colorScheme)
            if let delta {
                Text("Change: \(delta >= 0 ? "+" : "−")৳\(abs(delta).formatted())")
                    .font(.caption2.monospaced().weight(.bold))
                    .foregroundStyle(delta >= 0 ? EmployeePalette.emerald600 : EmployeePalette.red500)
            }
        }
    }

    private var stepThree: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                stepLabel("Step 3 · Reverse other entries (optional)")
                Spacer()
                Button("+ Add reversal") {
                    reversals.append(ReversalDraft())
                }
                .font(.caption2.weight(.semibold))
                .disabled(selectedAccrual == nil)
            }
            if reversals.isEmpty {
                Text("Use this to cancel a wrong withdrawal or adjustment when approving.")
                    .font(.caption2).foregroundStyle(.secondary)
            } else {
                ForEach($reversals) { $row in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Reversal").font(.caption2).foregroundStyle(.secondary)
                            Spacer()
                            Button("Remove") {
                                reversals.removeAll { $0.id == row.id }
                            }
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(EmployeePalette.red500)
                        }
                        Picker("Select ledger entry…", selection: $row.ledgerEntryId) {
                            Text("Select ledger entry…").tag("")
                            ForEach(vm.reversalCandidateEntries) { entry in
                                Text("\((entry.type ?? "—").replacingOccurrences(of: "_", with: " ")) · ৳\(abs(entry.amount).formatted()) · \(String((entry.note ?? entry.entryId ?? "").prefix(40)))")
                                    .tag(entry.entryId ?? "")
                            }
                        }
                        .pickerStyle(.menu)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .employeeInputChrome(colorScheme)
                        TextField("Amount (+ credit back, − debit)", text: $row.amountText)
                            .font(.caption.monospaced())
                            .keyboardType(.numbersAndPunctuation)
                            .employeeInputChrome(colorScheme)
                        TextField("Why reverse this entry", text: $row.reason)
                            .font(.caption)
                            .employeeInputChrome(colorScheme)
                    }
                    .padding(10)
                    .background(Color.white.opacity(colorScheme == .dark ? 0.05 : 0.35),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                }
            }
        }
    }

    private var stepFour: some View {
        VStack(alignment: .leading, spacing: 8) {
            stepLabel("Step 4 · Reason (required)")
            TextField("Explain why this accrual amount should change", text: $reason, axis: .vertical)
                .lineLimit(3...5).font(.caption)
                .employeeInputChrome(colorScheme)
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button {
                formError = nil
                if validate() { showConfirm = true }
            } label: {
                if vm.correctionSubmitting {
                    ProgressView().frame(maxWidth: .infinity)
                } else {
                    Text("Submit for approval").frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(EmployeePalette.coral)
            .disabled(vm.correctionSubmitting || vm.salaryAccrualEntries.isEmpty)
            Button("Cancel") { dismiss() }.buttonStyle(.bordered)
        }
    }

    /// Web submitSalaryCorrection guards verbatim.
    private func validate() -> Bool {
        guard let acc = selectedAccrual, acc.entryId != nil else {
            formError = "Select a salary accrual to correct"
            return false
        }
        guard let period = acc.periodYm?.trimmingCharacters(in: .whitespaces), !period.isEmpty else {
            formError = "Selected accrual is missing a period"
            return false
        }
        guard proposedAmount > 0 else {
            formError = "Proposed amount must be greater than zero"
            return false
        }
        guard proposedAmount != acc.amount else {
            formError = "Proposed amount must differ from the current accrual"
            return false
        }
        guard reason.trimmingCharacters(in: .whitespacesAndNewlines).count >= 5 else {
            formError = "Reason must be at least 5 characters"
            return false
        }
        for row in reversals where !row.ledgerEntryId.trimmingCharacters(in: .whitespaces).isEmpty {
            let amount = Int((Double(row.amountText) ?? 0).rounded())
            if amount == 0 {
                formError = "Each reversal needs a non-zero amount"
                return false
            }
            if row.reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                formError = "Each reversal needs a reason"
                return false
            }
        }
        return true
    }

    private func submit() async {
        guard let acc = selectedAccrual, let accId = acc.entryId,
              let period = acc.periodYm?.trimmingCharacters(in: .whitespaces) else { return }
        let revs: [(ledgerEntryId: String, amount: Int, reason: String)] = reversals.compactMap { row in
            let entryId = row.ledgerEntryId.trimmingCharacters(in: .whitespaces)
            guard !entryId.isEmpty else { return nil }
            return (entryId,
                    Int((Double(row.amountText) ?? 0).rounded()),
                    row.reason.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        if await vm.requestCorrection(
            empId: employee.empId, accrualEntryId: accId, periodYm: period,
            proposedAmount: proposedAmount,
            reason: reason.trimmingCharacters(in: .whitespacesAndNewlines),
            reversals: revs) {
            dismiss()
        } else {
            formError = vm.actionError
        }
    }
}

// MARK: - Formatting helpers (web util parity)

private enum EmployeeFormat {
    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }

    /// Web displayBdPhone: normalize to +8801XXXXXXXXX then "+880 1XX XXX XXXX".
    static func bdPhone(_ raw: String) -> String {
        var digits = raw.trimmingCharacters(in: .whitespaces)
            .filter { $0.isNumber || $0 == "+" }
        if digits.hasPrefix("+") {
            digits = "+" + digits.dropFirst().filter { $0.isNumber }
        }
        var normalized = digits
        if digits.hasPrefix("880") { normalized = "+" + digits }
        else if digits.hasPrefix("01") && digits.count == 11 { normalized = "+88" + digits }
        if normalized.hasPrefix("+880") && normalized.count == 14 {
            let s = Array(normalized)
            return String(s[0..<4]) + " " + String(s[4..<7]) + " " + String(s[7..<10]) + " " + String(s[10...])
        }
        return normalized
    }

    /// Minutes → "7h 45m" (web durationLabel).
    static func duration(_ minutes: Int) -> String {
        let h = minutes / 60, m = minutes % 60
        if h == 0 { return "\(m)m" }
        return "\(h)h \(m)m"
    }

    /// ISO timestamp → "10:05 AM" in Asia/Dhaka (web timeLabel).
    static func time(_ iso: String?) -> String {
        guard let iso, let date = parse(iso) else { return "—" }
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }
}

// MARK: - Aurora background + glass (Employees-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct EmployeesAurora: View {
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
    func employeesGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct EmployeesShimmer: ViewModifier {
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
    func employeesShimmer() -> some View { modifier(EmployeesShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Employees — Light") {
    EmployeesScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
