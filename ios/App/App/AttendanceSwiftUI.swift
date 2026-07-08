//
//  AttendanceSwiftUI.swift
//  ALMA ERP — the Attendance dashboard as a native SwiftUI screen.
//
//  Mirrors the web /attendance page — same endpoints, same colours, FULL action parity:
//    GET    /api/attendance?business_id=ALL&date=YYYY-MM-DD    → dashboard bundle
//           (kpis · records · absentEmployees · pendingWaivers · selfieLogs · ranking)
//    GET    /api/attendance/waivers/analytics                  → appeal analytics card
//    PATCH  /api/attendance/waivers/{id}                       → appeal APPROVE/REJECT
//           {business_id, action, approved_reduction_amount?, admin_note}
//    POST   /api/attendance/{recordId}/verification-request    {business_id}
//    DELETE /api/attendance/{recordId}                         → attendance reset (SA)
//    PATCH  /api/attendance/selfies/{id}                       → selfie verdict
//           {business_id, action, attendance_record_id}
//  Native extras: chevron prev/next day + graphical DatePicker sheet (the API's
//  `date` param drives the whole dashboard), status-dot initials rows, per-employee
//  detail sheet with the day's timeline. Selfie IMAGES render natively (signed URL via
//  AsyncImage, data: URLs decoded); TAKING selfies stays on the web (camera flow).
//  Carried lessons: ONE per-section skeleton, never a global overlay; lenient decoding;
//  per-row spinners (busyIds), never a global one; confirmationDialogs in Bangla with
//  the staff name before every mutating call; reload after every action.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum AttendancePalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Web trust pills: TRUSTED tone-green · WARNING tone-amber · else tone-red.
    static func trust(_ s: String?) -> Color {
        switch s {
        case "TRUSTED": return emerald600
        case "WARNING": return amber600
        default: return red500
        }
    }

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Lenient int helper (shared by every model in this file)

private func attendanceFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) ?? Double(s).map { Int($0.rounded()) } }
    return nil
}

// MARK: - Models (same field names the web AttendanceDashboard type declares)

struct AttendanceKpis: Decodable, Equatable {
    let employeeCount: Int
    let todayAttendance: Int
    let absentEmployees: Int
    let lateEmployees: Int
    let todayPenaltyTotal: Int
    let monthPenaltyTotal: Int
    let attendanceRate: Int
    let pendingWaivers: Int
    let suspiciousAttendance: Int
    let pendingVerifications: Int

    private enum Keys: String, CodingKey {
        case employeeCount, todayAttendance, absentEmployees, lateEmployees
        case todayPenaltyTotal, monthPenaltyTotal, attendanceRate
        case pendingWaivers, suspiciousAttendance, pendingVerifications
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        employeeCount = attendanceFlexInt(c, .employeeCount) ?? 0
        todayAttendance = attendanceFlexInt(c, .todayAttendance) ?? 0
        absentEmployees = attendanceFlexInt(c, .absentEmployees) ?? 0
        lateEmployees = attendanceFlexInt(c, .lateEmployees) ?? 0
        todayPenaltyTotal = attendanceFlexInt(c, .todayPenaltyTotal) ?? 0
        monthPenaltyTotal = attendanceFlexInt(c, .monthPenaltyTotal) ?? 0
        attendanceRate = attendanceFlexInt(c, .attendanceRate) ?? 0
        pendingWaivers = attendanceFlexInt(c, .pendingWaivers) ?? 0
        suspiciousAttendance = attendanceFlexInt(c, .suspiciousAttendance) ?? 0
        pendingVerifications = attendanceFlexInt(c, .pendingVerifications) ?? 0
    }
}

struct AttendanceRecordRow: Decodable, Identifiable, Equatable {
    let id: String
    let businessId: String?
    let userId: String?
    let employeeId: String?
    let employeeName: String?
    let checkInAt: String?
    let checkOutAt: String?
    let totalWorkMinutes: Int?
    let lateMinutes: Int?
    let penaltyAmount: Int?
    let trustStatus: String?
    let suspiciousReasons: [String]
    let verificationRequired: Bool?
    let selfieCount: Int?

    private enum Keys: String, CodingKey {
        case id, businessId, userId, employeeId, employeeName, checkInAt, checkOutAt
        case totalWorkMinutes, lateMinutes, penaltyAmount, trustStatus
        case suspiciousReasons, verificationRequired, selfieCount
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
        userId = try? c.decodeIfPresent(String.self, forKey: .userId)
        employeeId = try? c.decodeIfPresent(String.self, forKey: .employeeId)
        employeeName = try? c.decodeIfPresent(String.self, forKey: .employeeName)
        checkInAt = try? c.decodeIfPresent(String.self, forKey: .checkInAt)
        checkOutAt = try? c.decodeIfPresent(String.self, forKey: .checkOutAt)
        totalWorkMinutes = attendanceFlexInt(c, .totalWorkMinutes)
        lateMinutes = attendanceFlexInt(c, .lateMinutes)
        penaltyAmount = attendanceFlexInt(c, .penaltyAmount)
        trustStatus = try? c.decodeIfPresent(String.self, forKey: .trustStatus)
        suspiciousReasons = (try? c.decodeIfPresent([String].self, forKey: .suspiciousReasons)) ?? []
        verificationRequired = try? c.decodeIfPresent(Bool.self, forKey: .verificationRequired)
        selfieCount = attendanceFlexInt(c, .selfieCount)
    }

    var isLate: Bool { (lateMinutes ?? 0) > 0 }
    var isCheckedOut: Bool { !(checkOutAt ?? "").isEmpty }
}

struct AttendanceAbsentee: Decodable, Identifiable, Equatable {
    let id: String
    let employeeId: String?
    let name: String?
    let email: String?

    private enum Keys: String, CodingKey { case id, employeeId, name, email }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        employeeId = try? c.decodeIfPresent(String.self, forKey: .employeeId)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        email = try? c.decodeIfPresent(String.self, forKey: .email)
    }
}

struct AttendanceWaiverRow: Decodable, Identifiable, Equatable {
    let id: String
    let businessId: String?
    let employeeId: String?
    let requesterName: String?
    let requestType: String?
    let originalPenaltyAmount: Int?
    let requestedReductionAmount: Int?
    let reason: String?
    let hasAttachment: Bool?
    let createdAt: String?
    let lateMinutes: Int?

    private enum Keys: String, CodingKey {
        case id, businessId, employeeId, requesterName, requestType, originalPenaltyAmount
        case requestedReductionAmount, reason, hasAttachment, createdAt, lateMinutes
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
        employeeId = try? c.decodeIfPresent(String.self, forKey: .employeeId)
        requesterName = try? c.decodeIfPresent(String.self, forKey: .requesterName)
        requestType = try? c.decodeIfPresent(String.self, forKey: .requestType)
        originalPenaltyAmount = attendanceFlexInt(c, .originalPenaltyAmount)
        requestedReductionAmount = attendanceFlexInt(c, .requestedReductionAmount)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        hasAttachment = try? c.decodeIfPresent(Bool.self, forKey: .hasAttachment)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        lateMinutes = attendanceFlexInt(c, .lateMinutes)
    }
}

