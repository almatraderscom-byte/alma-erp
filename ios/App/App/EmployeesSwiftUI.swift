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
//  rows, recent wallet ledger. Mutating actions (add/edit employee, payroll entry,
//  salary edit/correction, account linking) stay on the web escape hatch.
//  Carried lessons: lenient per-field decoding, ONE spinner scope, cancellation-safe
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

/// The `users` array from include_users=1 — only the bits the native list needs
/// (linked userId → photo via /api/users/{id}/profile-image, like the web avatar).
struct EmployeeLinkedUser: Decodable, Equatable {
    let id: String
    let name: String?
    let linked: Bool?
    let linkedEmployeeId: String?

    private enum Keys: String, CodingKey { case id, name, linked, linkedEmployeeId }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        linked = try? c.decodeIfPresent(Bool.self, forKey: .linked)
        linkedEmployeeId = try? c.decodeIfPresent(String.self, forKey: .linkedEmployeeId)
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
    let signedAmount: Int
    let runningBalance: Int
    /// Stable list identity even when the ledger row has no id.
    let id: String

    private enum Keys: String, CodingKey {
        case id, date, periodYm, type, note, signedAmount, runningBalance
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        entryId = try? c.decodeIfPresent(String.self, forKey: .id)
        date = try? c.decodeIfPresent(String.self, forKey: .date)
        periodYm = try? c.decodeIfPresent(String.self, forKey: .periodYm)
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
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

// MARK: - View models

/// The web BusinessContext default — HR roster lives in the primary business.
private let employeesBusinessId = "ALMA_LIFESTYLE"

@available(iOS 17.0, *)
@Observable
final class EmployeesVM {
    var employees: [EmployeeRosterItem] = []
    /// emp_id → linked userId (photo avatars, "Linked" marker — web usersByEmployeeId).
    var linkedUserIdByEmpId: [String: String] = [:]
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: EmployeesListResponse = try await AlmaAPI.shared.get(
                "/api/hr/employees",
                query: ["business_id": employeesBusinessId, "include_users": "1"])
            employees = resp.employees
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

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }
}

/// Detail sheet data — the two fetches the web detail page runs (wallet + attendance).
@available(iOS 17.0, *)
@Observable
final class EmployeeDetailVM {
    var wallet: EmployeeWalletDetail? = nil
    var attendance: EmployeeAttendanceDetail? = nil
    var loading = false
    var error: String? = nil

    func load(empId: String) async {
        loading = true
        error = nil
        defer { loading = false }
        let encoded = empId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? empId
        // Wallet + attendance are independent — a failure in one must not blank the other.
        async let walletTask: EmployeeWalletDetail? = try? AlmaAPI.shared.get(
            "/api/payroll/wallet/\(encoded)", query: ["business_id": employeesBusinessId])
        async let attendanceTask: EmployeeAttendanceDetail? = try? AlmaAPI.shared.get(
            "/api/attendance", query: ["business_id": employeesBusinessId, "employee_id": empId])
        let (w, a) = await (walletTask, attendanceTask)
        if Task.isCancelled { return }
        wallet = w
        attendance = a
        if w == nil && a == nil {
            error = "বিস্তারিত লোড করা যায়নি — আবার চেষ্টা করুন।"
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
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err) }
                statsStrip
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
                openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
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
        .employeesGlass(colorScheme, corner: 14)
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
        .employeesGlass(colorScheme, corner: 14)
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
            .padding(12).employeesGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .employeesGlass(colorScheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<6, id: \.self) { _ in
            Color.clear.frame(height: 72)
                .employeesGlass(colorScheme, corner: 16)
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

    private var webEscape: some View {
        Button {
            openWeb("/employees", "Employees")
        } label: {
            Label("সব অপশন (Add·Link·Pay সহ) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
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
        .employeesGlass(colorScheme, corner: 16)
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }
}

// MARK: - Detail sheet (web /employees/[id] parity — profile header, wallet summary
// strip, attendance summary, recent ledger; mutating actions stay on the web)

@available(iOS 17.0, *)
private struct EmployeeDetailSheet: View {
    let employee: EmployeeRosterItem
    let linkedUserId: String?
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = EmployeeDetailVM()
    @State private var showBalanceNote = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                contactButtons
                infoRows
                walletStrip
                attendanceBlock
                ledgerBlock
                webLink
            }
            .padding(18)
        }
        .presentationBackground { EmployeesAurora() }
        .task { await vm.load(empId: employee.empId) }
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
        .employeesGlass(colorScheme, corner: 14)
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
                .employeesGlass(colorScheme, corner: 14)
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
            .employeesGlass(colorScheme, corner: 14)
        } else if let err = vm.error {
            Label(err, systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(EmployeePalette.red500)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12).employeesGlass(colorScheme, corner: 12)
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
            .employeesGlass(colorScheme, corner: 14)
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
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
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
            .employeesGlass(colorScheme, corner: 14)
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
        }
    }

    /// Edit employee · payroll entry · salary correction · slip PDF — all web-only.
    private var webLink: some View {
        Button {
            dismiss()
            let encoded = employee.empId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? employee.empId
            openWeb("/employees/\(encoded)", employee.name)
        } label: {
            Label("সব অপশন (Pay·Salary·Slip সহ) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
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
    func employeesGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
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
