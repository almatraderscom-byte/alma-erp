//
//  PortalSwiftUI.swift
//  ALMA ERP — the staff "My desk" (/portal) as a native SwiftUI screen.
//
//  Mirrors the web /portal page — same endpoints, same colours:
//    GET  /api/users/me?business_id=…                     → profile (name/role/shift/HR id)
//    GET  /api/attendance?business_id=…&scope=me          → today + monthly summary
//    GET  /api/payroll/wallet/{empId}?business_id=…       → wallet summary + ledger + requests
//    GET  /api/operational-tasks/my?business_id=…         → my active tasks
//    GET  /api/attendance/leave?business_id=…             → my leave applications
//    GET  /api/attendance/exceptions?business_id=…        → today's exception status
//    POST /api/payroll/wallet/requests                    → withdraw / advance request
//    POST /api/attendance/leave                           → ছুটির আবেদন (kind/dates/times/reason)
//    POST /api/attendance/exceptions                      → checkout-exception (scope + reason)
//    POST /api/payroll/wallet/advance-notice              → advance-notice "বুঝেছি" ack
//    GET  /api/payroll/meal-allowance/eligibility          → meal-allowance status
//    POST /api/payroll/meal-allowance/requests             → meal-allowance self-request
//    GET  /api/payroll/driving-mode/status                 → driving-mode session state
//    POST /api/payroll/driving-mode/start | /end           → driving-mode start / end
//    POST /api/attendance/waivers                          → penalty-appeal (review request)
//    DELETE /api/attendance/waivers/{id}                   → cancel pending appeal
//  iOS re-set: personal dashboard cards — greeting, my balance, my tasks with
//  status circles, attendance summary — plus NATIVE request sheets (wallet
//  withdraw/advance, leave apply, checkout exception) with confirm dialogs.
//  Check-in / check-out stays on the web (selfie camera + GPS geofence).
//  Carried lessons: lenient per-field decoding, ONE load path, no global overlay.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum PortalPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Task priority ring — CRITICAL red, HIGH amber, NORMAL coral, LOW muted.
    static func priority(_ p: String?) -> Color {
        switch p {
        case "CRITICAL": return red500
        case "HIGH": return amber600
        case "LOW": return .secondary
        default: return coral
        }
    }

    /// Wallet-request / leave status colouring (web: PENDING amber · APPROVED green · else red).
    static func requestStatus(_ s: String) -> Color {
        if s == "PENDING" { return amber600 }
        if s.contains("APPROVED") { return green400 }
        return red500
    }
}

// MARK: - Flexible decoding helper (numbers arrive as Int / Double / String)

private func portalFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: key) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: key) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: key), let d = Double(s) { return Int(d.rounded()) }
    return nil
}

// MARK: - Models (same field names the web page types declare)

/// GET /api/users/me → { user } — the desk profile (useMyDeskProfile parity).
struct PortalProfile: Decodable {
    let id: String
    let name: String
    let email: String?
    let phone: String?
    let role: String?
    let businessAccess: String?
    let employeeIdGas: String?
    let salaryHint: Int?
    let isSystemOwner: Bool?
    // Flattened from the nested `profile` object (GAS roster details).
    let roleTitle: String?
    let shift: String?

    private enum Keys: String, CodingKey {
        case id, name, email, phone, role, businessAccess, employeeIdGas, salaryHint
        case isSystemOwner, profile
    }
    private enum ProfileKeys: String, CodingKey { case roleTitle, shift }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? "Account"
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        role = try? c.decodeIfPresent(String.self, forKey: .role)
        businessAccess = try? c.decodeIfPresent(String.self, forKey: .businessAccess)
        employeeIdGas = try? c.decodeIfPresent(String.self, forKey: .employeeIdGas)
        salaryHint = portalFlexInt(c, .salaryHint)
        isSystemOwner = try? c.decodeIfPresent(Bool.self, forKey: .isSystemOwner)
        let p = try? c.nestedContainer(keyedBy: ProfileKeys.self, forKey: .profile)
        roleTitle = p.flatMap { try? $0.decodeIfPresent(String.self, forKey: .roleTitle) }
        shift = p.flatMap { try? $0.decodeIfPresent(String.self, forKey: .shift) }
    }
}

struct PortalProfileResponse: Decodable {
    let user: PortalProfile?
    private enum Keys: String, CodingKey { case ok, data, user }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        user = try? c.decodeIfPresent(PortalProfile.self, forKey: .user)
    }
}

/// One attendance day (web AttendanceRecordDto slice the desk shows).
struct PortalAttendanceToday: Decodable {
    let id: String?
    let attendanceDate: String?
    let checkInAt: String?
    let checkOutAt: String?
    let totalWorkMinutes: Int?
    let lateMinutes: Int?
    let penaltyAmount: Int?
    let waiverRequests: [PortalWaiver]

    private enum Keys: String, CodingKey {
        case id, attendanceDate, checkInAt, checkOutAt, totalWorkMinutes, lateMinutes
        case penaltyAmount, waiverRequests
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try? c.decodeIfPresent(String.self, forKey: .id)
        attendanceDate = try? c.decodeIfPresent(String.self, forKey: .attendanceDate)
        checkInAt = try? c.decodeIfPresent(String.self, forKey: .checkInAt)
        checkOutAt = try? c.decodeIfPresent(String.self, forKey: .checkOutAt)
        totalWorkMinutes = portalFlexInt(c, .totalWorkMinutes)
        lateMinutes = portalFlexInt(c, .lateMinutes)
        penaltyAmount = portalFlexInt(c, .penaltyAmount)
        waiverRequests = (try? c.decodeIfPresent([PortalWaiver].self, forKey: .waiverRequests)) ?? []
    }
}

/// One penalty-appeal waiver (web AttendanceWaiverDto slice the desk shows).
struct PortalWaiver: Decodable, Identifiable {
    let id: String
    let status: String
    let statusLabel: String?
    let requestType: String?
    let originalPenaltyAmount: Int?
    let requestedReductionAmount: Int?
    let approvedReductionAmount: Int?
    let finalAppliedPenalty: Int?
    let adminNote: String?

    private enum Keys: String, CodingKey {
        case id, status, statusLabel, requestType, originalPenaltyAmount
        case requestedReductionAmount, approvedReductionAmount, finalAppliedPenalty, adminNote
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "PENDING"
        statusLabel = try? c.decodeIfPresent(String.self, forKey: .statusLabel)
        requestType = try? c.decodeIfPresent(String.self, forKey: .requestType)
        originalPenaltyAmount = portalFlexInt(c, .originalPenaltyAmount)
        requestedReductionAmount = portalFlexInt(c, .requestedReductionAmount)
        approvedReductionAmount = portalFlexInt(c, .approvedReductionAmount)
        finalAppliedPenalty = portalFlexInt(c, .finalAppliedPenalty)
        adminNote = try? c.decodeIfPresent(String.self, forKey: .adminNote)
    }

    /// Web PenaltyAppealStatus: statusLabel wins over raw status for display.
    var effectiveStatus: String { statusLabel ?? status }
    /// Web labelStatus() — "fully approved" / "partially approved" / lowercased.
    var statusText: String {
        let s = effectiveStatus
        if s == "FULLY_APPROVED" || s == "APPROVED" { return "fully approved" }
        if s == "PARTIALLY_APPROVED" { return "partially approved" }
        return s.lowercased().replacingOccurrences(of: "_", with: " ")
    }
}

struct PortalAttendanceSummary: Decodable {
    let presentDays: Int
    let lateCount: Int
    let totalPenalties: Int
    let waivedPenalties: Int

    private enum Keys: String, CodingKey { case presentDays, lateCount, totalPenalties, waivedPenalties }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        presentDays = portalFlexInt(c, .presentDays) ?? 0
        lateCount = portalFlexInt(c, .lateCount) ?? 0
        totalPenalties = portalFlexInt(c, .totalPenalties) ?? 0
        waivedPenalties = portalFlexInt(c, .waivedPenalties) ?? 0
    }
}

/// GET /api/attendance?scope=me — apiDataSuccess-wrapped `{ ok, data: {…} }`.
struct PortalAttendanceResponse: Decodable {
    let today: PortalAttendanceToday?
    let summary: PortalAttendanceSummary?
    let needsEmployeeLink: Bool?

    private enum Keys: String, CodingKey { case ok, data, today, summary, needsEmployeeLink }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        today = try? c.decodeIfPresent(PortalAttendanceToday.self, forKey: .today)
        summary = try? c.decodeIfPresent(PortalAttendanceSummary.self, forKey: .summary)
        needsEmployeeLink = try? c.decodeIfPresent(Bool.self, forKey: .needsEmployeeLink)
    }
}

/// Wallet summary — the ten stats the web WalletOverviewCard renders.
struct PortalWalletSummary: Decodable {
    let currentBalance: Int
    let availableWithdrawable: Int
    let totalAccrued: Int
    let totalCommissions: Int
    let totalEidBonuses: Int
    let totalOvertime: Int
    let totalPenalties: Int
    let totalMealDeductions: Int
    let totalAdvances: Int
    let totalWithdrawals: Int
    let outstandingAdvance: Int

    private enum Keys: String, CodingKey {
        case currentBalance, availableWithdrawable, totalAccrued, totalCommissions
        case totalEidBonuses, totalOvertime, totalPenalties, totalMealDeductions
        case totalAdvances, totalWithdrawals, outstandingAdvance
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        currentBalance = portalFlexInt(c, .currentBalance) ?? 0
        availableWithdrawable = portalFlexInt(c, .availableWithdrawable) ?? 0
        totalAccrued = portalFlexInt(c, .totalAccrued) ?? 0
        totalCommissions = portalFlexInt(c, .totalCommissions) ?? 0
        totalEidBonuses = portalFlexInt(c, .totalEidBonuses) ?? 0
        totalOvertime = portalFlexInt(c, .totalOvertime) ?? 0
        totalPenalties = portalFlexInt(c, .totalPenalties) ?? 0
        totalMealDeductions = portalFlexInt(c, .totalMealDeductions) ?? 0
        totalAdvances = portalFlexInt(c, .totalAdvances) ?? 0
        totalWithdrawals = portalFlexInt(c, .totalWithdrawals) ?? 0
        outstandingAdvance = portalFlexInt(c, .outstandingAdvance) ?? 0
    }
}

struct PortalWalletEntry: Decodable, Identifiable {
    let id: String
    let date: String?
    let type: String?
    let source: String?
    let signedAmount: Int
    let runningBalance: Int

    private enum Keys: String, CodingKey { case id, date, type, source, signedAmount, runningBalance }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        date = try? c.decodeIfPresent(String.self, forKey: .date)
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        signedAmount = portalFlexInt(c, .signedAmount) ?? 0
        runningBalance = portalFlexInt(c, .runningBalance) ?? 0
        id = (try? c.decodeIfPresent(String.self, forKey: .id))
            ?? "\(date ?? "?")-\(type ?? "?")-\(signedAmount)-\(runningBalance)"
    }

    /// Web walletTxLabel: attendance fines all post as PENALTY, so the ledger
    /// `source` tells them apart — exact Bangla strings from the web map.
    var label: String {
        switch source {
        case "attendance_late_penalty": return "দেরিতে আসার জরিমানা"
        case "attendance_early_leave_penalty": return "আগে বের হওয়ার জরিমানা"
        case "attendance_no_checkout_fine": return "চেক-আউট না করার জরিমানা"
        case "attendance_late_penalty_reversal": return "জরিমানা ফেরত (আপিল)"
        case "attendance_exception_refund": return "জরিমানা ফেরত (অনুমতি)"
        default: return (type ?? "—").replacingOccurrences(of: "_", with: " ")
        }
    }
}