/// One selfie verification photo (web selfieLogs) — `imageUrl` is a 1h-signed storage
/// URL resolved server-side; legacy rows may inline a `data:image/…` payload instead.
struct AttendanceSelfieLog: Decodable, Identifiable, Equatable {
    let id: String
    let businessId: String?
    let attendanceRecordId: String?
    let employeeId: String?
    let capturedAt: String?
    let imageDataUrl: String?
    let imageUrl: String?
    let imageMissing: Bool?
    let reviewedAt: String?

    private enum Keys: String, CodingKey {
        case id, businessId, attendanceRecordId, employeeId, capturedAt
        case imageDataUrl, imageUrl, imageMissing, reviewedAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
        attendanceRecordId = try? c.decodeIfPresent(String.self, forKey: .attendanceRecordId)
        employeeId = try? c.decodeIfPresent(String.self, forKey: .employeeId)
        capturedAt = try? c.decodeIfPresent(String.self, forKey: .capturedAt)
        imageDataUrl = try? c.decodeIfPresent(String.self, forKey: .imageDataUrl)
        imageUrl = try? c.decodeIfPresent(String.self, forKey: .imageUrl)
        imageMissing = try? c.decodeIfPresent(Bool.self, forKey: .imageMissing)
        reviewedAt = try? c.decodeIfPresent(String.self, forKey: .reviewedAt)
    }

    var isPending: Bool { (reviewedAt ?? "").isEmpty }
    /// Same precedence the web uses: signed URL first, else inline data URL.
    var displaySrc: String? {
        if let u = imageUrl, !u.isEmpty { return u }
        if let d = imageDataUrl, d.hasPrefix("data:image/") { return d }
        return nil
    }
}

/// Web "Penalty appeal analytics (this month)" — GET /api/attendance/waivers/analytics
/// answers `{ ok, month, analytics: {…} }` flat (no data wrapper).
struct AttendancePenaltyAnalytics: Decodable, Equatable {
    let totalPenalties: Int
    let waivedAmount: Int
    let netPenaltiesAfterWaivers: Int
    let approvalRate: Int

    private enum Keys: String, CodingKey {
        case ok, analytics, totalPenalties, waivedAmount, netPenaltiesAfterWaivers, approvalRate
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .analytics)) ?? root
        totalPenalties = attendanceFlexInt(c, .totalPenalties) ?? 0
        waivedAmount = attendanceFlexInt(c, .waivedAmount) ?? 0
        netPenaltiesAfterWaivers = attendanceFlexInt(c, .netPenaltiesAfterWaivers) ?? 0
        approvalRate = attendanceFlexInt(c, .approvalRate) ?? 0
    }
}

/// Minimal decode target for the mutating endpoints — payload details are refetched
/// via load() right after, so only success/failure matters here.
struct AttendanceActionOk: Decodable {
    let ok: Bool?
}

struct AttendanceRankRow: Decodable, Identifiable, Equatable {
    let employeeId: String?
    let name: String?
    let presentDays: Int?
    let lateCount: Int?
    let penaltyTotal: Int?
    let averageWorkLabel: String?
    let punctualityScore: Int?

    var id: String { "\(employeeId ?? "?")-\(name ?? "?")" }

    private enum Keys: String, CodingKey {
        case employeeId, name, presentDays, lateCount, penaltyTotal
        case averageWorkLabel, punctualityScore
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        employeeId = try? c.decodeIfPresent(String.self, forKey: .employeeId)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        presentDays = attendanceFlexInt(c, .presentDays)
        lateCount = attendanceFlexInt(c, .lateCount)
        penaltyTotal = attendanceFlexInt(c, .penaltyTotal)
        averageWorkLabel = try? c.decodeIfPresent(String.self, forKey: .averageWorkLabel)
        punctualityScore = attendanceFlexInt(c, .punctualityScore)
    }
}

/// The attendance route wraps payloads via apiDataSuccess → `{ ok, data: {…} }`
/// (same wrapper the approvals routes use) — decode both wrapped and flat shapes.
struct AttendanceDashboardResponse: Decodable {
    let kpis: AttendanceKpis?
    let records: [AttendanceRecordRow]
    let absentEmployees: [AttendanceAbsentee]
    let pendingWaivers: [AttendanceWaiverRow]
    let selfieLogs: [AttendanceSelfieLog]
    let ranking: [AttendanceRankRow]
    let scopeAllBusinesses: Bool

    private enum Keys: String, CodingKey {
        case ok, data, kpis, records, absentEmployees, pendingWaivers, selfieLogs, ranking, scopeAllBusinesses
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        kpis = try? c.decodeIfPresent(AttendanceKpis.self, forKey: .kpis)
        records = (try? c.decode([AttendanceRecordRow].self, forKey: .records)) ?? []
        absentEmployees = (try? c.decode([AttendanceAbsentee].self, forKey: .absentEmployees)) ?? []
        pendingWaivers = (try? c.decode([AttendanceWaiverRow].self, forKey: .pendingWaivers)) ?? []
        selfieLogs = (try? c.decode([AttendanceSelfieLog].self, forKey: .selfieLogs)) ?? []
        ranking = (try? c.decode([AttendanceRankRow].self, forKey: .ranking)) ?? []
        scopeAllBusinesses = (try? c.decodeIfPresent(Bool.self, forKey: .scopeAllBusinesses)) ?? false
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class AttendanceVM {
    var kpis: AttendanceKpis? = nil
    var records: [AttendanceRecordRow] = []
    var absentees: [AttendanceAbsentee] = []
    var waivers: [AttendanceWaiverRow] = []
    var selfieLogs: [AttendanceSelfieLog] = []
    var ranking: [AttendanceRankRow] = []
    var analytics: AttendancePenaltyAnalytics? = nil
    var scopeAllBusinesses = false
    var loading = false
    var error: String? = nil
    var notice: String? = nil             // success line (the web's toast)
    var busyIds: Set<String> = []         // per-row spinners, never a global one
    var authExpired = false

    /// Selected day (Dhaka business day) — drives the `date` query param.
    var day: Date = Date()

    var isToday: Bool {
        AttendanceFormat.dayParam(day) == AttendanceFormat.dayParam(Date())
    }

    var pendingSelfies: [AttendanceSelfieLog] { selfieLogs.filter(\.isPending) }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: AttendanceDashboardResponse = try await AlmaAPI.shared.get(
                "/api/attendance",
                query: ["business_id": "ALL", "date": AttendanceFormat.dayParam(day)])
            kpis = resp.kpis
            records = resp.records
            absentees = resp.absentEmployees
            waivers = resp.pendingWaivers
            selfieLogs = resp.selfieLogs
            ranking = resp.ranking
            scopeAllBusinesses = resp.scopeAllBusinesses
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
        }
    }

