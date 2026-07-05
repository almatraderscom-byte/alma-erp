//
//  AttendanceSwiftUI.swift
//  ALMA ERP — the Attendance dashboard as a native SwiftUI screen.
//
//  Mirrors the web /attendance page (read view) — same endpoint, same colours:
//    GET /api/attendance?business_id=ALL&date=YYYY-MM-DD   → dashboard bundle
//        (kpis · records · absentEmployees · pendingWaivers · ranking)
//  Native extras: chevron prev/next day + graphical DatePicker sheet (the API's
//  `date` param drives the whole dashboard), status-dot initials rows, per-employee
//  detail sheet with the day's timeline.
//  ALL edit/override actions stay on the web escape hatch by design: penalty-waiver
//  review, selfie verification approve/reject, verification request, attendance reset.
//  Carried lessons: ONE per-section skeleton, never a global overlay; lenient decoding.
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
        case id, employeeId, requesterName, requestType, originalPenaltyAmount
        case requestedReductionAmount, reason, hasAttachment, createdAt, lateMinutes
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
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
    let ranking: [AttendanceRankRow]
    let scopeAllBusinesses: Bool

    private enum Keys: String, CodingKey {
        case ok, data, kpis, records, absentEmployees, pendingWaivers, ranking, scopeAllBusinesses
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        kpis = try? c.decodeIfPresent(AttendanceKpis.self, forKey: .kpis)
        records = (try? c.decode([AttendanceRecordRow].self, forKey: .records)) ?? []
        absentEmployees = (try? c.decode([AttendanceAbsentee].self, forKey: .absentEmployees)) ?? []
        pendingWaivers = (try? c.decode([AttendanceWaiverRow].self, forKey: .pendingWaivers)) ?? []
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
    var ranking: [AttendanceRankRow] = []
    var scopeAllBusinesses = false
    var loading = false
    var error: String? = nil
    var authExpired = false

    /// Selected day (Dhaka business day) — drives the `date` query param.
    var day: Date = Date()

    var isToday: Bool {
        AttendanceFormat.dayParam(day) == AttendanceFormat.dayParam(Date())
    }

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

@available(iOS 17.0, *)
struct AttendanceScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = AttendanceVM()
    @State private var selected: AttendanceRecordRow? = nil
    @State private var showDatePicker = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                dateNav
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err) }
                summaryTrio
                kpiStrip
                recordsSection
                absentSection
                waiversSection
                rankingSection
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(AttendanceAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
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
                .attendanceGlass(colorScheme, corner: 12)
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
                .attendanceGlass(colorScheme, corner: 12)
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
        .attendanceGlass(colorScheme, corner: 16)
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
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
        .attendanceGlass(colorScheme, corner: 14)
    }

    // ── Attendance log (per-employee status-dot rows) ──

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
                AttendanceRecordCard(record: rec, showBusiness: vm.scopeAllBusinesses) {
                    selected = rec
                }
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
                        .attendanceGlass(colorScheme, corner: 14)
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
                .attendanceGlass(colorScheme, corner: 16)
            }
        }
    }

    // ── Penalty review queue (read-only — review action stays on the web) ──

    @ViewBuilder private var waiversSection: some View {
        if !vm.waivers.isEmpty {
            sectionHeader("Penalty review queue", count: vm.waivers.count)
            ForEach(vm.waivers) { w in
                AttendanceWaiverCard(waiver: w) {
                    openWeb("/attendance?review=\(w.id)", "Attendance")
                }
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
            .attendanceGlass(colorScheme, corner: 16)
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
            .padding(12).attendanceGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .attendanceGlass(colorScheme, corner: 16)
    }

    private func emptyCard(icon: String, title: String, subtitle: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon).font(.largeTitle).foregroundStyle(.secondary)
            Text(title).foregroundStyle(.secondary)
            Text(subtitle).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .attendanceGlass(colorScheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 84)
                .attendanceGlass(colorScheme, corner: 16)
                .attendanceShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/attendance", "Attendance")
        } label: {
            Label("সব অপশন (রিভিউ · ভেরিফিকেশন · রিসেট) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
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
    let onTap: () -> Void
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
        }
        .padding(12)
        .attendanceGlass(colorScheme, corner: 16)
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
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
                    in: RoundedRectangle(cornerRadius: 10))
    }
}

// MARK: - Waiver card (read-only digest; review happens on the web)

@available(iOS 17.0, *)
private struct AttendanceWaiverCard: View {
    let waiver: AttendanceWaiverRow
    let onReview: () -> Void
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
                Text(reason).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                onReview()
            } label: {
                Label("ওয়েবে রিভিউ করুন", systemImage: "safari")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AttendancePalette.accentText(colorScheme))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(AttendancePalette.coral.opacity(0.13), in: Capsule())
                    .overlay(Capsule().strokeBorder(AttendancePalette.coral.opacity(0.35), lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
        .padding(12)
        .attendanceGlass(colorScheme, corner: 16)
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
        .attendanceGlass(colorScheme, corner: 14)
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
        .attendanceGlass(colorScheme, corner: 14)
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
        .background(AttendancePalette.amber500.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8)
            .strokeBorder(AttendancePalette.amber500.opacity(0.30), lineWidth: 1))
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/attendance", "Attendance")
        } label: {
            Label("সব অপশন (রিসেট · ভেরিফিকেশন) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
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
    func attendanceGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
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