struct PortalWalletRequest: Decodable, Identifiable {
    let id: String
    let type: String
    let status: String
    let requestedAmount: Int
    let createdAt: String?

    private enum Keys: String, CodingKey { case id, type, status, requestedAmount, createdAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? "—"
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "PENDING"
        requestedAmount = portalFlexInt(c, .requestedAmount) ?? 0
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

/// GET /api/payroll/wallet/{empId} → EmployeeWalletResponse (summary + entries + requests).
struct PortalWalletResponse: Decodable {
    let summary: PortalWalletSummary?
    let entries: [PortalWalletEntry]
    let requests: [PortalWalletRequest]
    let advanceNoticeAckedToday: Bool?

    private enum Keys: String, CodingKey { case ok, data, summary, entries, requests, advanceNoticeAckedToday }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        summary = try? c.decodeIfPresent(PortalWalletSummary.self, forKey: .summary)
        entries = (try? c.decodeIfPresent([PortalWalletEntry].self, forKey: .entries)) ?? []
        requests = (try? c.decodeIfPresent([PortalWalletRequest].self, forKey: .requests)) ?? []
        advanceNoticeAckedToday = try? c.decodeIfPresent(Bool.self, forKey: .advanceNoticeAckedToday)
    }
}

/// GET /api/operational-tasks/my → { tasks } (OperationalTaskAssignmentDto slice).
struct PortalTaskAssignment: Decodable, Identifiable {
    let id: String
    let status: String?
    let title: String
    let details: String?
    let priority: String?
    let deadline: String?
    let assignedByName: String?

    private enum Keys: String, CodingKey { case id, status, task }
    private enum TaskKeys: String, CodingKey { case title, description, priority, deadline, assignedBy }
    private enum ByKeys: String, CodingKey { case name }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        let t = try? c.nestedContainer(keyedBy: TaskKeys.self, forKey: .task)
        title = t.flatMap { try? $0.decodeIfPresent(String.self, forKey: .title) } ?? "—"
        details = t.flatMap { try? $0.decodeIfPresent(String.self, forKey: .description) }
        priority = t.flatMap { try? $0.decodeIfPresent(String.self, forKey: .priority) }
        deadline = t.flatMap { try? $0.decodeIfPresent(String.self, forKey: .deadline) }
        let by = t.flatMap { try? $0.nestedContainer(keyedBy: ByKeys.self, forKey: .assignedBy) }
        assignedByName = by.flatMap { try? $0.decodeIfPresent(String.self, forKey: .name) }
    }
}

struct PortalTasksResponse: Decodable {
    let tasks: [PortalTaskAssignment]
    private enum Keys: String, CodingKey { case ok, data, tasks }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        tasks = (try? c.decodeIfPresent([PortalTaskAssignment].self, forKey: .tasks)) ?? []
    }
}

/// GET /api/attendance/leave → { leaves } — my leave applications with status.
struct PortalLeave: Decodable, Identifiable {
    let id: String
    let kind: String?
    let status: String
    let startDate: String?
    let endDate: String?
    let startMinutes: Int?
    let endMinutes: Int?

    private enum Keys: String, CodingKey { case id, kind, status, startDate, endDate, startMinutes, endMinutes }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "PENDING"
        startDate = try? c.decodeIfPresent(String.self, forKey: .startDate)
        endDate = try? c.decodeIfPresent(String.self, forKey: .endDate)
        startMinutes = portalFlexInt(c, .startMinutes)
        endMinutes = portalFlexInt(c, .endMinutes)
    }

    /// Web LEAVE_KIND_LABEL — exact strings.
    var kindLabel: String {
        switch kind {
        case "FULL_DAY": return "একদিন"
        case "DATE_RANGE": return "কয়েকদিন"
        case "HOURS": return "কয়েক ঘণ্টা"
        case "SHIFTED_START": return "দেরিতে শুরু"
        default: return kind ?? "—"
        }
    }
    /// Web LEAVE_STATUS_LABEL — exact strings.
    var statusLabel: String {
        switch status {
        case "PENDING": return "⏳ অপেক্ষমাণ"
        case "APPROVED": return "✅ অনুমোদিত"
        case "REJECTED": return "❌ প্রত্যাখ্যাত"
        case "CANCELLED": return "বাতিল"
        default: return status
        }
    }
}

struct PortalLeaveResponse: Decodable {
    let leaves: [PortalLeave]
    private enum Keys: String, CodingKey { case ok, data, leaves }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        leaves = (try? c.decodeIfPresent([PortalLeave].self, forKey: .leaves)) ?? []
    }
}

/// GET /api/attendance/exceptions → { exception: { status } | null } — today's
/// rule-waiver request status (PENDING / APPROVED / …), apiDataSuccess-tolerant.
struct PortalExceptionResponse: Decodable {
    let status: String?
    private enum Keys: String, CodingKey { case ok, data, exception }
    private enum ExKeys: String, CodingKey { case status }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        let ex = try? c.nestedContainer(keyedBy: ExKeys.self, forKey: .exception)
        status = ex.flatMap { try? $0.decodeIfPresent(String.self, forKey: .status) }
    }
}

/// GET /api/payroll/meal-allowance/eligibility → web MealEligibility
/// { enabled, amountBdt, canRequestToday, pendingRequest: { status, amountBdt } | null, reason }.
struct PortalMealEligibility: Decodable {
    let enabled: Bool
    let amountBdt: Int
    let canRequestToday: Bool
    let pendingStatus: String?
    let pendingAmount: Int?
    let reason: String?

    private enum Keys: String, CodingKey { case ok, data, enabled, amountBdt, canRequestToday, pendingRequest, reason }
    private enum PendingKeys: String, CodingKey { case status, amountBdt }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        amountBdt = portalFlexInt(c, .amountBdt) ?? 0
        canRequestToday = (try? c.decodeIfPresent(Bool.self, forKey: .canRequestToday)) ?? false
        let p = try? c.nestedContainer(keyedBy: PendingKeys.self, forKey: .pendingRequest)
        pendingStatus = p.flatMap { try? $0.decodeIfPresent(String.self, forKey: .status) }
        pendingAmount = p.flatMap { portalFlexInt($0, .amountBdt) }
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// GET /api/payroll/driving-mode/status → web DrivingStatus
/// { enabled, activeSession | null, pendingSession | null, canStart, reason }.
struct PortalDrivingStatus: Decodable {
    let enabled: Bool
    let hasActiveSession: Bool
    let hasPendingSession: Bool
    let canStart: Bool
    let reason: String?

    private enum Keys: String, CodingKey { case ok, data, enabled, activeSession, pendingSession, canStart, reason }
    private enum SessionKeys: String, CodingKey { case id }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        // Session objects arrive as { id, … } or null — presence is the state.
        hasActiveSession = (try? c.nestedContainer(keyedBy: SessionKeys.self, forKey: .activeSession)) != nil
        hasPendingSession = (try? c.nestedContainer(keyedBy: SessionKeys.self, forKey: .pendingSession)) != nil
        canStart = (try? c.decodeIfPresent(Bool.self, forKey: .canStart)) ?? false
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// Mutation ack — every portal POST answers { ok } (+ optional error message).
struct PortalActionResponse: Decodable {
    let ok: Bool
    let errorMessage: String?
    private enum Keys: String, CodingKey { case ok, error }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? true
        errorMessage = try? c.decodeIfPresent(String.self, forKey: .error)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class PortalVM {
    /// The same business the other native tabs scope to (web _businessId default).
    static let businessId = "ALMA_LIFESTYLE"

    var profile: PortalProfile? = nil
    var attendance: PortalAttendanceResponse? = nil
    var walletSummary: PortalWalletSummary? = nil
    var walletEntries: [PortalWalletEntry] = []
    var walletRequests: [PortalWalletRequest] = []
    var advanceNoticeAckedToday = false
    var tasks: [PortalTaskAssignment] = []
    var leaves: [PortalLeave] = []
    var exceptionStatus: String? = nil    // today's rule-waiver request (web exceptionStatus)
    var mealEligibility: PortalMealEligibility? = nil
    var drivingStatus: PortalDrivingStatus? = nil
    var loading = false
    var busyActions: Set<String> = []     // "wallet" | "leave" | "exception" | "ack" | "meal" | "driving" | "appeal" | "cancelWaiver"
    var error: String? = nil
    var notice: String? = nil             // success line (the web's toast)
    var authExpired = false

    var employeeId: String? {
        let emp = profile?.employeeIdGas?.trimmingCharacters(in: .whitespaces)
        return (emp?.isEmpty == false) ? emp : nil
    }
    var isSystemOwner: Bool { profile?.isSystemOwner == true }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }

        // Profile first — the wallet call needs the HR employee id it resolves.
        do {
            let resp: PortalProfileResponse = try await AlmaAPI.shared.get(
                "/api/users/me", query: ["business_id": Self.businessId])
            profile = resp.user
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return
        } catch {
            if Self.isCancellation(error) { return }
            self.error = error.localizedDescription
            return
        }

        // The owner account intentionally has no personal desk data (web parity).
        if isSystemOwner { return }

        // The staff blocks load concurrently; each is tolerant of its own failure.
        async let attendanceResp = Self.fetch(
            PortalAttendanceResponse.self, "/api/attendance",
            ["business_id": Self.businessId, "scope": "me"])
        async let walletResp = Self.fetchWallet(employeeId)
        async let tasksResp = Self.fetch(
            PortalTasksResponse.self, "/api/operational-tasks/my",
            ["business_id": Self.businessId])
        async let leavesResp = Self.fetch(
            PortalLeaveResponse.self, "/api/attendance/leave",
            ["business_id": Self.businessId])
        async let exceptionResp = Self.fetch(
            PortalExceptionResponse.self, "/api/attendance/exceptions",
            ["business_id": Self.businessId])
        async let mealResp = Self.fetch(
            PortalMealEligibility.self, "/api/payroll/meal-allowance/eligibility",
            ["business_id": Self.businessId])
        async let drivingResp = Self.fetch(
            PortalDrivingStatus.self, "/api/payroll/driving-mode/status",
            ["business_id": Self.businessId])

        attendance = await attendanceResp
        if let w = await walletResp {
            walletSummary = w.summary
            walletEntries = w.entries
            walletRequests = w.requests
            advanceNoticeAckedToday = w.advanceNoticeAckedToday == true
        }
        tasks = (await tasksResp)?.tasks ?? []
        leaves = (await leavesResp)?.leaves ?? []
        exceptionStatus = (await exceptionResp)?.status
        mealEligibility = await mealResp
        drivingStatus = await drivingResp
    }

    // MARK: Native staff actions (web form parity — same endpoints, same bodies)