    /// Web loadAnalytics() parity — best-effort, silent on failure (the web passes
    /// toastOnError:false too). Scoped to the primary business like the web call.
    func loadAnalytics() async {
        do {
            let resp: AttendancePenaltyAnalytics = try await AlmaAPI.shared.get(
                "/api/attendance/waivers/analytics")
            analytics = resp
        } catch {
            analytics = nil
        }
    }

    // ── Admin actions (exact web endpoints/bodies; per-row spinner via busyIds) ──

    /// Web submitReview(): PATCH /api/attendance/waivers/{id}
    /// {business_id, action, approved_reduction_amount (APPROVE only), admin_note}.
    func reviewWaiver(_ waiver: AttendanceWaiverRow, approve: Bool,
                      amount: Int, note: String) async {
        guard !busyIds.contains(waiver.id) else { return }
        busyIds.insert(waiver.id)
        notice = nil
        error = nil
        defer { busyIds.remove(waiver.id) }
        do {
            var body: [String: AnyEncodable] = [
                "action": AnyEncodable(approve ? "APPROVE" : "REJECT"),
                "admin_note": AnyEncodable(note),
            ]
            // The web sends the page's business context; natively we know the waiver's
            // own business (in the ALL-scope payload) — strictly more correct.
            if let biz = waiver.businessId { body["business_id"] = AnyEncodable(biz) }
            if approve { body["approved_reduction_amount"] = AnyEncodable(amount) }
            let _: AttendanceActionOk = try await AlmaAPI.shared.send(
                "PATCH", "/api/attendance/waivers/\(waiver.id)", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = approve
                ? "আপিল অনুমোদিত — ওয়ালেটে ক্রেডিট হয়েছে ✓"
                : "আপিল প্রত্যাখ্যান করা হয়েছে"
            withAnimation(.snappy) { waivers.removeAll { $0.id == waiver.id } }
            await load()
            await loadAnalytics()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = Self.actionMessage(error)
        }
    }

    /// Web requestVerification(): POST /api/attendance/{recordId}/verification-request
    /// {business_id} — flags the record; staff sees "Verify Face Now" on My Desk.
    func requestVerification(_ record: AttendanceRecordRow) async {
        guard !busyIds.contains(record.id) else { return }
        busyIds.insert(record.id)
        notice = nil
        error = nil
        defer { busyIds.remove(record.id) }
        do {
            var body: [String: AnyEncodable] = [:]
            if let biz = record.businessId { body["business_id"] = AnyEncodable(biz) }
            let _: AttendanceActionOk = try await AlmaAPI.shared.send(
                "POST", "/api/attendance/\(record.id)/verification-request", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "ভেরিফিকেশন চাওয়া হয়েছে — কর্মী My Desk-এ 'Verify Face Now' দেখবে"
            await load()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = Self.actionMessage(error)
        }
    }

    /// Web resetAttendance(): DELETE /api/attendance/{recordId} (no body) — removes
    /// the day's record + reverses any late penalty; Super Admin only (server-gated).
    func resetAttendance(_ record: AttendanceRecordRow) async {
        guard !busyIds.contains(record.id) else { return }
        busyIds.insert(record.id)
        notice = nil
        error = nil
        defer { busyIds.remove(record.id) }
        do {
            let _: AttendanceActionOk = try await AlmaAPI.shared.send(
                "DELETE", "/api/attendance/\(record.id)")
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "হাজিরা রিসেট হয়েছে — কর্মী আবার চেক-ইন করতে পারবে"
            withAnimation(.snappy) { records.removeAll { $0.id == record.id } }
            await load()
            await loadAnalytics()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = Self.actionMessage(error)
        }
    }

    /// Web reviewSelfie(): PATCH /api/attendance/selfies/{id}
    /// {business_id, action, attendance_record_id} — APPROVE → TRUSTED, REJECT → WARNING.
    func reviewSelfie(_ log: AttendanceSelfieLog, approve: Bool) async {
        guard !busyIds.contains(log.id) else { return }
        busyIds.insert(log.id)
        notice = nil
        error = nil
        defer { busyIds.remove(log.id) }
        do {
            var body: [String: AnyEncodable] = [
                "action": AnyEncodable(approve ? "APPROVE" : "REJECT"),
            ]
            if let biz = log.businessId { body["business_id"] = AnyEncodable(biz) }
            if let rec = log.attendanceRecordId { body["attendance_record_id"] = AnyEncodable(rec) }
            let _: AttendanceActionOk = try await AlmaAPI.shared.send(
                "PATCH", "/api/attendance/selfies/\(log.id)", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = approve ? "ভেরিফিকেশন অনুমোদিত ✓" : "ভেরিফিকেশন প্রত্যাখ্যান করা হয়েছে"
            await load()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = Self.actionMessage(error)
        }
    }

    /// Prefer the server's own message (the web toasts it verbatim); fall back to a
    /// Bangla line for bare 403s and generic failures.
    static func actionMessage(_ error: Error) -> String {
        if case AlmaAPIError.http(let status, let body) = error {
            if let data = body.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let msg = obj["error"] as? String, !msg.isEmpty { return msg }
                if let err = obj["error"] as? [String: Any],
                   let msg = err["message"] as? String, !msg.isEmpty { return msg }
                if let msg = obj["message"] as? String, !msg.isEmpty { return msg }
            }
            if status == 403 { return "অনুমতি নেই — শুধু Admin/Super Admin এই কাজ করতে পারে।" }
            return "সার্ভার সমস্যা (\(status)) — আবার চেষ্টা করুন।"
        }
        return (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
    }

    /// Move the selected day by ±1 (Dhaka calendar); never past today.
    func shiftDay(_ delta: Int) {
        guard let next = AttendanceFormat.dhakaCalendar.date(byAdding: .day, value: delta, to: day)
        else { return }
        if AttendanceFormat.dayParam(next) > AttendanceFormat.dayParam(Date()) { return }
        day = next
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }
}

// MARK: - Screen

/// Which waiver the review sheet is editing, and with which verdict pre-selected —
/// mirrors the web's ReviewState (one modal, action baked in by the button pressed).
private struct AttendanceWaiverReviewTarget: Identifiable {
    let waiver: AttendanceWaiverRow
    let approve: Bool
    var id: String { waiver.id }
}

@available(iOS 17.0, *)
struct AttendanceScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = AttendanceVM()
    @State private var selected: AttendanceRecordRow? = nil
    @State private var showDatePicker = false
    // Action targets — each mutating call passes a Bangla confirmationDialog first.
    @State private var reviewing: AttendanceWaiverReviewTarget? = nil
    @State private var resetTarget: AttendanceRecordRow? = nil
    @State private var showResetDialog = false
    @State private var verifyTarget: AttendanceRecordRow? = nil
    @State private var showVerifyDialog = false
    @State private var selfieTarget: AttendanceSelfieLog? = nil
    @State private var selfieApprove = true
    @State private var showSelfieDialog = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                dateNav
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err) }
                if let ok = vm.notice { successCard(ok) }
                summaryTrio
                kpiStrip
                analyticsSection
                waiversSection
                recordsSection
                selfiePendingSection
                absentSection
                selfieLogSection
                rankingSection
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(AttendanceAurora())
        .claudeTopFade()
        .refreshable {
            await vm.load()
            await vm.loadAnalytics()
        }
        .task {
            await vm.load()
            await vm.loadAnalytics()
        }
        .sheet(item: $selected) { rec in
            AttendanceDetailSheet(record: rec, day: vm.day, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showDatePicker) {
            AttendanceDatePickerSheet(initial: vm.day) { picked in
                vm.day = picked
                Task { await vm.load() }
            }
            .presentationDetents([.height(480)])
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $reviewing) { target in
            AttendanceWaiverReviewSheet(waiver: target.waiver, approve: target.approve) { amount, note in
                Task { await vm.reviewWaiver(target.waiver, approve: target.approve,
                                             amount: amount, note: note) }
            }
            .presentationDetents([.height(target.approve ? 430 : 330)])
            .presentationDragIndicator(.visible)
        }
        .confirmationDialog("হাজিরা রিসেট", isPresented: $showResetDialog,
                            titleVisibility: .visible, presenting: resetTarget) { rec in
            Button("হ্যাঁ, রিসেট করুন", role: .destructive) {
                Task { await vm.resetAttendance(rec) }
            }
            Button("বাতিল", role: .cancel) {}
        } message: { rec in
            Text("\(rec.employeeName ?? "কর্মী")-এর এই দিনের হাজিরা মুছে যাবে — আবার চেক-ইন করতে পারবে, লেট পেনাল্টি (থাকলে) ফেরত যাবে।")
        }
        .confirmationDialog("সেলফি ভেরিফিকেশন", isPresented: $showVerifyDialog,
                            titleVisibility: .visible, presenting: verifyTarget) { rec in
            Button("হ্যাঁ, ভেরিফিকেশন চান") {
                Task { await vm.requestVerification(rec) }
            }
            Button("বাতিল", role: .cancel) {}
        } message: { rec in
            Text("\(rec.employeeName ?? "কর্মী")-কে সেলফি ভেরিফিকেশন করতে বলা হবে — সে My Desk-এ 'Verify Face Now' দেখবে।")
        }
        .confirmationDialog("ভেরিফিকেশন রিভিউ", isPresented: $showSelfieDialog,
                            titleVisibility: .visible, presenting: selfieTarget) { log in
            Button(selfieApprove ? "হ্যাঁ, অনুমোদন করুন" : "হ্যাঁ, প্রত্যাখ্যান করুন",
                   role: selfieApprove ? nil : .destructive) {
                Task { await vm.reviewSelfie(log, approve: selfieApprove) }
            }
            Button("বাতিল", role: .cancel) {}
        } message: { log in
            Text(selfieApprove
                 ? "\(log.employeeId ?? "কর্মী")-এর সেলফি অনুমোদন হলে রেকর্ডটি TRUSTED হবে।"
                 : "\(log.employeeId ?? "কর্মী")-এর সেলফি প্রত্যাখ্যান হলে রেকর্ডটি WARNING হবে।")
        }
    }

