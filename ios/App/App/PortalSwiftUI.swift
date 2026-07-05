//
//  PortalSwiftUI.swift
//  ALMA ERP — the staff "My desk" (/portal) as a native SwiftUI screen.
//
//  Mirrors the web /portal page's read blocks — same endpoints, same colours:
//    GET /api/users/me?business_id=…                     → profile (name/role/shift/HR id)
//    GET /api/attendance?business_id=…&scope=me          → today + monthly summary
//    GET /api/payroll/wallet/{empId}?business_id=…       → wallet summary + ledger + requests
//    GET /api/operational-tasks/my?business_id=…         → my active tasks
//    GET /api/attendance/leave?business_id=…             → my leave applications
//  iOS re-set: personal dashboard cards — greeting, my balance, my tasks with
//  status circles, attendance summary. Mutating staff actions (check-in/check-out
//  selfie+GPS, wallet requests, leave/exception forms, meal allowance, driving
//  mode) stay on the web escape hatch — openWeb("/portal", "My Desk").
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
    let checkInAt: String?
    let checkOutAt: String?
    let totalWorkMinutes: Int?
    let lateMinutes: Int?
    let penaltyAmount: Int?

    private enum Keys: String, CodingKey {
        case checkInAt, checkOutAt, totalWorkMinutes, lateMinutes, penaltyAmount
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        checkInAt = try? c.decodeIfPresent(String.self, forKey: .checkInAt)
        checkOutAt = try? c.decodeIfPresent(String.self, forKey: .checkOutAt)
        totalWorkMinutes = portalFlexInt(c, .totalWorkMinutes)
        lateMinutes = portalFlexInt(c, .lateMinutes)
        penaltyAmount = portalFlexInt(c, .penaltyAmount)
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
    var loading = false
    var error: String? = nil
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

        // The four staff blocks load concurrently; each is tolerant of its own failure.
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

        attendance = await attendanceResp
        if let w = await walletResp {
            walletSummary = w.summary
            walletEntries = w.entries
            walletRequests = w.requests
            advanceNoticeAckedToday = w.advanceNoticeAckedToday == true
        }
        tasks = (await tasksResp)?.tasks ?? []
        leaves = (await leavesResp)?.leaves ?? []
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
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err) }
                if vm.loading && vm.profile == nil && !vm.authExpired { loadingRows }
                if let profile = vm.profile {
                    greetingCard(profile)
                    if vm.isSystemOwner {
                        ownerCard
                    } else {
                        if let s = vm.walletSummary, s.outstandingAdvance > 0, !vm.advanceNoticeAckedToday {
                            advanceNotice(s.outstandingAdvance)
                        }
                        attendanceCard
                        walletCard
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
        .portalGlass(colorScheme, corner: 16)
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
        .portalGlass(colorScheme, corner: 16)
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
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(PortalPalette.amber500.opacity(0.10), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16)
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
            }

            // Check-in / check-out involve the selfie camera + GPS geofence — that
            // whole flow lives in the web view (web escape by design).
            portalLinkButton(
                today == nil ? "📸 চেক-ইন করুন — ওয়েবে (সেলফি + GPS)"
                             : (today?.checkOutAt == nil ? "চেক-আউট / অনুমতি — ওয়েবে খুলুন"
                                                         : "বিস্তারিত — ওয়েবে খুলুন")) {
                openWeb("/portal", "My Desk")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: 16)
    }

    private func statTile(_ label: String, _ value: String, tone: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
            Text(value).font(.caption.monospaced().weight(.bold)).foregroundStyle(tone)
        }
        .frame(minWidth: 64, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color.white.opacity(colorScheme == .dark ? 0.05 : 0.35),
                    in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
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
                    .background(PortalPalette.amber500.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12)
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
            // Withdrawal / advance forms post money movements — web escape.
            portalLinkButton("টাকা তোলা / অগ্রিম রিকোয়েস্ট — ওয়েবে") {
                openWeb("/portal", "My Desk")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: 16)
    }

    private func walletStat(_ label: String, _ value: Int, tone: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
            Text(PortalFormat.money(value)).font(.caption.monospaced().weight(.bold)).foregroundStyle(tone)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Color.white.opacity(colorScheme == .dark ? 0.05 : 0.35),
                    in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12)
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
        .portalGlass(colorScheme, corner: 16)
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
                                in: RoundedRectangle(cornerRadius: 8))
                }
            }
            portalLinkButton("🏖️ ছুটি চাও — ওয়েবে আবেদন করুন") {
                openWeb("/portal", "My Desk")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .portalGlass(colorScheme, corner: 16)
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
            Text("WALLET TRANSACTION HISTORY")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(PortalPalette.accentText(colorScheme))
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
        .portalGlass(colorScheme, corner: 16)
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
        .portalGlass(colorScheme, corner: 16)
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

    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(PortalPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).portalGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .portalGlass(colorScheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 120)
                .portalGlass(colorScheme, corner: 16)
                .portalShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/portal", "My Desk")
        } label: {
            Label("সব অপশন (চেক-ইন, রিকোয়েস্ট, ছুটি) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
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
private struct PortalAurora: View {
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
    func portalGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
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