    /// One POST + success notice + full reload — the web's submit→toast→refetch loop.
    private func act(_ key: String, path: String, body: [String: AnyEncodable],
                     success: String?) async -> Bool {
        guard !busyActions.contains(key) else { return false }
        busyActions.insert(key)
        notice = nil
        error = nil
        defer { busyActions.remove(key) }
        do {
            let resp: PortalActionResponse = try await AlmaAPI.shared.send("POST", path, body: body)
            guard resp.ok else {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                error = resp.errorMessage ?? "Request failed"
                return false
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = success
            await load()
            return true
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = Self.serverMessage(error)
            return false
        }
    }

    /// Web WalletRequestCard submit: POST /api/payroll/wallet/requests
    /// { type, amount, reason, business_id } — type WITHDRAWAL | ADVANCE.
    func submitWalletRequest(type: String, amount: Int, reason: String) async {
        _ = await act("wallet", path: "/api/payroll/wallet/requests",
                      body: [
                          "type": AnyEncodable(type),
                          "amount": AnyEncodable(amount),
                          "reason": AnyEncodable(reason),
                          "business_id": AnyEncodable(Self.businessId),
                      ],
                      success: type == "WITHDRAWAL"
                          ? "Withdrawal requested — awaiting approval"
                          : "Advance requested — awaiting approval")
    }

    /// Web requestLeave: POST /api/attendance/leave
    /// { business_id, kind, start_date, end_date, start_minutes, end_minutes, reason }.
    func submitLeave(kind: String, startDate: String, endDate: String,
                     startMinutes: Int?, endMinutes: Int?, reason: String) async {
        _ = await act("leave", path: "/api/attendance/leave",
                      body: [
                          "business_id": AnyEncodable(Self.businessId),
                          "kind": AnyEncodable(kind),
                          "start_date": AnyEncodable(startDate),
                          "end_date": AnyEncodable(endDate),
                          "start_minutes": AnyEncodable(startMinutes),
                          "end_minutes": AnyEncodable(endMinutes),
                          "reason": AnyEncodable(reason),
                      ],
                      success: "ছুটির আবেদন মালিকের কাছে পাঠানো হয়েছে।")
    }

    /// Web requestException: POST /api/attendance/exceptions
    /// { business_id, reason, scope } — scope EARLY_CHECKOUT | LATE_ARRIVAL | FULL_DAY.
    func submitException(scope: String, reason: String) async {
        let ok = await act("exception", path: "/api/attendance/exceptions",
                           body: [
                               "business_id": AnyEncodable(Self.businessId),
                               "reason": AnyEncodable(reason),
                               "scope": AnyEncodable(scope),
                           ],
                           success: "অনুমতির অনুরোধ মালিকের কাছে পাঠানো হয়েছে।")
        if ok { exceptionStatus = exceptionStatus ?? "PENDING" }
    }

    /// Web AdvanceRecoveryNotice "বুঝেছি": POST /api/payroll/wallet/advance-notice.
    func ackAdvanceNotice() async {
        _ = await act("ack", path: "/api/payroll/wallet/advance-notice",
                      body: ["business_id": AnyEncodable(Self.businessId)],
                      success: nil)
    }

    /// Web MealAllowanceCard submit: POST /api/payroll/meal-allowance/requests
    /// { business_id, reason }.
    func submitMealRequest(reason: String) async {
        _ = await act("meal", path: "/api/payroll/meal-allowance/requests",
                      body: [
                          "business_id": AnyEncodable(Self.businessId),
                          "reason": AnyEncodable(reason),
                      ],
                      success: "Meal allowance request submitted")
    }

    /// Web DrivingModeCard start: POST /api/payroll/driving-mode/start
    /// { business_id, reason } — reason optional (web sends the trimmed string).
    func startDrivingMode(reason: String) async {
        _ = await act("driving", path: "/api/payroll/driving-mode/start",
                      body: [
                          "business_id": AnyEncodable(Self.businessId),
                          "reason": AnyEncodable(reason),
                      ],
                      success: "Driving mode request sent for approval")
    }

    /// Web DrivingModeCard end: POST /api/payroll/driving-mode/end { business_id }.
    func endDrivingMode() async {
        _ = await act("driving", path: "/api/payroll/driving-mode/end",
                      body: ["business_id": AnyEncodable(Self.businessId)],
                      success: "Driving mode ended — welcome back")
    }

    /// Web PenaltyAppealModal submit: POST /api/attendance/waivers
    /// { business_id, attendance_record_id, reason, request_type,
    ///   requested_reduction_amount? } — attachment stays a web-only extra.
    func submitPenaltyAppeal(recordId: String, requestType: String,
                             reason: String, partialAmount: Int?) async {
        var body: [String: AnyEncodable] = [
            "business_id": AnyEncodable(Self.businessId),
            "attendance_record_id": AnyEncodable(recordId),
            "reason": AnyEncodable(reason),
            "request_type": AnyEncodable(requestType),
        ]
        if requestType == "PARTIAL_REDUCE" {
            body["requested_reduction_amount"] = AnyEncodable(partialAmount ?? 0)
        }
        _ = await act("appeal", path: "/api/attendance/waivers", body: body,
                      success: "Penalty review request submitted")
    }

    /// Web cancelAppeal: DELETE /api/attendance/waivers/{id}. business_id is
    /// optional server-side (wallet context falls back to the JWT's own scope).
    func cancelPenaltyAppeal(waiverId: String) async {
        guard !busyActions.contains("cancelWaiver") else { return }
        busyActions.insert("cancelWaiver")
        notice = nil
        error = nil
        defer { busyActions.remove("cancelWaiver") }
        do {
            let encoded = waiverId.addingPercentEncoding(
                withAllowedCharacters: .urlPathAllowedCharacters) ?? waiverId
            let resp: PortalActionResponse = try await AlmaAPI.shared.send(
                "DELETE", "/api/attendance/waivers/\(encoded)")
            guard resp.ok else {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                error = resp.errorMessage ?? "Request failed"
                return
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "Review request cancelled"
            await load()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = Self.serverMessage(error)
        }
    }

    /// Prefer the API's own { error } message over the raw HTTP dump.
    static func serverMessage(_ error: Error) -> String {
        if case AlmaAPIError.http(_, let body) = error,
           let data = body.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msg = obj["error"] as? String, !msg.isEmpty {
            return msg
        }
        return (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
    }

    private static func fetch<T: Decodable>(_ type: T.Type, _ path: String,
                                            _ query: [String: String?]) async -> T? {
        try? await AlmaAPI.shared.get(path, query: query)
    }

    private static func fetchWallet(_ empId: String?) async -> PortalWalletResponse? {
        guard let empId, !empId.isEmpty else { return nil }
        let encoded = empId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowedCharacters) ?? empId
        return await fetch(PortalWalletResponse.self,
                           "/api/payroll/wallet/\(encoded)",
                           ["business_id": businessId])
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the staff should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }
}

private extension CharacterSet {
    static let urlPathAllowedCharacters = CharacterSet.urlPathAllowed
}

// MARK: - Screen

@available(iOS 17.0, *)
struct PortalScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = PortalVM()
    @State private var walletSheet = false
    @State private var statementOpen = false
    @State private var leaveSheet = false
    @State private var exceptionSheet = false
    @State private var appealSheet = false
    @State private var mealReason = ""
    @State private var confirmMeal = false
    @State private var drivingReason = ""
    @State private var confirmDrivingStart = false
    @State private var confirmDrivingEnd = false
    @State private var cancelWaiverId: String? = nil
    @State private var confirmCancelWaiver = false
    @State private var showCheckIn = false
    @State private var confirmCheckOut = false
    @State private var attendanceError: String? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    /// Web gate for OfficeAdvanceDeskCard: ADMIN / SUPER_ADMIN only.
    private var isAdminRole: Bool {
        let role = vm.profile?.role ?? ""
        return role == "ADMIN" || role == "SUPER_ADMIN"
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if let ok = vm.notice { noticeCard(ok, tone: .success) }
                if vm.loading && vm.profile == nil && !vm.authExpired { loadingRows }
                if let profile = vm.profile {
                    greetingCard(profile)
                    if vm.isSystemOwner {
                        ownerCard
                        // The owner is an employee here too (web parity 2026-07-11):
                        // linked employee id → own full statement.
                        if vm.employeeId != nil {
                            Button {
                                statementOpen = true
                            } label: {
                                HStack {
                                    Text("আমার বেতন-খাতা — সম্পূর্ণ হিসাব")
                                        .font(.caption.weight(.bold))
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.caption2.weight(.bold))
                                }
                                .foregroundStyle(PortalPalette.coral)
                                .padding(14)
                                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
                            }
                        }
                    } else {
                        if let s = vm.walletSummary, s.outstandingAdvance > 0, !vm.advanceNoticeAckedToday {
                            advanceNotice(s.outstandingAdvance)
                        }
                        attendanceCard
                        // Web page order: payout identity + expense-refund entry
                        // cards, then the admin office-fund desk card.
                        payoutIdentityCard
                        expenseRefundCard
                        if isAdminRole { officeFundCard }
                        walletCard
                        salarySlipCard
                        if vm.mealEligibility?.enabled == true { mealAllowanceCard }
                        if vm.drivingStatus?.enabled == true { drivingModeCard }
                        if !vm.tasks.isEmpty { tasksCard }
                        leaveCard
                        walletHistoryCard
                        pendingRequestsCard
                    }
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(PortalAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .fullScreenCover(isPresented: $statementOpen) {
            if let emp = vm.employeeId {
                WalletStatementScreen(employeeId: emp, businessId: PortalVM.businessId)
            }
        }
        .sheet(isPresented: $walletSheet) {
            PortalWalletRequestSheet(
                availableWithdrawable: vm.walletSummary?.availableWithdrawable ?? 0
            ) { type, amount, reason in
                Task { await vm.submitWalletRequest(type: type, amount: amount, reason: reason) }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $leaveSheet) {
            PortalLeaveSheet { kind, start, end, startMin, endMin, reason in
                Task {
                    await vm.submitLeave(kind: kind, startDate: start, endDate: end,
                                         startMinutes: startMin, endMinutes: endMin, reason: reason)
                }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $exceptionSheet) {
            PortalExceptionSheet { scope, reason in
                Task { await vm.submitException(scope: scope, reason: reason) }
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $appealSheet) {
            PortalAppealSheet(
                penaltyAmount: vm.attendance?.today?.penaltyAmount ?? 0,
                lateMinutes: vm.attendance?.today?.lateMinutes ?? 0,
                attendanceDate: vm.attendance?.today?.attendanceDate
            ) { requestType, reason, partialAmount in
                guard let recordId = vm.attendance?.today?.id else { return }
                Task {
                    await vm.submitPenaltyAppeal(recordId: recordId, requestType: requestType,
                                                 reason: reason, partialAmount: partialAmount)
                }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
    }

    // ── Greeting + account details (web ProfilePhotoSection + "Account details") ──

    private func greetingCard(_ profile: PortalProfile) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Text(PortalFormat.initials(profile.name))
                    .font(.title3.weight(.bold))
                    .foregroundStyle(PortalPalette.accentText(colorScheme))
                    .frame(width: 52, height: 52)
                    .background(PortalPalette.coral.opacity(0.16), in: Circle())
                    .overlay(Circle().strokeBorder(PortalPalette.coral.opacity(0.35), lineWidth: 1))
                VStack(alignment: .leading, spacing: 2) {
                    Text("আসসালামু আলাইকুম 👋")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(profile.name).font(.headline.weight(.bold))
                    Text([profile.roleTitle ?? (profile.role ?? "").replacingOccurrences(of: "_", with: " "),
                          profile.shift.map { "Shift: \($0)" }]
                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
            }
            Divider().opacity(0.4)
            VStack(alignment: .leading, spacing: 6) {
                detailRow("Email", profile.email ?? "—", mono: true)
                detailRow("HR employee ID",
                          vm.isSystemOwner ? "System owner - not required"
                                           : (profile.employeeIdGas ?? "— link in Users"),
                          mono: true)
                if let scope = profile.businessAccess, !scope.isEmpty {
                    detailRow("Business scope", scope.replacingOccurrences(of: ",", with: ", "))
                }
                if let salary = profile.salaryHint {
                    detailRow("Salary hint", PortalFormat.money(salary), mono: true,
                              tone: PortalPalette.accentText(colorScheme))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func detailRow(_ label: String, _ value: String, mono: Bool = false,
                           tone: Color = .primary) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(mono ? .caption2.monospaced().weight(.semibold) : .caption2.weight(.semibold))
                .foregroundStyle(tone)
                .multilineTextAlignment(.trailing)
        }
    }

    /// Web SystemOwnerCard parity — owner accounts skip the staff desk blocks.
    private var ownerCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("SYSTEM OWNER MODE")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(PortalPalette.accentText(colorScheme))
            Text("Owner control active").font(.subheadline.weight(.bold))
            Text("Employee attendance, personal wallet requests, payroll linkage, and staff profile requirements are intentionally skipped for this account.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Advance-recovery notice (web AdvanceRecoveryNotice — exact Bangla) ──

    private func advanceNotice(_ outstanding: Int) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("📩").font(.title3)
            VStack(alignment: .leading, spacing: 4) {
                Text("অগ্রিম বেতন নোটিশ")
                    .font(.caption2.weight(.heavy))
                    .foregroundStyle(PortalPalette.amber600)
                Text("আপনি অগ্রিম (advance) বেতন নিয়েছেন — বাকি \(PortalFormat.money(outstanding))।")
                    .font(.footnote.weight(.bold))
                Text("এই টাকা আপনার পরের মাসের বেতন থেকে অটোমেটিক কেটে নেওয়া হবে। পুরোটা শোধ না হওয়া পর্যন্ত এই নোটিশ প্রতিদিন একবার দেখাবে।")
                    .font(.caption).foregroundStyle(.secondary)
                // The web's "বুঝেছি" ack — POST /api/payroll/wallet/advance-notice.
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    Task { await vm.ackAdvanceNotice() }
                } label: {
                    HStack(spacing: 6) {
                        if vm.busyActions.contains("ack") { ProgressView().controlSize(.mini) }
                        Text(vm.busyActions.contains("ack") ? "অপেক্ষা করুন…" : "বুঝেছি")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(PortalPalette.amber600)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .background(PortalPalette.amber500.opacity(0.16), in: Capsule())
                    .overlay(Capsule().strokeBorder(PortalPalette.amber500.opacity(0.45), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(vm.busyActions.contains("ack"))
                .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(PortalPalette.amber500.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(PortalPalette.amber500.opacity(0.40), lineWidth: 1))
    }

    // ── Today attendance + monthly summary (web AttendanceCard read slice) ──

    private var attendanceCard: some View {
        let today = vm.attendance?.today
        let summary = vm.attendance?.summary
        let linked = vm.employeeId != nil && vm.attendance?.needsEmployeeLink != true
        return VStack(alignment: .leading, spacing: 10) {
            Text("TODAY ATTENDANCE")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(PortalPalette.accentText(colorScheme))
            Text(today != nil
                 ? (today?.checkOutAt != nil ? "Workday completed" : "Work is running")
                 : "Ready to start work")
                .font(.subheadline.weight(.bold))
            Text("Office time: 9:00 AM - 9:00 PM. Late penalties sync to your wallet automatically.")
                .font(.caption2).foregroundStyle(.secondary)

            if !linked {
                Text("Ask an admin to link your HR employee ID before using attendance.")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(PortalPalette.amber600)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        statTile("Check in", PortalFormat.time(today?.checkInAt) ?? "—")
                        statTile("Check out", PortalFormat.time(today?.checkOutAt) ?? "—")
                        statTile("Worked", PortalFormat.minutes(today?.totalWorkMinutes ?? 0))
                        statTile("Late", PortalFormat.minutes(today?.lateMinutes ?? 0),
                                 tone: (today?.lateMinutes ?? 0) > 0 ? PortalPalette.red500 : PortalPalette.green400)
                        statTile("Penalty", PortalFormat.money(today?.penaltyAmount ?? 0),
                                 tone: (today?.penaltyAmount ?? 0) > 0 ? PortalPalette.red500 : PortalPalette.green400)
                    }
                    .padding(.vertical, 1)
                }
                if let s = summary {
                    HStack(spacing: 8) {
                        statTile("Month present", "\(s.presentDays) days")
                        statTile("Month late", "\(s.lateCount) days", tone: PortalPalette.amber600)
                        statTile("Total penalties", PortalFormat.money(s.totalPenalties), tone: PortalPalette.red500)
                        statTile("Waived", PortalFormat.money(s.waivedPenalties), tone: PortalPalette.green400)
                    }
                }
                // Web PenaltyAppealStatus — shown when today carries a penalty.
                if let today, (today.penaltyAmount ?? 0) > 0 {
                    penaltyAppealBlock(today)
                }
            }

            // Native check-in / check-out (owner 2026-07-11): front-camera selfie +
            // one-shot GPS, exact web payload. Small web fallback link stays below.
            if today == nil {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    showCheckIn = true
                } label: {
                    Label("📸 চেক-ইন করুন (সেলফি + GPS)", systemImage: "camera.viewfinder")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(PortalPalette.emerald600,
                                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                }
                .buttonStyle(.plain)
                .sheet(isPresented: $showCheckIn) { PortalCheckInSheet(vm: vm) }
            } else if today?.checkOutAt == nil {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    confirmCheckOut = true
                } label: {
                    Label("চেক-আউট করুন", systemImage: "figure.walk")
                        .font(.caption.weight(.bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
                .confirmationDialog("আজকের কাজ শেষ করে চেক-আউট করবেন?",
                                    isPresented: $confirmCheckOut, titleVisibility: .visible) {
                    Button("হ্যাঁ, চেক-আউট") {
                        Task {
                            attendanceError = await vm.checkOut()
                            if attendanceError == nil {
                                UINotificationFeedbackGenerator().notificationOccurred(.success)
                            }
                        }
                    }
                    Button("বাতিল", role: .cancel) {}
                }
            }
            if let attendanceError {
                Text(attendanceError).font(.caption2.weight(.semibold))
                    .foregroundStyle(PortalPalette.red500)
            }
            portalLinkButton("ওয়েব ভার্সন") {
                openWeb("/portal", "My Desk")
            }

            // Web "Attendance exception" block — native form (plain text, no camera).
            if linked, today != nil, today?.checkOutAt == nil {
                exceptionBlock
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    /// Web exception banner verbatim: APPROVED / PENDING states, else the ask-button.
    private var exceptionBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            if vm.exceptionStatus == "APPROVED" {
                Text("✅ আজকের জন্য মালিক অনুমতি দিয়েছেন — নিয়ম মওকুফ, এখন স্বাভাবিকভাবে চেক-আউট করতে পারবেন।")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(PortalPalette.emerald600)
            } else if vm.exceptionStatus == "PENDING" {
                Text("⏳ আপনার অনুমতির অনুরোধ মালিকের অনুমোদনের অপেক্ষায় আছে।")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(PortalPalette.amber600)
            } else {
                Text("আগে বের হতে / মাঠের কাজ / দেরিতে আসা?")
                    .font(.caption.weight(.bold))
                Text("নিয়ম (সময়, লোকেশন, কাজ, জরিমানা) মওকুফ চাইলে মালিকের কাছে অনুমতি চান। অনুমোদন পেলে আজকের জন্য নিয়ম প্রযোজ্য হবে না।")
                    .font(.caption2).foregroundStyle(.secondary)
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    exceptionSheet = true
                } label: {
                    HStack(spacing: 6) {
                        if vm.busyActions.contains("exception") { ProgressView().controlSize(.mini) }
                        Text(vm.busyActions.contains("exception") ? "পাঠানো হচ্ছে..." : "🙏 অনুমতি চাও")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(PortalPalette.amber600)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .background(PortalPalette.amber500.opacity(0.16), in: Capsule())
                    .overlay(Capsule().strokeBorder(PortalPalette.amber500.opacity(0.45), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(vm.busyActions.contains("exception"))
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(PortalPalette.amber500.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(PortalPalette.amber500.opacity(0.40), lineWidth: 1))
    }

    // ── Penalty appeal (web PenaltyAppealStatus — status + request/cancel) ──

    private func penaltyAppealBlock(_ today: PortalAttendanceToday) -> some View {
        let waivers = today.waiverRequests
        let active = waivers.first(where: { $0.status == "PENDING" }) ?? waivers.first
        let canRequest = !waivers.contains(where: { $0.status == "PENDING" })
        return VStack(alignment: .leading, spacing: 6) {
            Text("LATE PENALTY")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(PortalPalette.red500)
            Text(PortalFormat.money(today.penaltyAmount ?? 0))
                .font(.subheadline.monospaced().weight(.black))
            Text("Late by \(today.lateMinutes ?? 0) minutes · deducted from wallet")
                .font(.caption2).foregroundStyle(.secondary)

            if let active {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Review \(active.statusText)"
                         + (active.requestType.map { " · \($0.replacingOccurrences(of: "_", with: " ").lowercased())" } ?? ""))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(PortalPalette.requestStatus(active.effectiveStatus == "FULLY_APPROVED" || active.effectiveStatus == "PARTIALLY_APPROVED" ? "APPROVED" : active.effectiveStatus))
                    if active.status == "PENDING" {
                        Text("Waiting for admin review. You asked to reduce \(PortalFormat.money(active.requestedReductionAmount ?? active.originalPenaltyAmount ?? 0)).")
                            .font(.caption2).foregroundStyle(.secondary)
                    } else if active.status == "APPROVED" || active.status == "PARTIALLY_APPROVED" {
                        Text("Approved reduction \(PortalFormat.money(active.approvedReductionAmount ?? 0)) · final penalty \(PortalFormat.money(active.finalAppliedPenalty ?? 0))")
                            .font(.caption2).foregroundStyle(.secondary)
                    } else if active.status == "REJECTED" {
                        Text("Request rejected — full penalty remains.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if let note = active.adminNote, !note.isEmpty {
                        Text("Admin: \(note)").font(.caption2).foregroundStyle(.secondary)
                    }
                    if active.status == "PENDING" {
                        Button {
                            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                            cancelWaiverId = active.id
                            confirmCancelWaiver = true
                        } label: {
                            HStack(spacing: 6) {
                                if vm.busyActions.contains("cancelWaiver") { ProgressView().controlSize(.mini) }
                                Text(vm.busyActions.contains("cancelWaiver") ? "Cancelling…" : "রিকোয়েস্ট বাতিল করুন")
                                    .font(.caption.weight(.bold))
                            }
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 12).padding(.vertical, 5)
                            .background(Color.primary.opacity(0.06), in: Capsule())
                            .overlay(Capsule().strokeBorder(Color.primary.opacity(0.15), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .disabled(vm.busyActions.contains("cancelWaiver"))
                        .padding(.top, 2)
                    }
                }
                .padding(8)
                .background(Color.white.opacity(colorScheme == .dark ? 0.05 : 0.35),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            }

            if canRequest, today.id != nil {
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    appealSheet = true
                } label: {
                    HStack(spacing: 6) {
                        if vm.busyActions.contains("appeal") { ProgressView().controlSize(.mini) }
                        Text(vm.busyActions.contains("appeal") ? "পাঠানো হচ্ছে..." : "রিভিউ চান")
                            .font(.caption.weight(.bold))
                    }
                    .foregroundStyle(PortalPalette.accentText(colorScheme))
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .background(PortalPalette.coral.opacity(0.13), in: Capsule())
                    .overlay(Capsule().strokeBorder(PortalPalette.coral.opacity(0.35), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(vm.busyActions.contains("appeal"))
                .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(PortalPalette.red500.opacity(0.06), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(PortalPalette.red500.opacity(0.25), lineWidth: 1))
        .confirmationDialog("রিভিউ অনুরোধ বাতিল করবেন?",
                            isPresented: $confirmCancelWaiver, titleVisibility: .visible) {
            Button("হ্যাঁ, বাতিল করুন", role: .destructive) {
                if let id = cancelWaiverId {
                    Task { await vm.cancelPenaltyAppeal(waiverId: id) }
                }
                cancelWaiverId = nil
            }
            Button("না", role: .cancel) { cancelWaiverId = nil }
        }
    }

    // ── Entry link cards (web "Payout identity" / "নিজ খরচ ফেরত" / office fund) ──

    private func entryLinkCard(_ heading: String, _ desc: String,
                               _ buttonLabel: String, path: String, title: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(heading)
                .font(.caption2.weight(.heavy))
                .foregroundStyle(PortalPalette.accentText(colorScheme))
            Text(desc).font(.caption2).foregroundStyle(.secondary)
            portalLinkButton(buttonLabel) { openWeb(path, title) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var payoutIdentityCard: some View {
        entryLinkCard("PAYOUT IDENTITY",
                      "bKash, Nagad, Rocket, or bank — used when wallet requests are approved.",
                      "Payment accounts",
                      path: "/portal/payment-accounts", title: "Payment accounts")
    }

    private var expenseRefundCard: some View {
        entryLinkCard("নিজ খরচ ফেরত",
                      "নিজের পকেট থেকে অফিসের খরচ করেছেন? ফেরতের আবেদন করুন — মালিক অনুমোদন করলে ওয়ালেটে যোগ হবে।",
                      "খরচ ফেরত চান",
                      path: "/portal/expense", title: "Portal expense")
    }

    /// Web OfficeAdvanceDeskCard (admin office-fund advances desk) — the ledger
    /// itself lives on /finance/office-fund; the desk card links there.
    private var officeFundCard: some View {
        entryLinkCard("অফিস অ্যাডভান্স — হিসাব বাকি",
                      "অফিসের কাজে নেওয়া টাকার হিসাব দিন — কত খরচ হয়েছে আর কত ফেরত, তা জানান।",
                      "হিসাব দিন",
                      path: "/finance/office-fund", title: "Office fund")
    }

    /// Web MySalarySlipCard builds the PDF client-side — that stays a web escape.
    private var salarySlipCard: some View {
        entryLinkCard("MY SALARY SLIP",
                      "মাসিক বেতন স্লিপ — হিসাবসহ PDF ডাউনলোড।",
                      "স্যালারি স্লিপ (PDF) — ওয়েবে খুলুন",
                      path: "/portal", title: "My Desk")
    }

    // ── Meal allowance (web MealAllowanceCard — status + self-request) ──

    private var mealAllowanceCard: some View {
        let e = vm.mealEligibility
        let amount = e?.amountBdt ?? 0
        let pendingStatus = e?.pendingStatus
        let displayAmount = e?.pendingAmount ?? amount
        let canRequest = e?.canRequestToday == true
        let reasonTrimmed = mealReason.trimmingCharacters(in: .whitespacesAndNewlines)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("MEAL ALLOWANCE")
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(PortalPalette.accentText(colorScheme))
                    Text(canRequest
                         ? "No kitchen today? Request your meal allowance."
                         : pendingStatus == "APPROVED"
                             ? "Meal allowance approved for today"
                             : "Request pending approval")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Text(pendingStatus == "PENDING" ? "PENDING \(PortalFormat.money(displayAmount))"
                     : pendingStatus == "APPROVED" ? "APPROVED \(PortalFormat.money(displayAmount))"
                     : PortalFormat.money(amount))
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(PortalPalette.goldLt)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(PortalPalette.coral.opacity(0.12), in: Capsule())
                    .overlay(Capsule().strokeBorder(PortalPalette.goldDim.opacity(0.4), lineWidth: 1))
            }
            if canRequest {
                if vm.employeeId == nil {
                    Text("Ask an admin to link your HR employee ID before requesting meal allowance.")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(PortalPalette.amber600)
                } else {
                    TextField("e.g. No food arranged today", text: $mealReason, axis: .vertical)
                        .lineLimit(2...3)
                        .padding(10)
                        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                    Button {
                        confirmMeal = true
                    } label: {
                        HStack(spacing: 6) {
                            if vm.busyActions.contains("meal") { ProgressView().controlSize(.mini) }
                            Text(vm.busyActions.contains("meal") ? "Submitting…" : "Request \(PortalFormat.money(amount)) allowance")
                                .font(.footnote.weight(.semibold))
                        }
                        .foregroundStyle(PortalPalette.accentText(colorScheme))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(PortalPalette.coral.opacity(0.13), in: Capsule())
                        .overlay(Capsule().strokeBorder(PortalPalette.coral.opacity(0.35), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.busyActions.contains("meal") || reasonTrimmed.isEmpty)
                    .confirmationDialog("খাবার ভাতা \(PortalFormat.money(amount)) রিকোয়েস্ট পাঠাবেন?",
                                        isPresented: $confirmMeal, titleVisibility: .visible) {
                        Button("রিকোয়েস্ট পাঠান") {
                            let r = reasonTrimmed
                            mealReason = ""
                            Task { await vm.submitMealRequest(reason: r) }
                        }
                        Button("বাতিল", role: .cancel) {}
                    }
                    if reasonTrimmed.isEmpty {
                        Text("Please add a short reason")
                            .font(.caption2).foregroundStyle(PortalPalette.amber600)
                    }
                }
            } else if let r = e?.reason, !r.isEmpty {
                Text(r).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Driving mode (web DrivingModeCard — start/end with session state) ──

    private var drivingModeCard: some View {
        let st = vm.drivingStatus
        let active = st?.hasActiveSession == true
        let pending = st?.hasPendingSession == true
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("🚗 DRIVING MODE")
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(PortalPalette.accentText(colorScheme))
                    Text(active
                         ? "You are on the road — office follow-ups are paused."
                         : pending
                             ? "Driving mode request pending approval."
                             : "Going on the road? Start driving mode so the office pauses your follow-ups.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Text(active ? "DRIVING" : pending ? "PENDING" : "OFF")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(active ? PortalPalette.green400
                                     : pending ? PortalPalette.amber600 : .secondary)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(PortalPalette.coral.opacity(0.12), in: Capsule())
                    .overlay(Capsule().strokeBorder(PortalPalette.goldDim.opacity(0.4), lineWidth: 1))
            }
            if active {
                Button {
                    confirmDrivingEnd = true
                } label: {
                    HStack(spacing: 6) {
                        if vm.busyActions.contains("driving") { ProgressView().controlSize(.mini) }
                        Text(vm.busyActions.contains("driving") ? "Ending…" : "End driving — back to work")
                            .font(.footnote.weight(.semibold))
                    }
                    .foregroundStyle(PortalPalette.accentText(colorScheme))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(PortalPalette.coral.opacity(0.13), in: Capsule())
                    .overlay(Capsule().strokeBorder(PortalPalette.coral.opacity(0.35), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(vm.busyActions.contains("driving"))
                .confirmationDialog("ড্রাইভিং মোড শেষ করবেন? অফিস ফলো-আপ আবার চালু হবে।",
                                    isPresented: $confirmDrivingEnd, titleVisibility: .visible) {
                    Button("হ্যাঁ, শেষ করুন") {
                        Task { await vm.endDrivingMode() }
                    }
                    Button("বাতিল", role: .cancel) {}
                }
            } else if pending {
                Text(st?.reason?.isEmpty == false ? (st?.reason ?? "") : "Waiting for the owner to approve.")
                    .font(.caption2).foregroundStyle(.secondary)
            } else if st?.canStart == true {
                if vm.employeeId == nil {
                    Text("Ask an admin to link your HR employee ID first.")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(PortalPalette.amber600)
                } else {
                    TextField("e.g. Going for delivery / pickup (optional)", text: $drivingReason, axis: .vertical)
                        .lineLimit(2...3)
                        .padding(10)
                        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                    Button {
                        confirmDrivingStart = true
                    } label: {
                        HStack(spacing: 6) {
                            if vm.busyActions.contains("driving") { ProgressView().controlSize(.mini) }
                            Text(vm.busyActions.contains("driving") ? "Submitting…" : "Start driving mode")
                                .font(.footnote.weight(.semibold))
                        }
                        .foregroundStyle(PortalPalette.accentText(colorScheme))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(PortalPalette.coral.opacity(0.13), in: Capsule())
                        .overlay(Capsule().strokeBorder(PortalPalette.coral.opacity(0.35), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.busyActions.contains("driving"))
                    .confirmationDialog("ড্রাইভিং মোড শুরুর অনুরোধ মালিকের কাছে পাঠাবেন?",
                                        isPresented: $confirmDrivingStart, titleVisibility: .visible) {
                        Button("অনুরোধ পাঠান") {
                            let r = drivingReason.trimmingCharacters(in: .whitespacesAndNewlines)
                            drivingReason = ""
                            Task { await vm.startDrivingMode(reason: r) }
                        }
                        Button("বাতিল", role: .cancel) {}
                    }
                }
            } else if let r = st?.reason, !r.isEmpty {
                Text(r).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func statTile(_ label: String, _ value: String, tone: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
            Text(value).font(.caption.monospaced().weight(.bold)).foregroundStyle(tone)
        }
        .frame(minWidth: 64, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color.white.opacity(colorScheme == .dark ? 0.05 : 0.35),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.08 : 0.4), lineWidth: 1))
    }

    // ── Employee wallet (web WalletOverviewCard — same stats, same tones) ──

    private var walletCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("EMPLOYEE WALLET")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(PortalPalette.accentText(colorScheme))
            if let s = vm.walletSummary {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Current balance").font(.caption2).foregroundStyle(.secondary)
                    Text(PortalFormat.money(s.currentBalance))
                        .font(.title2.monospaced().weight(.black))
                        .foregroundStyle(PortalPalette.green400)
                    Text("তুলতে পারবেন সর্বোচ্চ \(PortalFormat.money(s.availableWithdrawable))")
                        .font(.caption2).foregroundStyle(PortalPalette.goldLt)
                }
                if s.outstandingAdvance > 0 {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("বকেয়া অগ্রিম · পরের বেতন থেকে কাটা হবে")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(PortalPalette.amber600)
                        Text(PortalFormat.money(s.outstandingAdvance))
                            .font(.subheadline.monospaced().weight(.black))
                            .foregroundStyle(PortalPalette.amber600)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(PortalPalette.amber500.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                        .strokeBorder(PortalPalette.amber500.opacity(0.40), lineWidth: 1))
                }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    walletStat("Salary earned", s.totalAccrued)
                    walletStat("Commission", s.totalCommissions, tone: PortalPalette.green400)
                    walletStat("Eid bonus", s.totalEidBonuses)
                    walletStat("Overtime", s.totalOvertime)
                    walletStat("Penalties", s.totalPenalties, tone: PortalPalette.red500)
                    walletStat("Meal deductions", s.totalMealDeductions, tone: PortalPalette.red500)
                    walletStat("Advances", s.totalAdvances, tone: PortalPalette.amber600)
                    walletStat("Withdrawals", s.totalWithdrawals, tone: .secondary)
                }
            } else if vm.employeeId == nil {
                Text("Link your HR employee ID to view salary balance.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("Wallet not active").font(.caption).foregroundStyle(.secondary)
            }
            // Native wallet request form (the web WalletRequestCard, as a sheet).
            if vm.employeeId != nil {
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    walletSheet = true
                } label: {
                    HStack(spacing: 6) {
                        if vm.busyActions.contains("wallet") { ProgressView().controlSize(.mini) }
                        Text(vm.busyActions.contains("wallet") ? "Sending…" : "টাকা তোলা / অগ্রিম রিকোয়েস্ট")
                            .font(.footnote.weight(.semibold))
                    }
                    .foregroundStyle(PortalPalette.accentText(colorScheme))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(PortalPalette.coral.opacity(0.13), in: Capsule())
                    .overlay(Capsule().strokeBorder(PortalPalette.coral.opacity(0.35), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(vm.busyActions.contains("wallet"))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    /// Light bento pass (owner spec 2026-07-08): each wallet stat carries a soft
    /// diagonal wash of its own tone — same numbers, same tints, presentation only.
    private func walletStat(_ label: String, _ value: Int, tone: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
            Text(PortalFormat.money(value)).font(.caption.monospaced().weight(.bold)).foregroundStyle(tone)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .fill(Color.white.opacity(colorScheme == .dark ? 0.05 : 0.35))
                LinearGradient(colors: [tone.opacity(colorScheme == .dark ? 0.12 : 0.08), .clear],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.08 : 0.4), lineWidth: 1))
    }

    // ── My tasks (operational-task assignments, priority status circles) ──

    private var tasksCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("আমার কাজ")
                    .font(.caption2.weight(.heavy))
                    .foregroundStyle(PortalPalette.accentText(colorScheme))
                Spacer()
                Text("\(vm.tasks.count)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(PortalPalette.accentText(colorScheme))
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(PortalPalette.coral.opacity(0.14), in: Capsule())
            }
            ForEach(vm.tasks) { t in
                HStack(alignment: .top, spacing: 10) {
                    Circle()
                        .fill(PortalPalette.priority(t.priority).opacity(0.18))
                        .frame(width: 14, height: 14)
                        .overlay(Circle().strokeBorder(PortalPalette.priority(t.priority), lineWidth: 2))
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(t.title).font(.footnote.weight(.semibold))
                        if let d = t.details, !d.isEmpty {
                            Text(d).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                        HStack(spacing: 6) {
                            if let by = t.assignedByName, !by.isEmpty {
                                Text(by).font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                            }
                            if let dl = PortalFormat.dateTime(t.deadline) {
                                Text("⏰ \(dl)")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(PortalPalette.amber600)
                            }
                            if let st = t.status, !st.isEmpty {
                                Text(st.replacingOccurrences(of: "_", with: " "))
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 5).padding(.vertical, 1.5)
                                    .background(Color.primary.opacity(0.06), in: Capsule())
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 2)
            }
            // Acknowledge / complete flows run through the web task hero.
            portalLinkButton("কাজ আপডেট করুন — ওয়েবে") {
                openWeb("/portal", "My Desk")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Leave applications (web "ছুটির আবেদন" block — read list + escape) ──

    private var leaveCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ছুটির আবেদন")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(PortalPalette.accentText(colorScheme))
            Text("পুরো দিন, কয়েকদিন, কয়েক ঘণ্টা, বা দেরিতে শুরু — মালিক অনুমোদন করলে ঐ সময়ে কোনো জরিমানা হবে না।")
                .font(.caption2).foregroundStyle(.secondary)
            if vm.leaves.isEmpty {
                Text("কোনো ছুটির আবেদন নেই").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(vm.leaves.prefix(5)) { lv in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(leaveLine(lv)).font(.caption2)
                        Spacer()
                        Text(lv.statusLabel)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(PortalPalette.requestStatus(lv.status))
                    }
                    .padding(.horizontal, 8).padding(.vertical, 5)
                    .background(Color.white.opacity(colorScheme == .dark ? 0.05 : 0.35),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                }
            }
            // Native leave-apply form (the web requestLeave, as a sheet).
            if vm.employeeId != nil {
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    leaveSheet = true
                } label: {
                    HStack(spacing: 6) {
                        if vm.busyActions.contains("leave") { ProgressView().controlSize(.mini) }
                        Text(vm.busyActions.contains("leave") ? "পাঠানো হচ্ছে..." : "🏖️ ছুটি চাও")
                            .font(.footnote.weight(.semibold))
                    }
                    .foregroundStyle(PortalPalette.accentText(colorScheme))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(PortalPalette.coral.opacity(0.13), in: Capsule())
                    .overlay(Capsule().strokeBorder(PortalPalette.coral.opacity(0.35), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(vm.busyActions.contains("leave"))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    /// Web leave row: dates · kind label · clock suffix for HOURS / SHIFTED_START.
    private func leaveLine(_ lv: PortalLeave) -> String {
        let start = String((lv.startDate ?? "—").prefix(10))
        let end = String((lv.endDate ?? lv.startDate ?? "—").prefix(10))
        var line = start
        if end != start { line += " – \(end)" }
        line += " · \(lv.kindLabel)"
        if lv.kind == "HOURS", let s = lv.startMinutes, let e = lv.endMinutes {
            line += " (\(PortalFormat.clock(s))–\(PortalFormat.clock(e)))"
        } else if lv.kind == "SHIFTED_START", let s = lv.startMinutes {
            line += " (\(PortalFormat.clock(s)) থেকে)"
        }
        return line
    }

    // ── Wallet transaction history (web card — same Bangla source labels) ──

    private var walletHistoryCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("WALLET TRANSACTION HISTORY")
                    .font(.caption2.weight(.heavy))
                    .foregroundStyle(PortalPalette.accentText(colorScheme))
                Spacer()
                if vm.employeeId != nil {
                    Button {
                        statementOpen = true
                    } label: {
                        Text("সম্পূর্ণ হিসাব →")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(PortalPalette.coral)
                    }
                }
            }
            if vm.employeeId == nil {
                Text("Link your HR employee ID (Users settings) to activate the payroll wallet.")
                    .font(.caption).foregroundStyle(.secondary)
            } else if vm.walletEntries.isEmpty {
                Text("No wallet entries yet. HR can run monthly salary accruals from Payroll.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                // Web shows newest first: entries.slice().reverse().
                ForEach(Array(vm.walletEntries.reversed().prefix(15))) { tx in
                    HStack(spacing: 8) {
                        Text(String((tx.date ?? "—").prefix(10)))
                            .font(.system(size: 10).monospaced())
                            .foregroundStyle(.secondary)
                        Text(tx.label).font(.caption2).lineLimit(1)
                        Spacer()
                        Text("\(tx.signedAmount >= 0 ? "+" : "-")\(PortalFormat.money(abs(tx.signedAmount)))")
                            .font(.system(size: 10, weight: .bold).monospaced())
                            .foregroundStyle(tx.signedAmount >= 0 ? PortalPalette.green400 : PortalPalette.red500)
                        Text(PortalFormat.money(tx.runningBalance))
                            .font(.system(size: 10).monospaced())
                            .foregroundStyle(PortalPalette.goldLt)
                    }
                    .padding(.vertical, 3)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Pending wallet requests (web RequestList parity) ──

    private var pendingRequestsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("PENDING REQUESTS")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(PortalPalette.accentText(colorScheme))
            if vm.walletRequests.isEmpty {
                Text("No wallet requests yet.").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(Array(vm.walletRequests.prefix(20))) { r in
                    HStack(spacing: 8) {
                        Text(String((r.createdAt ?? "—").prefix(10)))
                            .font(.system(size: 10).monospaced())
                            .foregroundStyle(.secondary)
                        Text("\(r.type.replacingOccurrences(of: "_", with: " ")) · \(PortalFormat.money(r.requestedAmount))")
                            .font(.caption2)
                        Spacer()
                        Text(r.status.replacingOccurrences(of: "_", with: " "))
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(PortalPalette.requestStatus(r.status))
                    }
                    .padding(.vertical, 3)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Shared bits ──

    private func portalLinkButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            action()
        } label: {
            HStack(spacing: 6) {
                Text(label).font(.footnote.weight(.semibold))
                Image(systemName: "arrow.up.right").font(.caption2.weight(.bold))
            }
            .foregroundStyle(PortalPalette.accentText(colorScheme))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(PortalPalette.coral.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(PortalPalette.coral.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, success }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", PortalPalette.red500)
        case .success: ("checkmark.circle", PortalPalette.emerald600)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 120)
                .portalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .portalShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/portal", "My Desk")
        } label: {
            Text("ওয়েব ভার্সন")
                .font(.caption2)
                .underline()
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Wallet request sheet (web WalletRequestCard parity)

@available(iOS 17.0, *)
private struct PortalWalletRequestSheet: View {
    let availableWithdrawable: Int
    let onSubmit: (_ type: String, _ amount: Int, _ reason: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var type = "WITHDRAWAL"
    @State private var amount = ""
    @State private var reason = ""
    @State private var confirmSend = false

    private var amountValue: Int { Int(amount.trimmingCharacters(in: .whitespaces)) ?? 0 }
    private var reasonTrimmed: String { reason.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var overCap: Bool { type == "WITHDRAWAL" && amountValue > availableWithdrawable }
    private var valid: Bool { amountValue > 0 && !reasonTrimmed.isEmpty && !overCap }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Wallet requests").font(.headline)
                HStack(spacing: 8) {
                    typeChip("Request withdrawal", "WITHDRAWAL")
                    typeChip("Request advance", "ADVANCE")
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("AMOUNT (৳)").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                    TextField("0", text: $amount)
                        .keyboardType(.numberPad)
                        .font(.body.monospaced())
                        .padding(12)
                        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                    if type == "WITHDRAWAL" {
                        // Web cap hint / over-cap error — Bangla verbatim.
                        Text(overCap
                             ? "আপনার ওয়ালেটে আছে \(PortalFormat.money(availableWithdrawable)) — এর বেশি টাকা তোলা যাবে না। বেশি দরকার হলে আগে অগ্রিম (advance) রিকোয়েস্ট পাঠান।"
                             : "তুলতে পারবেন সর্বোচ্চ \(PortalFormat.money(availableWithdrawable))")
                            .font(.caption2)
                            .foregroundStyle(overCap ? PortalPalette.red500 : .secondary)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("REASON").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                    TextField("কারণ লিখুন", text: $reason, axis: .vertical)
                        .lineLimit(3...5)
                        .padding(12)
                        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                    if amountValue <= 0 || reasonTrimmed.isEmpty {
                        Text("Amount and reason required")
                            .font(.caption2).foregroundStyle(PortalPalette.amber600)
                    }
                }
                Button {
                    confirmSend = true
                } label: {
                    Text("Submit request")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(PortalPalette.coral)
                .disabled(!valid)
                .confirmationDialog(
                    type == "WITHDRAWAL"
                        ? "\(PortalFormat.money(amountValue)) তোলার রিকোয়েস্ট পাঠাবেন?"
                        : "\(PortalFormat.money(amountValue)) অগ্রিমের রিকোয়েস্ট পাঠাবেন?",
                    isPresented: $confirmSend, titleVisibility: .visible
                ) {
                    Button("রিকোয়েস্ট পাঠান") {
                        dismiss()
                        onSubmit(type, amountValue, reasonTrimmed)
                    }
                    Button("বাতিল", role: .cancel) {}
                }
                Spacer(minLength: 0)
            }
            .padding(18)
        }
        .presentationBackground { PortalAurora() }
    }

    private func typeChip(_ label: String, _ value: String) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            type = value
        } label: {
            Text(label)
                .font(.caption.weight(type == value ? .bold : .semibold))
                .foregroundStyle(type == value ? PortalPalette.accentText(colorScheme) : .secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .background(type == value ? PortalPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                          : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    type == value ? PortalPalette.coral.opacity(0.55)
                                  : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Leave application sheet (web requestLeave form parity)

@available(iOS 17.0, *)
private struct PortalLeaveSheet: View {
    let onSubmit: (_ kind: String, _ startDate: String, _ endDate: String,
                   _ startMinutes: Int?, _ endMinutes: Int?, _ reason: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var kind = "FULL_DAY"
    @State private var startDate = Date()
    @State private var endDate = Date()
    @State private var startTime = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var endTime = Calendar.current.date(bySettingHour: 12, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var reason = ""
    @State private var confirmSend = false

    /// Web <select> options verbatim.
    private static let kinds: [(String, String)] = [
        ("FULL_DAY", "একদিনের ছুটি"),
        ("DATE_RANGE", "কয়েকদিনের ছুটি"),
        ("HOURS", "কয়েক ঘণ্টার ছুটি"),
        ("SHIFTED_START", "দেরিতে শুরু"),
    ]

    private var reasonTrimmed: String { reason.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var needsTimes: Bool { kind == "HOURS" || kind == "SHIFTED_START" }
    private var startMinutes: Int? { needsTimes ? Self.minutes(of: startTime) : nil }
    private var endMinutes: Int? { kind == "HOURS" ? Self.minutes(of: endTime) : nil }
    private var timesInvalid: Bool {
        guard kind == "HOURS", let s = startMinutes, let e = endMinutes else { return false }
        return e <= s
    }
    private var valid: Bool { reasonTrimmed.count >= 3 && !timesInvalid }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("ছুটির আবেদন").font(.headline)
                Text("পুরো দিন, কয়েকদিন, কয়েক ঘণ্টা, বা দেরিতে শুরু — মালিক অনুমোদন করলে ঐ সময়ে কোনো জরিমানা হবে না।")
                    .font(.caption).foregroundStyle(.secondary)

                // Kind — the web select as one-tap rows.
                VStack(spacing: 6) {
                    ForEach(Self.kinds, id: \.0) { value, label in
                        Button {
                            UISelectionFeedbackGenerator().selectionChanged()
                            kind = value
                        } label: {
                            HStack {
                                Image(systemName: kind == value ? "largecircle.fill.circle" : "circle")
                                    .font(.footnote)
                                    .foregroundStyle(kind == value ? PortalPalette.coral : .secondary)
                                Text(label).font(.footnote.weight(kind == value ? .bold : .regular))
                                Spacer()
                            }
                            .padding(.horizontal, 12).padding(.vertical, 9)
                            .portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                        }
                        .buttonStyle(.plain)
                    }
                }

                DatePicker("শুরুর তারিখ", selection: $startDate, displayedComponents: .date)
                    .font(.footnote)
                if kind == "DATE_RANGE" {
                    DatePicker("শেষ তারিখ", selection: $endDate, in: startDate..., displayedComponents: .date)
                        .font(.footnote)
                }
                if needsTimes {
                    DatePicker(kind == "SHIFTED_START" ? "কখন শুরু করবেন" : "ছুটি শুরু",
                               selection: $startTime, displayedComponents: .hourAndMinute)
                        .font(.footnote)
                    if kind == "HOURS" {
                        DatePicker("ছুটি শেষ", selection: $endTime, displayedComponents: .hourAndMinute)
                            .font(.footnote)
                        if timesInvalid {
                            Text("ছুটির শুরু ও শেষ সময় ঠিকভাবে দিন।")
                                .font(.caption2).foregroundStyle(PortalPalette.red500)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 4) {
                    TextField("ছুটির কারণ লিখুন", text: $reason, axis: .vertical)
                        .lineLimit(2...4)
                        .padding(12)
                        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                    if reasonTrimmed.count < 3 {
                        Text("ছুটির কারণ লিখুন (অন্তত ৩ অক্ষর)।")
                            .font(.caption2).foregroundStyle(PortalPalette.amber600)
                    }
                }

                Button {
                    confirmSend = true
                } label: {
                    Text("আবেদন পাঠান")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(PortalPalette.coral)
                .disabled(!valid)
                .confirmationDialog("ছুটির আবেদন মালিকের কাছে পাঠাবেন?",
                                    isPresented: $confirmSend, titleVisibility: .visible) {
                    Button("আবেদন পাঠান") {
                        let start = Self.ymd(startDate)
                        // Web: end_date = DATE_RANGE ? (end || start) : start.
                        let end = kind == "DATE_RANGE" ? Self.ymd(max(endDate, startDate)) : start
                        dismiss()
                        onSubmit(kind, start, end, startMinutes, endMinutes, reasonTrimmed)
                    }
                    Button("বাতিল", role: .cancel) {}
                }
                Spacer(minLength: 0)
            }
            .padding(18)
        }
        .presentationBackground { PortalAurora() }
    }

    private static func minutes(of date: Date) -> Int {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    /// Web <input type="date"> value shape — local "yyyy-MM-dd".
    private static func ymd(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: date)
    }
}

// MARK: - Checkout-exception sheet (web requestException form parity)

@available(iOS 17.0, *)
private struct PortalExceptionSheet: View {
    let onSubmit: (_ scope: String, _ reason: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var scope = "EARLY_CHECKOUT"
    @State private var reason = ""
    @State private var confirmSend = false

    /// Web radio options verbatim.
    private static let scopes: [(String, String)] = [
        ("EARLY_CHECKOUT", "🚶 আগে বের হবো / মাঠের কাজ"),
        ("LATE_ARRIVAL", "⏰ দেরিতে এসেছি / আসবো"),
        ("FULL_DAY", "📅 সারাদিন সব নিয়ম মওকুফ"),
    ]

    private var reasonTrimmed: String { reason.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool { reasonTrimmed.count >= 3 }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("আগে বের হতে / মাঠের কাজ / দেরিতে আসা?").font(.headline)
                Text("নিয়ম (সময়, লোকেশন, কাজ, জরিমানা) মওকুফ চাইলে মালিকের কাছে অনুমতি চান। অনুমোদন পেলে আজকের জন্য নিয়ম প্রযোজ্য হবে না।")
                    .font(.caption).foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 6) {
                    Text("উদ্দেশ্য বেছে নিন:").font(.caption.weight(.semibold))
                    ForEach(Self.scopes, id: \.0) { value, label in
                        Button {
                            UISelectionFeedbackGenerator().selectionChanged()
                            scope = value
                        } label: {
                            HStack {
                                Image(systemName: scope == value ? "largecircle.fill.circle" : "circle")
                                    .font(.footnote)
                                    .foregroundStyle(scope == value ? PortalPalette.coral : .secondary)
                                Text(label).font(.footnote.weight(scope == value ? .bold : .regular))
                                Spacer()
                            }
                            .padding(.horizontal, 12).padding(.vertical, 9)
                            .portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                        }
                        .buttonStyle(.plain)
                    }
                    if scope == "LATE_ARRIVAL" {
                        Text("নোট: দেরিতে আসার অনুমতি দিয়ে আগে বের হওয়া যাবে না — সেজন্য আলাদা অনুমতি লাগবে।")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }

                VStack(alignment: .leading, spacing: 4) {
                    TextField("কারণ লিখুন (যেমন: মাঠে ডেলিভারিতে যাচ্ছি / জরুরি কাজ)", text: $reason, axis: .vertical)
                        .lineLimit(3...5)
                        .padding(12)
                        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                    if !valid {
                        Text("সংক্ষেপে কারণ লিখুন (অন্তত ৩ অক্ষর)।")
                            .font(.caption2).foregroundStyle(PortalPalette.amber600)
                    }
                }

                Button {
                    confirmSend = true
                } label: {
                    Text("অনুমতি পাঠান")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(PortalPalette.coral)
                .disabled(!valid)
                .confirmationDialog("অনুমতির অনুরোধ মালিকের কাছে পাঠাবেন?",
                                    isPresented: $confirmSend, titleVisibility: .visible) {
                    Button("অনুমতি পাঠান") {
                        dismiss()
                        onSubmit(scope, reasonTrimmed)
                    }
                    Button("বাতিল", role: .cancel) {}
                }
                Spacer(minLength: 0)
            }
            .padding(18)
        }
        .presentationBackground { PortalAurora() }
    }
}

// MARK: - Penalty appeal sheet (web PenaltyAppealModal parity — attachment stays web)

@available(iOS 17.0, *)
private struct PortalAppealSheet: View {
    let penaltyAmount: Int
    let lateMinutes: Int
    let attendanceDate: String?
    let onSubmit: (_ requestType: String, _ reason: String, _ partialAmount: Int?) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var requestType = "FULL_WAIVE"
    @State private var reason = ""
    @State private var partialAmount = ""
    @State private var confirmSend = false

    /// Web REQUEST_TYPES verbatim (label + hint).
    private static let types: [(String, String, String)] = [
        ("FULL_WAIVE", "Full waive", "Remove the entire penalty"),
        ("PARTIAL_REDUCE", "Partial reduction", "Ask to reduce part of the amount"),
        ("RECONSIDERATION", "Reconsideration", "Explain circumstances for review"),
    ]

    private var reasonTrimmed: String { reason.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var partialValue: Int { Int(partialAmount.trimmingCharacters(in: .whitespaces)) ?? 0 }
    private var partialInvalid: Bool {
        requestType == "PARTIAL_REDUCE" && (partialValue <= 0 || partialValue > penaltyAmount)
    }
    private var valid: Bool { reasonTrimmed.count >= 3 && !partialInvalid }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Penalty appeal").font(.headline)
                Text("Late \(lateMinutes)m · penalty \(PortalFormat.money(penaltyAmount))"
                     + (attendanceDate.map { " · \(String($0.prefix(10)))" } ?? ""))
                    .font(.caption).foregroundStyle(.secondary)

                // Request type — the web radio cards as one-tap rows.
                VStack(spacing: 6) {
                    ForEach(Self.types, id: \.0) { value, label, hint in
                        Button {
                            UISelectionFeedbackGenerator().selectionChanged()
                            requestType = value
                        } label: {
                            HStack(alignment: .top) {
                                Image(systemName: requestType == value ? "largecircle.fill.circle" : "circle")
                                    .font(.footnote)
                                    .foregroundStyle(requestType == value ? PortalPalette.coral : .secondary)
                                    .padding(.top, 1)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(label).font(.footnote.weight(requestType == value ? .bold : .regular))
                                    Text(hint).font(.caption2).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 12).padding(.vertical, 9)
                            .portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                        }
                        .buttonStyle(.plain)
                    }
                }

                if requestType == "PARTIAL_REDUCE" {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("AMOUNT TO REDUCE (MAX \(PortalFormat.money(penaltyAmount)))")
                            .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                        TextField("\(penaltyAmount / 2)", text: $partialAmount)
                            .keyboardType(.numberPad)
                            .font(.body.monospaced())
                            .padding(12)
                            .portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                        if partialInvalid {
                            Text("১ থেকে \(PortalFormat.money(penaltyAmount)) এর মধ্যে দিন।")
                                .font(.caption2).foregroundStyle(PortalPalette.red500)
                        }
                    }
                }

                VStack(alignment: .leading, spacing: 4) {
                    TextField("কেন রিভিউ চান, সংক্ষেপে লিখুন", text: $reason, axis: .vertical)
                        .lineLimit(3...5)
                        .padding(12)
                        .portalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                    if reasonTrimmed.count < 3 {
                        Text("কারণ লিখুন (অন্তত ৩ অক্ষর)।")
                            .font(.caption2).foregroundStyle(PortalPalette.amber600)
                    }
                }

                // Proof-photo attach is a web-only extra (file picker + data URL).
                Text("ছবি/প্রমাণ যোগ করতে চাইলে ওয়েব ভার্সনে আবেদন করুন।")
                    .font(.caption2).foregroundStyle(.secondary)

                Button {
                    confirmSend = true
                } label: {
                    Text("রিভিউ আবেদন পাঠান")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(PortalPalette.coral)
                .disabled(!valid)
                .confirmationDialog("জরিমানা রিভিউয়ের আবেদন মালিকের কাছে পাঠাবেন?",
                                    isPresented: $confirmSend, titleVisibility: .visible) {
                    Button("আবেদন পাঠান") {
                        dismiss()
                        onSubmit(requestType, reasonTrimmed,
                                 requestType == "PARTIAL_REDUCE" ? partialValue : nil)
                    }
                    Button("বাতিল", role: .cancel) {}
                }
                Spacer(minLength: 0)
            }
            .padding(18)
        }
        .presentationBackground { PortalAurora() }
    }
}

// MARK: - Formatting helpers (web util parity)

private enum PortalFormat {
    /// Web money(): "৳ 12,345".
    static func money(_ n: Int) -> String {
        "৳ \(n.formatted(.number.grouping(.automatic)))"
    }

    /// ISO timestamp → "9:05 AM" in Asia/Dhaka (web formatAttendanceTime).
    static func time(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    /// ISO timestamp → short date+time in Asia/Dhaka (task deadlines).
    static func dateTime(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    /// Web minutesText: 125 → "2h 5m", 40 → "40m".
    static func minutes(_ total: Int) -> String {
        let h = total / 60, m = total % 60
        return h == 0 ? "\(m)m" : "\(h)h \(m)m"
    }

    /// Minutes-since-midnight → "2:00 PM" (web minutesToClock).
    static func clock(_ minutes: Int) -> String {
        let h = minutes / 60, mm = minutes % 60
        let ap = h >= 12 ? "PM" : "AM"
        let h12 = ((h + 11) % 12) + 1
        return "\(h12):\(String(format: "%02d", mm)) \(ap)"
    }

    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }

    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }
}

// MARK: - Aurora background + glass (Portal-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
/// Shared living-aurora canvas (internal: WalletStatementSwiftUI reuses it —
/// owner directive 2026-07-08, every native page shares the moving aurora).
struct PortalAurora: View {
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
    func portalGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct PortalShimmer: ViewModifier {
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
    func portalShimmer() -> some View { modifier(PortalShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Portal — Light") {
    PortalScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}

// MARK: - Native check-in / check-out (owner 2026-07-11 — the LAST web-only flow on
// My Desk goes native: front-camera selfie + one-shot GPS + the exact web payload.
// FaceVerificationCheckIn.tsx parity: POST /api/attendance/check-in with
// { business_id, request_id, metadata, face_verification }; check-out posts
// { business_id, metadata }. Server enforces the geofence + dedupe.)

import AVFoundation
import CoreLocation

/// One-shot CLLocation fetch — the web acquireAttendanceLocation() twin.
@available(iOS 17.0, *)
final class PortalGpsOnce: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<(location: CLLocation?, reason: String), Never>? = nil

    func acquire() async -> (location: CLLocation?, reason: String) {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
        let status = manager.authorizationStatus
        if status == .denied || status == .restricted {
            return (nil, "denied")
        }
        return await withCheckedContinuation { cont in
            continuation = cont
            if status == .notDetermined {
                manager.requestWhenInUseAuthorization()
            } else {
                manager.requestLocation()
            }
            // Watchdog: never hang the check-in on a silent GPS stack.
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in
                self?.finish(nil, "timeout")
            }
        }
    }

    private func finish(_ loc: CLLocation?, _ reason: String) {
        continuation?.resume(returning: (loc, reason))
        continuation = nil
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: manager.requestLocation()
        case .denied, .restricted: finish(nil, "denied")
        default: break
        }
    }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        finish(locations.first, locations.first == nil ? "unavailable" : "ok")
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(nil, "error")
    }
}

@available(iOS 17.0, *)
extension PortalVM {
    struct AttendanceLocation: Encodable {
        let latitude: Double, longitude: Double, accuracy: Double
    }
    struct AttendanceMetadata: Encodable {
        let browserFingerprint: String
        let sessionId: String
        let timezone: String
        let language: String
        let platform: String
        let screen: String
        let location: AttendanceLocation?
        let locationReason: String
    }
    private struct CheckInBody: Encodable {
        let business_id: String
        let request_id: String
        let metadata: AttendanceMetadata
        let face_verification: Face
        struct Face: Encodable { let image_data_url: String, thumb_data_url: String }
    }
    private struct CheckOutBody: Encodable {
        let business_id: String
        let metadata: AttendanceMetadata?
    }
    private struct AttendanceWriteResponse: Decodable { let ok: Bool?, error: String? }

    /// Stable per-device session id — the web stores the twin in localStorage.
    static var attendanceSessionId: String {
        let key = "alma-attendance-session-id"
        if let existing = UserDefaults.standard.string(forKey: key) { return existing }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    static func metadata(location: CLLocation?, reason: String) -> AttendanceMetadata {
        let device = UIDevice.current
        let screenPx = UIScreen.main.nativeBounds
        let fingerprint = [
            "alma-ios-native", device.model, device.systemName, device.systemVersion,
            Locale.current.identifier,
        ].joined(separator: "|")
        return AttendanceMetadata(
            browserFingerprint: fingerprint,
            sessionId: attendanceSessionId,
            timezone: TimeZone.current.identifier,
            language: Locale.preferredLanguages.first ?? "bn",
            platform: "iOS \(device.systemVersion)",
            screen: "\(Int(screenPx.width))x\(Int(screenPx.height))",
            location: location.map {
                AttendanceLocation(latitude: $0.coordinate.latitude,
                                   longitude: $0.coordinate.longitude,
                                   accuracy: $0.horizontalAccuracy)
            },
            locationReason: reason)
    }

    /// Native check-in — selfie required, GPS required (web blocks without it too).
    func checkIn(selfie: UIImage) async -> String? {
        let gps = await PortalGpsOnce().acquire()
        guard let loc = gps.location else {
            return "লোকেশন পাওয়া যায়নি (\(gps.reason)) — GPS চালু করে আবার চেষ্টা করুন"
        }
        // Web captureProfileFromFile shrinks the frame; mirror ~900px + small thumb.
        func dataUrl(_ image: UIImage, maxSide: CGFloat, quality: CGFloat) -> String? {
            let scale = min(1, maxSide / max(image.size.width, image.size.height))
            let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)
            let shrunk = UIGraphicsImageRenderer(size: target).image { _ in
                image.draw(in: CGRect(origin: .zero, size: target))
            }
            guard let jpeg = shrunk.jpegData(compressionQuality: quality) else { return nil }
            return "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
        }
        guard let imageUrl = dataUrl(selfie, maxSide: 900, quality: 0.75),
              let thumbUrl = dataUrl(selfie, maxSide: 200, quality: 0.6) else {
            return "ছবিটা প্রসেস করা যায়নি — আবার তুলুন"
        }
        do {
            let res: AttendanceWriteResponse = try await AlmaAPI.shared.send(
                "POST", "/api/attendance/check-in",
                body: CheckInBody(
                    business_id: Self.businessId,
                    request_id: UUID().uuidString,
                    metadata: Self.metadata(location: loc, reason: "ok"),
                    face_verification: .init(image_data_url: imageUrl, thumb_data_url: thumbUrl)))
            if let err = res.error { return err }
            await load()
            return nil
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return "সেশন শেষ — আবার লগইন করুন"
        } catch {
            return error.localizedDescription
        }
    }

    /// Native check-out — GPS best-effort (web falls back to nil metadata).
    func checkOut() async -> String? {
        let gps = await PortalGpsOnce().acquire()
        do {
            let res: AttendanceWriteResponse = try await AlmaAPI.shared.send(
                "POST", "/api/attendance/check-out",
                body: CheckOutBody(
                    business_id: Self.businessId,
                    metadata: Self.metadata(location: gps.location,
                                            reason: gps.location == nil ? gps.reason : "ok")))
            if let err = res.error { return err }
            await load()
            return nil
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return "সেশন শেষ — আবার লগইন করুন"
        } catch {
            return error.localizedDescription
        }
    }
}

/// Front-camera selfie capture (UIImagePickerController — PhotosPicker can't shoot).
@available(iOS 17.0, *)
struct PortalSelfieCamera: UIViewControllerRepresentable {
    static var available: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
    let onCapture: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let vc = UIImagePickerController()
        vc.sourceType = .camera
        if UIImagePickerController.isCameraDeviceAvailable(.front) {
            vc.cameraDevice = .front
        }
        vc.delegate = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onCapture: onCapture) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (UIImage?) -> Void
        init(onCapture: @escaping (UIImage?) -> Void) { self.onCapture = onCapture }
        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onCapture(info[.originalImage] as? UIImage)
            picker.dismiss(animated: true)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCapture(nil)
            picker.dismiss(animated: true)
        }
    }
}

/// The native check-in sheet: capture preview → GPS note → submit with per-step state.
@available(iOS 17.0, *)
struct PortalCheckInSheet: View {
    let vm: PortalVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var showCamera = false
    @State private var selfie: UIImage? = nil
    @State private var submitting = false
    @State private var errorText: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("📸 চেক-ইন").font(.subheadline.weight(.bold)).padding(.top, 20)
            Text("সামনের ক্যামেরায় সেলফি + GPS — অফিস geofence সার্ভারে যাচাই হয়।")
                .font(.caption2).foregroundStyle(.secondary)

            Button {
                showCamera = true
            } label: {
                Group {
                    if let selfie {
                        Image(uiImage: selfie)
                            .resizable().scaledToFill()
                            .frame(height: 240)
                            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "camera.viewfinder").font(.title)
                            Text(PortalSelfieCamera.available
                                 ? "সেলফি তুলুন" : "এই ডিভাইসে ক্যামেরা নেই")
                                .font(.caption.weight(.semibold))
                        }
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 60)
                        .background(Color.primary.opacity(0.05),
                                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(!PortalSelfieCamera.available)

            if let errorText {
                Text(errorText).font(.caption2.weight(.semibold))
                    .foregroundStyle(PortalPalette.red500)
            }

            Button {
                submit()
            } label: {
                HStack(spacing: 8) {
                    if submitting { ProgressView().tint(.white) }
                    Text(submitting ? "চেক-ইন হচ্ছে…" : "চেক-ইন করুন")
                        .font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(selfie != nil && !submitting
                            ? PortalPalette.emerald600 : PortalPalette.emerald600.opacity(0.4),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(selfie == nil || submitting)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .presentationDetents([.height(460)])
        .presentationDragIndicator(.visible)
        .background(AlmaSwiftTheme.rootBg(scheme))
        .fullScreenCover(isPresented: $showCamera) {
            PortalSelfieCamera { image in
                if let image { selfie = image }
                showCamera = false
            }
            .ignoresSafeArea()
        }
    }

    private func submit() {
        guard let selfie, !submitting else { return }
        submitting = true; errorText = nil
        Task {
            defer { submitting = false }
            if let err = await vm.checkIn(selfie: selfie) {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                errorText = err
            } else {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                dismiss()
            }
        }
    }
}