    // ── Native date navigation (chevrons + tappable date → graphical picker) ──

    private var dateNav: some View {
        HStack(spacing: 8) {
            chevronButton("chevron.left") {
                vm.shiftDay(-1)
                Task { await vm.load() }
            }
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                showDatePicker = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "calendar")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(AttendancePalette.accentText(colorScheme))
                    Text(vm.isToday ? "আজ · \(AttendanceFormat.dayLabel(vm.day))"
                                    : AttendanceFormat.dayLabel(vm.day))
                        .font(.footnote.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            }
            .buttonStyle(.plain)
            chevronButton("chevron.right", disabled: vm.isToday) {
                vm.shiftDay(1)
                Task { await vm.load() }
            }
        }
        .padding(.top, 4)
    }

    private func chevronButton(_ icon: String, disabled: Bool = false,
                               action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Image(systemName: icon)
                .font(.footnote.weight(.bold))
                .foregroundStyle(disabled ? Color.secondary.opacity(0.4)
                                          : AttendancePalette.accentText(colorScheme))
                .frame(width: 38, height: 36)
                .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    // ── Summary trio (web: Present / Absent / Late cards, exact tints) ──

    private var summaryTrio: some View {
        HStack(spacing: 10) {
            summaryCard("Present", vm.kpis?.todayAttendance,
                        icon: "checkmark.circle.fill", tint: AttendancePalette.emerald600)
            summaryCard("Absent", vm.kpis?.absentEmployees,
                        icon: "xmark.circle.fill", tint: AttendancePalette.red500)
            summaryCard("Late", vm.kpis?.lateEmployees,
                        icon: "clock.fill", tint: AttendancePalette.amber600)
        }
    }

    private func summaryCard(_ label: String, _ value: Int?, icon: String, tint: Color) -> some View {
        VStack(spacing: 5) {
            Image(systemName: icon)
                .font(.subheadline)
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(tint.opacity(0.12), in: Circle())
            Text(value.map { "\($0)" } ?? "—")
                .font(.title3.weight(.bold)).monospacedDigit()
                .foregroundStyle(tint)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(tint.opacity(0.25), lineWidth: 1))
        .attendanceShimmerIf(vm.loading && vm.kpis == nil)
    }

    // ── Secondary KPI strip (web KpiCard row, same labels/value colours) ──

    private var kpiStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("TODAY PENALTIES", AttendanceFormat.money(vm.kpis?.todayPenaltyTotal),
                        tint: AttendancePalette.red500)
                kpiCard("MONTHLY ATTENDANCE", vm.kpis.map { "\($0.attendanceRate)%" } ?? "—",
                        tint: .primary)
                kpiCard("MONTHLY PENALTIES", AttendanceFormat.money(vm.kpis?.monthPenaltyTotal),
                        tint: AttendancePalette.red500)
                kpiCard("PENDING REVIEWS", vm.kpis.map { "\($0.pendingWaivers)" } ?? "—",
                        tint: AttendancePalette.goldLt)
                kpiCard("SECURITY FLAGS", vm.kpis.map { "\($0.suspiciousAttendance)" } ?? "—",
                        tint: AttendancePalette.amber500)
                kpiCard("VERIFICATION DUE", vm.kpis.map { "\($0.pendingVerifications)" } ?? "—",
                        tint: AttendancePalette.amber500)
                kpiCard("EMPLOYEE SCOPE", vm.kpis.map { "\($0.employeeCount)" } ?? "—",
                        tint: .primary)
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    private func kpiCard(_ label: String, _ value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.subheadline.weight(.bold)).monospacedDigit().foregroundStyle(tint)
        }
        .frame(minWidth: 96, alignment: .leading)
        .padding(12)
        .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Penalty appeal analytics (web admin card, this month) ──

    @ViewBuilder private var analyticsSection: some View {
        if let a = vm.analytics {
            VStack(alignment: .leading, spacing: 8) {
                Text("Penalty appeal analytics (this month)")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                HStack(spacing: 8) {
                    analyticsStat("Total", AttendanceFormat.money(a.totalPenalties),
                                  tint: AttendancePalette.red500)
                    analyticsStat("Waived", AttendanceFormat.money(a.waivedAmount),
                                  tint: AttendancePalette.emerald600)
                    analyticsStat("Net", AttendanceFormat.money(a.netPenaltiesAfterWaivers),
                                  tint: .primary)
                    analyticsStat("Approval", "\(a.approvalRate)%",
                                  tint: AttendancePalette.goldLt)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    private func analyticsStat(_ label: String, _ value: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
                .textCase(.uppercase)
            Text(value).font(.caption.weight(.bold)).monospacedDigit().foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8).padding(.vertical, 7)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }

    // ── Attendance log (per-employee status-dot rows + Reset/Selfie admin actions) ──

    @ViewBuilder private var recordsSection: some View {
        sectionHeader("Attendance log", count: vm.records.count)
        if vm.loading && vm.records.isEmpty {
            loadingRows
        } else if vm.records.isEmpty && vm.error == nil && !vm.authExpired {
            emptyCard(icon: "person.crop.circle.badge.questionmark",
                      title: "কোনো চেক-ইন নেই",
                      subtitle: "কর্মীরা Start Work চাপলে এখানে দেখা যাবে।")
        } else {
            ForEach(vm.records.prefix(60)) { rec in
                AttendanceRecordCard(
                    record: rec,
                    showBusiness: vm.scopeAllBusinesses,
                    busy: vm.busyIds.contains(rec.id),
                    onTap: { selected = rec },
                    onReset: {
                        resetTarget = rec
                        showResetDialog = true
                    },
                    onVerify: {
                        verifyTarget = rec
                        showVerifyDialog = true
                    })
            }
        }
    }

    // ── Absent employees ──

    @ViewBuilder private var absentSection: some View {
        if !vm.loading || !vm.absentees.isEmpty {
            sectionHeader("Absent today", count: vm.absentees.count)
            if vm.absentees.isEmpty {
                if vm.error == nil && !vm.authExpired && !vm.loading {
                    Text("আজ কেউ অনুপস্থিত নেই ✅")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(AttendancePalette.emerald600)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                }
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(vm.absentees.enumerated()), id: \.element.id) { index, emp in
                        HStack(spacing: 10) {
                            AttendanceAvatar(name: emp.name ?? "?",
                                             dot: AttendancePalette.red500, size: 30)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(emp.name ?? "—").font(.footnote.weight(.semibold))
                                Text(emp.employeeId ?? "unlinked")
                                    .font(.caption2.monospaced()).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text("ABSENT")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(AttendancePalette.red500)
                                .padding(.horizontal, 7).padding(.vertical, 2)
                                .background(AttendancePalette.red500.opacity(0.12), in: Capsule())
                        }
                        .padding(.vertical, 8)
                        if index < vm.absentees.count - 1 { Divider().opacity(0.4) }
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
                .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
            }
        }
    }

    // ── Penalty review queue (native Approve/Reject — web submitReview parity) ──

    @ViewBuilder private var waiversSection: some View {
        if !vm.waivers.isEmpty {
            sectionHeader("Penalty review queue", count: vm.waivers.count)
            ForEach(vm.waivers) { w in
                AttendanceWaiverCard(
                    waiver: w,
                    busy: vm.busyIds.contains(w.id),
                    onApprove: { reviewing = AttendanceWaiverReviewTarget(waiver: w, approve: true) },
                    onReject: { reviewing = AttendanceWaiverReviewTarget(waiver: w, approve: false) })
            }
        }
    }

    // ── Face verification reviews (web "Pending face verification reviews") ──

    @ViewBuilder private var selfiePendingSection: some View {
        if !vm.pendingSelfies.isEmpty {
            sectionHeader("Face verification — pending", count: vm.pendingSelfies.count)
            ForEach(vm.pendingSelfies) { log in
                AttendanceSelfieCard(
                    log: log,
                    showBusiness: vm.scopeAllBusinesses,
                    busy: vm.busyIds.contains(log.id),
                    onApprove: {
                        selfieTarget = log
                        selfieApprove = true
                        showSelfieDialog = true
                    },
                    onReject: {
                        selfieTarget = log
                        selfieApprove = false
                        showSelfieDialog = true
                    })
            }
        }
    }

    // ── Selfie verification logs (web month log — reviewed + awaiting) ──

    @ViewBuilder private var selfieLogSection: some View {
        let reviewed = vm.selfieLogs.filter { !$0.isPending }
        if !reviewed.isEmpty {
            sectionHeader("Selfie verification logs", count: reviewed.count)
            ForEach(reviewed.prefix(12)) { log in
                AttendanceSelfieCard(log: log, showBusiness: vm.scopeAllBusinesses,
                                     busy: false, onApprove: nil, onReject: nil)
            }
        }
    }

    // ── Punctuality ranking ──

    @ViewBuilder private var rankingSection: some View {
        if !vm.ranking.isEmpty {
            sectionHeader("Punctuality ranking", count: nil)
            VStack(spacing: 0) {
                ForEach(Array(vm.ranking.prefix(20).enumerated()), id: \.element.id) { index, row in
                    HStack(spacing: 10) {
                        Text("\(index + 1)")
                            .font(.caption.weight(.bold)).monospacedDigit()
                            .foregroundStyle(index < 3 ? AttendancePalette.accentText(colorScheme) : .secondary)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.name ?? "—").font(.footnote.weight(.semibold)).lineLimit(1)
                            Text(rankMeta(row)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Text("\(row.punctualityScore ?? 0)%")
                            .font(.footnote.weight(.bold)).monospacedDigit()
                            .foregroundStyle(AttendancePalette.accentText(colorScheme))
                    }
                    .padding(.vertical, 8)
                    if index < min(vm.ranking.count, 20) - 1 { Divider().opacity(0.4) }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 6)
            .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    private func rankMeta(_ row: AttendanceRankRow) -> String {
        var bits: [String] = []
        bits.append("\(row.presentDays ?? 0) days")
        bits.append("\(row.lateCount ?? 0) late")
        if let avg = row.averageWorkLabel, !avg.isEmpty { bits.append("avg \(avg)") }
        if let pen = row.penaltyTotal, pen > 0 { bits.append("penalty \(AttendanceFormat.money(pen))") }
        return bits.joined(separator: " · ")
    }

    // ── Shared bits ──

    private func sectionHeader(_ title: String, count: Int?) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            if let count, count > 0 {
                Text("\(count)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(AttendancePalette.accentText(colorScheme))
                    .padding(.horizontal, 7).padding(.vertical, 1.5)
                    .background(AttendancePalette.coral.opacity(0.14), in: Capsule())
            }
            Spacer()
        }
        .padding(.top, 6)
    }

    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(AttendancePalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func successCard(_ message: String) -> some View {
        Label(message, systemImage: "checkmark.circle")
            .font(.footnote).foregroundStyle(AttendancePalette.emerald600)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func emptyCard(icon: String, title: String, subtitle: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon).font(.largeTitle).foregroundStyle(.secondary)
            Text(title).foregroundStyle(.secondary)
            Text(subtitle).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 84)
                .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .attendanceShimmer()
        }
    }

    /// Small escape link — every admin action is native now; this is just the exit.
    private var webEscape: some View {
        Button {
            openWeb("/attendance", "Attendance")
        } label: {
            Label("ওয়েব ভার্সন", systemImage: "safari")
                .font(.caption)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }
}

// MARK: - Initials avatar with a status dot (present-green · late-amber · absent-red)

@available(iOS 17.0, *)
private struct AttendanceAvatar: View {
    let name: String
    let dot: Color?
    var size: CGFloat = 34
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Text(AttendanceFormat.initials(name))
                .font(.system(size: size * 0.36, weight: .bold))
                .foregroundStyle(AttendancePalette.accentText(colorScheme))
                .frame(width: size, height: size)
                .background(AttendancePalette.coral.opacity(0.16), in: Circle())
                .overlay(Circle().strokeBorder(AttendancePalette.coral.opacity(0.35), lineWidth: 1))
            if let dot {
                Circle()
                    .fill(dot)
                    .frame(width: size * 0.32, height: size * 0.32)
                    .overlay(Circle().strokeBorder(.background, lineWidth: 1.5))
                    .offset(x: 1.5, y: 1.5)
            }
        }
    }
}

// MARK: - Record row card (one employee's day, web mobile-card parity)

@available(iOS 17.0, *)
private struct AttendanceRecordCard: View {
    let record: AttendanceRecordRow
    let showBusiness: Bool
    let busy: Bool
    let onTap: () -> Void
    let onReset: () -> Void      // web Reset (Super Admin — server-gated)
    let onVerify: () -> Void     // web Selfie / Requested / Verified button
    @Environment(\.colorScheme) private var colorScheme

    private var dotColor: Color {
        record.isLate ? AttendancePalette.amber500 : AttendancePalette.green400
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                AttendanceAvatar(name: record.employeeName ?? "?", dot: dotColor)
                VStack(alignment: .leading, spacing: 1) {
                    Text(record.employeeName ?? "—")
                        .font(.footnote.weight(.semibold)).lineLimit(1)
                    HStack(spacing: 5) {
                        Text(record.employeeId ?? "—")
                            .font(.caption2.monospaced()).foregroundStyle(.secondary)
                        if showBusiness, let biz = record.businessId {
                            Text(biz.replacingOccurrences(of: "_", with: " "))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
                Spacer()
                trustPill
            }

            HStack(spacing: 8) {
                timeCell("In", AttendanceFormat.time(record.checkInAt), tint: .primary)
                timeCell("Out", record.isCheckedOut ? AttendanceFormat.time(record.checkOutAt) : "--",
                         tint: .primary)
                timeCell("Late", AttendanceFormat.duration(record.lateMinutes ?? 0),
                         tint: record.isLate ? AttendancePalette.red500 : AttendancePalette.emerald600,
                         bg: record.isLate ? AttendancePalette.red500 : AttendancePalette.emerald600)
            }

            HStack {
                Text("Worked \(AttendanceFormat.duration(record.totalWorkMinutes ?? 0))")
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Text(AttendanceFormat.money(record.penaltyAmount))
                    .font(.caption.weight(.semibold)).monospacedDigit()
                    .foregroundStyle((record.penaltyAmount ?? 0) > 0 ? AttendancePalette.red500 : .secondary)
            }

            actionRow
        }
        .padding(12)
        .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }

    /// Web row actions: Reset (SA) + Selfie/Requested/Verified. ONE spinner per row.
    @ViewBuilder private var actionRow: some View {
        if busy {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Processing…").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        } else {
            HStack(spacing: 8) {
                actionChip("রিসেট", icon: "arrow.counterclockwise",
                           tint: AttendancePalette.red500, action: onReset)
                verifyChip
            }
            .padding(.top, 2)
        }
    }

    /// Same three states the web button shows: Verified · Requested · Selfie.
    @ViewBuilder private var verifyChip: some View {
        if (record.selfieCount ?? 0) > 0 {
            statusChipLabel("Verified ✓", tint: AttendancePalette.emerald600)
        } else if record.verificationRequired == true {
            statusChipLabel("Requested…", tint: AttendancePalette.amber600)
        } else {
            actionChip("সেলফি চান", icon: "faceid",
                       tint: AttendancePalette.coral,
                       text: AttendancePalette.accentText(colorScheme), action: onVerify)
        }
    }

    private func statusChipLabel(_ label: String, tint: Color) -> some View {
        Text(label)
            .font(.caption.weight(.semibold))
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
            .background(tint.opacity(0.10), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.25), lineWidth: 0.8))
    }

    private func actionChip(_ label: String, icon: String, tint: Color,
                            text: Color? = nil, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            action()
        } label: {
            Label(label, systemImage: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(text ?? tint)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 7)
                .background(tint.opacity(0.13), in: Capsule())
                .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var trustPill: some View {
        let tint = AttendancePalette.trust(record.trustStatus)
        return Text((record.trustStatus ?? "—").replacingOccurrences(of: "_", with: " "))
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 2.5)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.3), lineWidth: 0.8))
    }

    private func timeCell(_ label: String, _ value: String, tint: Color, bg: Color? = nil) -> some View {
        VStack(spacing: 2) {
            Text(value)
                .font(.caption.weight(.semibold)).monospacedDigit()
                .foregroundStyle(tint)
            Text(label).font(.system(size: 9)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 7)
        .background((bg ?? Color.primary).opacity(bg == nil ? 0.05 : 0.10),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }
}

// MARK: - Waiver card (native Approve/Reject → review sheet, web queue-row parity)

@available(iOS 17.0, *)
private struct AttendanceWaiverCard: View {
    let waiver: AttendanceWaiverRow
    let busy: Bool
    let onApprove: () -> Void
    let onReject: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                AttendanceAvatar(name: waiver.requesterName ?? "?",
                                 dot: AttendancePalette.amber500, size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(waiver.requesterName ?? "—") · \(waiver.employeeId ?? "—")")
                        .font(.footnote.weight(.semibold)).lineLimit(1)
                    Text(metaLine).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
            }
            if let reason = waiver.reason, !reason.isEmpty {
                Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(3)
            }
            if busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Processing…").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            } else {
                HStack(spacing: 8) {
                    waiverButton("Reject", icon: "xmark",
                                 tint: AttendancePalette.red500,
                                 text: AttendancePalette.red500, action: onReject)
                    waiverButton("Approve", icon: "checkmark",
                                 tint: AttendancePalette.coral,
                                 text: AttendancePalette.accentText(colorScheme), action: onApprove)
                }
            }
        }
        .padding(12)
        .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func waiverButton(_ label: String, icon: String, tint: Color,
                              text: Color, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            action()
        } label: {
            Label(label, systemImage: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(text)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(tint.opacity(0.13), in: Capsule())
                .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var metaLine: String {
        var bits: [String] = []
        if let late = waiver.lateMinutes { bits.append("Late \(late)m") }
        if let type = waiver.requestType {
            bits.append(type.replacingOccurrences(of: "_", with: " ").lowercased())
        }
        let asked = waiver.requestedReductionAmount ?? waiver.originalPenaltyAmount
        bits.append("asked \(AttendanceFormat.money(asked)) of \(AttendanceFormat.money(waiver.originalPenaltyAmount))")
        if waiver.hasAttachment == true { bits.append("📎") }
        if let created = waiver.createdAt, created.count >= 10 { bits.append(String(created.prefix(10))) }
        return bits.joined(separator: " · ")
    }
}

// MARK: - Waiver review sheet (web review modal parity — amount + admin note)

@available(iOS 17.0, *)
private struct AttendanceWaiverReviewSheet: View {
    let waiver: AttendanceWaiverRow
    let approve: Bool
    let onConfirm: (_ amount: Int, _ note: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var amount = ""
    @State private var note = ""

    private var original: Int { waiver.originalPenaltyAmount ?? 0 }
    private var amountValue: Int { Int(amount.trimmingCharacters(in: .whitespaces)) ?? 0 }
    /// Web input constraints: min 1, max the original penalty.
    private var amountValid: Bool { !approve || (amountValue >= 1 && amountValue <= original) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(approve ? "পেনাল্টি মওকুফ অনুমোদন" : "আপিল প্রত্যাখ্যান")
                    .font(.headline)
                Text("\(waiver.requesterName ?? "—") · \(waiver.employeeId ?? "—") · আসল পেনাল্টি \(AttendanceFormat.money(original)) · চেয়েছে \(AttendanceFormat.money(waiver.requestedReductionAmount ?? original))")
                    .font(.caption).foregroundStyle(.secondary)

                if approve {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("অনুমোদিত মওকুফ (ওয়ালেট ক্রেডিট)")
                            .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                        TextField("৳", text: $amount)
                            .keyboardType(.numberPad)
                            .font(.body.monospacedDigit())
                            .padding(12)
                            .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                        Text(amountValid
                             ? "অনুমোদনের পর ফাইনাল পেনাল্টি: \(AttendanceFormat.money(max(0, original - amountValue)))"
                             : "১ থেকে \(AttendanceFormat.money(original))-এর মধ্যে দিন")
                            .font(.caption2)
                            .foregroundStyle(amountValid ? Color.secondary : AttendancePalette.amber600)
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("অ্যাডমিন নোট")
                        .font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                    TextField("নোট (ঐচ্ছিক)", text: $note, axis: .vertical)
                        .lineLimit(2...4)
                        .padding(12)
                        .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                }

                Button {
                    dismiss()
                    onConfirm(amountValue, note.trimmingCharacters(in: .whitespacesAndNewlines))
                } label: {
                    Text(approve ? "অনুমোদন করুন" : "প্রত্যাখ্যান করুন")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .tint(approve ? AttendancePalette.coral : AttendancePalette.red500)
                .disabled(!amountValid)

                Spacer(minLength: 0)
            }
            .padding(18)
        }
        .presentationBackground { AttendanceAurora() }
        .onAppear {
            amount = String(waiver.requestedReductionAmount ?? original)
        }
    }
}

// MARK: - Selfie verification card (photo + verdict buttons / review status)

@available(iOS 17.0, *)
private struct AttendanceSelfieCard: View {
    let log: AttendanceSelfieLog
    let showBusiness: Bool
    let busy: Bool
    let onApprove: (() -> Void)?     // nil = read-only log row (already reviewed)
    let onReject: (() -> Void)?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AttendanceSelfiePhoto(log: log)
            HStack {
                Text(log.employeeId ?? "—")
                    .font(.caption2.monospaced().weight(.semibold))
                Spacer()
                Text(AttendanceFormat.dateTime(log.capturedAt))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if showBusiness, let biz = log.businessId {
                Text(biz.replacingOccurrences(of: "_", with: " "))
                    .font(.caption2).foregroundStyle(AttendancePalette.amber600)
            }
            if log.isPending {
                if busy {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Processing…").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                } else if let onApprove, let onReject {
                    HStack(spacing: 8) {
                        selfieButton("Reject", icon: "xmark",
                                     tint: AttendancePalette.red500,
                                     text: AttendancePalette.red500, action: onReject)
                        selfieButton("Approve", icon: "checkmark",
                                     tint: AttendancePalette.coral,
                                     text: AttendancePalette.accentText(colorScheme), action: onApprove)
                    }
                } else {
                    Text("Awaiting review")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(AttendancePalette.amber600)
                }
            } else {
                Text("Reviewed \(AttendanceFormat.dateTime(log.reviewedAt))")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(AttendancePalette.emerald600)
            }
        }
        .padding(12)
        .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(log.isPending ? AttendancePalette.amber500.opacity(0.35) : .clear, lineWidth: 1))
    }

    private func selfieButton(_ label: String, icon: String, tint: Color,
                              text: Color, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            action()
        } label: {
            Label(label, systemImage: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(text)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(tint.opacity(0.13), in: Capsule())
                .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

/// The photo itself — signed https URL via AsyncImage; legacy inline data: URLs are
/// base64-decoded off the render path; missing storage refs show the web's fallback.
@available(iOS 17.0, *)
private struct AttendanceSelfiePhoto: View {
    let log: AttendanceSelfieLog
    @State private var inlineImage: UIImage? = nil

    var body: some View {
        Group {
            if log.imageMissing == true || log.displaySrc == nil {
                fallback
            } else if let src = log.displaySrc, src.hasPrefix("data:image/") {
                if let img = inlineImage {
                    Image(uiImage: img).resizable().scaledToFill()
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                        .task { inlineImage = Self.decodeDataURL(src) }
                }
            } else if let src = log.displaySrc, let url = URL(string: src) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFill()
                    case .failure: fallback
                    default: ProgressView().frame(maxWidth: .infinity)
                    }
                }
            } else {
                fallback
            }
        }
        .frame(height: 150)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .background(Color.primary.opacity(0.05),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
    }

    /// Web VerificationPhoto fallback: "Photo unavailable" + re-verify hint.
    private var fallback: some View {
        VStack(spacing: 4) {
            Image(systemName: "photo.badge.exclamationmark")
                .font(.title3).foregroundStyle(AttendancePalette.amber600)
            Text("ছবি পাওয়া যায়নি")
                .font(.caption2.weight(.bold)).foregroundStyle(AttendancePalette.amber600)
            Text("স্টোরেজ রেফারেন্স নেই/মেয়াদোত্তীর্ণ — দরকারে আবার ভেরিফাই করতে বলুন")
                .font(.system(size: 9)).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private static func decodeDataURL(_ src: String) -> UIImage? {
        guard let comma = src.range(of: "base64,") else { return nil }
        let b64 = String(src[comma.upperBound...])
        guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: data)
    }
}

// MARK: - Detail sheet (one employee's day timeline)

@available(iOS 17.0, *)
private struct AttendanceDetailSheet: View {
    let record: AttendanceRecordRow
    let day: Date
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                timeline
                infoRows
                if !record.suspiciousReasons.isEmpty { suspiciousBox }
                webLink
            }
            .padding(18)
        }
        .presentationBackground { AttendanceAurora() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            AttendanceAvatar(name: record.employeeName ?? "?",
                             dot: record.isLate ? AttendancePalette.amber500 : AttendancePalette.green400,
                             size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(record.employeeName ?? "—").font(.headline)
                Text("\(record.employeeId ?? "—") · \(AttendanceFormat.dayLabel(day))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    /// The day's timeline: check-in → (late) → check-out / still working.
    private var timeline: some View {
        VStack(alignment: .leading, spacing: 0) {
            timelineRow(icon: "arrow.down.circle.fill",
                        tint: record.isLate ? AttendancePalette.amber500 : AttendancePalette.emerald600,
                        title: "চেক-ইন \(AttendanceFormat.time(record.checkInAt))",
                        subtitle: record.isLate
                            ? "⏰ \(AttendanceFormat.duration(record.lateMinutes ?? 0)) দেরি"
                            : "সময়মতো",
                        last: false)
            timelineRow(icon: record.isCheckedOut ? "arrow.up.circle.fill" : "clock.badge",
                        tint: record.isCheckedOut ? AttendancePalette.emerald600 : AttendancePalette.goldLt,
                        title: record.isCheckedOut
                            ? "চেক-আউট \(AttendanceFormat.time(record.checkOutAt))"
                            : "এখনও কাজ চলছে",
                        subtitle: "মোট কাজ \(AttendanceFormat.duration(record.totalWorkMinutes ?? 0))",
                        last: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func timelineRow(icon: String, tint: Color, title: String,
                             subtitle: String, last: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) {
                Image(systemName: icon)
                    .font(.subheadline)
                    .foregroundStyle(tint)
                    .frame(width: 24, height: 24)
                if !last {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.25))
                        .frame(width: 1.5, height: 26)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.footnote.weight(.semibold))
                Text(subtitle).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow("Penalty", AttendanceFormat.money(record.penaltyAmount),
                    color: (record.penaltyAmount ?? 0) > 0 ? AttendancePalette.red500 : .primary)
            infoRow("Trust", (record.trustStatus ?? "—").replacingOccurrences(of: "_", with: " "),
                    color: AttendancePalette.trust(record.trustStatus))
            infoRow("Verification",
                    (record.selfieCount ?? 0) > 0 ? "Verified (\(record.selfieCount ?? 0) selfie)"
                        : record.verificationRequired == true ? "Requested — awaiting selfie"
                        : "Not requested",
                    color: (record.selfieCount ?? 0) > 0 ? AttendancePalette.emerald600
                        : record.verificationRequired == true ? AttendancePalette.amber600 : .secondary)
            if let biz = record.businessId {
                infoRow("Business", biz.replacingOccurrences(of: "_", with: " "))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .attendanceGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ label: String, _ value: String, color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.semibold)).foregroundStyle(color)
        }
    }

    private var suspiciousBox: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("SECURITY FLAGS")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(AttendancePalette.amber600)
            ForEach(record.suspiciousReasons, id: \.self) { reason in
                Text("• \(reason.replacingOccurrences(of: "_", with: " "))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(AttendancePalette.amber500.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(AttendancePalette.amber500.opacity(0.30), lineWidth: 1))
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/attendance", "Attendance")
        } label: {
            Label("ওয়েব ভার্সন", systemImage: "safari")
                .font(.caption)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Date picker sheet (graphical calendar, Dhaka business days, no future)

@available(iOS 17.0, *)
private struct AttendanceDatePickerSheet: View {
    let initial: Date
    let onPick: (Date) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var picked = Date()

    var body: some View {
        VStack(spacing: 12) {
            Text("তারিখ বাছাই করুন").font(.headline).padding(.top, 14)
            DatePicker("", selection: $picked, in: ...Date(), displayedComponents: .date)
                .datePickerStyle(.graphical)
                .tint(AttendancePalette.coral)
                .environment(\.timeZone, AttendanceFormat.dhaka)
            Button {
                dismiss()
                onPick(picked)
            } label: {
                Text("এই দিনের হাজিরা দেখুন")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(AttendancePalette.coral)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .presentationBackground { AttendanceAurora() }
        .onAppear { picked = initial }
    }
}

// MARK: - Formatting helpers (web util parity, Asia/Dhaka)

enum AttendanceFormat {
    static let dhaka = TimeZone(identifier: "Asia/Dhaka") ?? .current

    static var dhakaCalendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = dhaka
        return c
    }

    /// API `date` param — yyyy-MM-dd in the Dhaka business day.
    static func dayParam(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = dhaka
        return f.string(from: date)
    }

    /// Header label — "Sun, 6 Jul 2026".
    static func dayLabel(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "EEE, d MMM yyyy"
        f.timeZone = dhaka
        f.locale = Locale(identifier: "en_US_POSIX")
        return f.string(from: date)
    }

    /// ISO timestamp → "9:05 AM" (web: toLocaleTimeString hour/minute), Dhaka clock.
    static func time(_ iso: String?) -> String {
        guard let iso, let date = parse(iso) else { return "--" }
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        f.timeZone = dhaka
        return f.string(from: date)
    }

    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// ISO timestamp → "5/7/26, 8:50 PM" (web: new Date(x).toLocaleString()), Dhaka.
    static func dateTime(_ iso: String?) -> String {
        guard let iso, let date = parse(iso) else { return "—" }
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        f.timeZone = dhaka
        return f.string(from: date)
    }

    /// Web duration(): "1h 5m" / "45m".
    static func duration(_ minutes: Int) -> String {
        let h = minutes / 60, m = minutes % 60
        if h == 0 { return "\(m)m" }
        return "\(h)h \(m)m"
    }

    /// Web money(): "৳ 1,200".
    static func money(_ value: Int?) -> String {
        "৳ \((value ?? 0).formatted())"
    }

    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (Attendance-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct AttendanceAurora: View {
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
    func attendanceGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct AttendanceShimmer: ViewModifier {
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
    func attendanceShimmer() -> some View { modifier(AttendanceShimmer()) }

    /// Shimmer only while a section is still loading its first payload.
    @ViewBuilder func attendanceShimmerIf(_ active: Bool) -> some View {
        if active { attendanceShimmer() } else { self }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Attendance — Light") {
    AttendanceScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
