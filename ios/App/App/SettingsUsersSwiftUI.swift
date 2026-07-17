//
//  SettingsUsersSwiftUI.swift
//  ALMA ERP — the Settings ▸ Users screen as a native SwiftUI screen (READ-ONLY).
//
//  Mirrors the web /settings/users page's read surface — same endpoint, same colours:
//    GET /api/users   → { users: [...] }   (SUPER_ADMIN / ADMIN only)
//  Native blocks: KPI strip (accounts / active / inactive) · role filter chips ·
//  user rows (initials avatar, role capsule, active dot, business scope, HR ID) ·
//  detail sheet with role-capability hint.
//
//  ⚠️ STRICTLY READ-ONLY BY DESIGN: creating users, editing accounts, changing
//  roles, permissions and password resets are access-control writes — they ALL stay
//  on the web page via the escape hatch. This file must never gain a POST/PATCH.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum SettingsUsersPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let red400 = Color(red: 0.973, green: 0.443, blue: 0.443)         // #F87171
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let cyan400 = Color(red: 0.133, green: 0.827, blue: 0.933)        // #22D3EE (web tone-cyan)

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Role capsule tint — SUPER_ADMIN gold · ADMIN violet · HR cyan · VIEWER green ·
    /// STAFF neutral (the web RoleBadge tones, re-set on the app's accents).
    static func role(_ role: String) -> Color {
        switch role {
        case "SUPER_ADMIN": return goldDim
        case "ADMIN": return AlmaSwiftTheme.violet
        case "HR": return cyan400
        case "VIEWER": return green400
        default: return .secondary            // STAFF + unknown → neutral
        }
    }
}

// MARK: - Models (same field names /api/users selects)

struct SettingsUserRow: Decodable, Identifiable, Equatable {
    let id: String
    let email: String?
    let name: String
    let phone: String?
    let role: String
    let active: Bool
    let businessAccess: String
    let employeeIdGas: String?
    let joiningDate: String?
    let salaryHint: Int?
    let profileImageUrl: String?
    let createdAt: String?

    private enum Keys: String, CodingKey {
        case id, email, name, phone, role, active, businessAccess
        case employeeIdGas, joiningDate, salaryHint, profileImageUrl, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        role = (try? c.decode(String.self, forKey: .role)) ?? "STAFF"
        active = (try? c.decodeIfPresent(Bool.self, forKey: .active)) ?? true
        businessAccess = (try? c.decodeIfPresent(String.self, forKey: .businessAccess)) ?? ""
        employeeIdGas = try? c.decodeIfPresent(String.self, forKey: .employeeIdGas)
        joiningDate = try? c.decodeIfPresent(String.self, forKey: .joiningDate)
        salaryHint = Self.flexInt(c, .salaryHint)   // Prisma Decimal → string or number
        profileImageUrl = try? c.decodeIfPresent(String.self, forKey: .profileImageUrl)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) {
            if let i = Int(s) { return i }
            if let d = Double(s) { return Int(d.rounded()) }
        }
        return nil
    }

    /// Web RoleBadge text: underscore → space.
    var roleLabel: String { role.replacingOccurrences(of: "_", with: " ") }

    /// businessAccess csv → the registry's short names ("Alma · CDIT · Trading").
    var businessShortNames: [String] {
        businessAccess.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .map { id in
                switch id {
                case "ALMA_LIFESTYLE": return "Alma"
                case "CREATIVE_DIGITAL_IT": return "CDIT"
                case "ALMA_TRADING": return "Trading"
                default: return id
                }
            }
    }

    /// Same capability hints the web ALMA_ROLE_OPTIONS table shows.
    var roleHint: String {
        switch role {
        case "SUPER_ADMIN": return "Full access · manage users · branding · audit · delete-capable ops"
        case "ADMIN": return "Orders, CRM, inventory, invoices, analytics, finance/expenses · manage staff accounts"
        case "HR": return "Employees, payroll, advances approval, finance hub & expense ledger"
        case "STAFF": return "Create/track orders · invoice tools · CDIT ops (scoped) · employee portal"
        case "VIEWER": return "Read-only dashboards and lists — cannot edit data"
        default: return "—"
        }
    }

    static func == (a: SettingsUserRow, b: SettingsUserRow) -> Bool {
        a.id == b.id && a.active == b.active && a.role == b.role
    }
}

/// /api/users answers flat `{ users: [...] }`; decode a `{ ok, data: {…} }` wrapper
/// too, in case the route ever adopts apiDataSuccess like the approvals routes did.
struct SettingsUsersListResponse: Decodable {
    let users: [SettingsUserRow]

    private enum Keys: String, CodingKey { case ok, data, users }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        users = (try? c.decode([SettingsUserRow].self, forKey: .users)) ?? []
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class SettingsUsersVM {
    var users: [SettingsUserRow] = []
    var roleFilter = "ALL"                // ALL | SUPER_ADMIN | ADMIN | HR | STAFF | VIEWER
    var loading = false
    var error: String? = nil
    var authExpired = false

    var filtered: [SettingsUserRow] {
        roleFilter == "ALL" ? users : users.filter { $0.role == roleFilter }
    }
    var activeCount: Int { users.filter(\.active).count }
    var inactiveCount: Int { users.count - activeCount }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: SettingsUsersListResponse = try await AlmaAPI.shared.get("/api/users")
            users = resp.users
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            // /api/users answers 403 for non-admin roles too — same card either way:
            // the owner logs in (or an admin account is needed) via the web tab.
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

// MARK: - Screen

@available(iOS 17.0, *)
struct SettingsUsersScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = SettingsUsersVM()
    @State private var selected: SettingsUserRow? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                kpiStrip
                roleChips
                if vm.loading && vm.users.isEmpty { loadingRows }
                ForEach(vm.filtered) { user in
                    SettingsUserRowCard(user: user) { selected = user }
                }
                if !vm.loading && vm.filtered.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(SettingsUsersAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { user in
            SettingsUserDetailSheet(user: user, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── KPI strip (accounts / active / inactive) ──

    private var kpiStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("ACCOUNTS", vm.users.count, SettingsUsersPalette.goldLt)
                kpiCard("ACTIVE", vm.activeCount, SettingsUsersPalette.emerald600)
                kpiCard("INACTIVE", vm.inactiveCount, SettingsUsersPalette.red500)
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    /// Light bento pass (owner spec 2026-07-08): tile skin with a soft accent wash
    /// of the KPI's own tint — same values, presentation only.
    private func kpiCard(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary)
            Text("\(value)").font(.system(size: 17, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
        }
        .frame(minWidth: 84, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background {
            LinearGradient(colors: [tint.opacity(colorScheme == .dark ? 0.14 : 0.10), .clear],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
                .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        }
        .settingsUsersGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Role filter chips (client-side — /api/users returns the full list) ──

    private var roleChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(["ALL", "SUPER_ADMIN", "ADMIN", "HR", "STAFF", "VIEWER"], id: \.self) { r in
                    chip(r == "ALL" ? "All" : r.replacingOccurrences(of: "_", with: " ").capitalized,
                         active: vm.roleFilter == r) {
                        vm.roleFilter = r
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    /// The web's accent chip (Button variant "gold": bg-gold/10 · border-gold/30 ·
    /// text-gold-dim) on the app's glass surface.
    private func chip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .lineLimit(1).minimumScaleFactor(0.5)
                .foregroundStyle(active ? SettingsUsersPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? SettingsUsersPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? SettingsUsersPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── States ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .settingsUsersGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(SettingsUsersPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).settingsUsersGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "person.2").font(.largeTitle).foregroundStyle(.secondary)
            Text(vm.roleFilter == "ALL" ? "কোনো ইউজার নেই" : "এই রোলে কেউ নেই")
                .foregroundStyle(.secondary)
        }
        .padding(.top, 70)
        .padding(.bottom, 30)
    }

    private var loadingRows: some View {
        ForEach(0..<5, id: \.self) { _ in
            Color.clear.frame(height: 74)
                .settingsUsersGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .settingsUsersShimmer()
        }
    }

    /// The web page keeps ALL account writes (create user · edit · role · permissions ·
    /// password reset · activate/deactivate) — this button is the only way there.
    private var webEscape: some View {
        Button {
            openWeb("/settings/users", "Users")
        } label: {
            Label("ইউজার তৈরি / এডিট / পাসওয়ার্ড — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Row card (mirrors one web table row / mobile card — read-only)

@available(iOS 17.0, *)
private struct SettingsUserRowCard: View {
    let user: SettingsUserRow
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 10) {
            avatar
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(user.name).font(.footnote.weight(.semibold)).lineLimit(1)
                    activeDot
                }
                Text(metaLine)
                    .font(.caption2.monospaced())
                    .foregroundStyle(SettingsUsersPalette.accentText(colorScheme))
                    .lineLimit(1)
                if !user.businessShortNames.isEmpty || user.employeeIdGas != nil {
                    Text(scopeLine).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            roleCapsule
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .settingsUsersGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
        .opacity(user.active ? 1 : 0.62)   // inactive accounts read dimmed, like the web's red status
    }

    private var avatar: some View {
        Text(SettingsUsersFormat.initials(user.name))
            .font(.caption.weight(.bold))
            .foregroundStyle(SettingsUsersPalette.accentText(colorScheme))
            .frame(width: 36, height: 36)
            .background(SettingsUsersPalette.coral.opacity(0.16), in: Circle())
            .overlay(Circle().strokeBorder(SettingsUsersPalette.coral.opacity(0.35), lineWidth: 1))
    }

    /// Web status column: Active text-green-400 · Inactive text-red-400 — as a dot.
    private var activeDot: some View {
        Circle()
            .fill(user.active ? SettingsUsersPalette.green400 : SettingsUsersPalette.red400)
            .frame(width: 7, height: 7)
    }

    private var roleCapsule: some View {
        let tint = SettingsUsersPalette.role(user.role)
        return Text(user.roleLabel)
            .font(.system(size: 9, weight: .bold))
            .textCase(.uppercase)
            .foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }

    /// Phone (web: font-mono text-gold-lt) or email fallback.
    private var metaLine: String {
        if let phone = user.phone, !phone.isEmpty { return SettingsUsersFormat.bdPhone(phone) }
        return user.email ?? "—"
    }

    private var scopeLine: String {
        var bits: [String] = []
        if !user.businessShortNames.isEmpty { bits.append(user.businessShortNames.joined(separator: " · ")) }
        if let emp = user.employeeIdGas, !emp.isEmpty { bits.append(emp) }
        return bits.joined(separator: "  ·  ")
    }
}

// MARK: - Detail sheet (read-only account card; all writes → web escape hatch)

@available(iOS 17.0, *)
private struct SettingsUserDetailSheet: View {
    let user: SettingsUserRow
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                infoRows
                roleHintCard
                webLink
            }
            .padding(18)
        }
        .presentationBackground { SettingsUsersAurora() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text(SettingsUsersFormat.initials(user.name))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(SettingsUsersPalette.accentText(colorScheme))
                .frame(width: 46, height: 46)
                .background(SettingsUsersPalette.coral.opacity(0.16), in: Circle())
                .overlay(Circle().strokeBorder(SettingsUsersPalette.coral.opacity(0.35), lineWidth: 1))
            VStack(alignment: .leading, spacing: 4) {
                Text(user.name).font(.headline)
                HStack(spacing: 8) {
                    roleCapsule
                    Text(user.active ? "Active" : "Inactive")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(user.active ? SettingsUsersPalette.green400
                                                     : SettingsUsersPalette.red400)
                }
            }
        }
    }

    private var roleCapsule: some View {
        let tint = SettingsUsersPalette.role(user.role)
        return Text(user.roleLabel)
            .font(.system(size: 9, weight: .bold))
            .textCase(.uppercase)
            .foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow("Phone", user.phone.map(SettingsUsersFormat.bdPhone) ?? "—",
                    color: SettingsUsersPalette.accentText(colorScheme), mono: true)
            infoRow("Email", user.email ?? "—", mono: true)
            infoRow("Business access",
                    user.businessShortNames.isEmpty ? "—" : user.businessShortNames.joined(separator: " · "))
            infoRow("HR employee ID (GAS)", user.employeeIdGas ?? "—",
                    color: SettingsUsersPalette.accentText(colorScheme), mono: true)
            infoRow("Joining date", SettingsUsersFormat.date(user.joiningDate) ?? "—")
            if let hint = user.salaryHint {
                infoRow("Salary hint", "৳\(hint.formatted())", mono: true)
            }
            infoRow("Account created", SettingsUsersFormat.date(user.createdAt) ?? "—")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .settingsUsersGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ label: String, _ value: String,
                         color: Color = .primary, mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value)
                .font(mono ? .footnote.monospaced().weight(.semibold) : .footnote.weight(.semibold))
                .foregroundStyle(color)
        }
    }

    /// Web "Role capabilities" modal parity — the server-enforced scope hint.
    private var roleHintCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ROLE CAPABILITIES")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(SettingsUsersPalette.accentText(colorScheme))
            Text(user.roleHint)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text("রোল / পারমিশন / পাসওয়ার্ড পরিবর্তন শুধু ওয়েবে হয় — নিচের বাটনে যান।")
                .font(.caption2)
                .foregroundStyle(SettingsUsersPalette.amber600)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(SettingsUsersPalette.coral.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(SettingsUsersPalette.goldDim.opacity(0.25), lineWidth: 1))
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/settings/users", "Users")
        } label: {
            Label("এডিট / পারমিশন / পাসওয়ার্ড — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Formatting helpers

private enum SettingsUsersFormat {
    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }

    /// Web displayBdPhone parity: "+880 1XX XXX XXXX" grouping when it fits.
    static func bdPhone(_ raw: String) -> String {
        var digits = raw.trimmingCharacters(in: .whitespaces)
            .filter { $0.isNumber || $0 == "+" }
        if !digits.hasPrefix("+") {
            if digits.hasPrefix("880") { digits = "+\(digits)" }
            else if digits.hasPrefix("01"), digits.count == 11 { digits = "+88\(digits)" }
        }
        guard digits.hasPrefix("+880"), digits.count == 14 else { return digits }
        let s = Array(digits)
        return "\(String(s[0..<4])) \(String(s[4..<7])) \(String(s[7..<10])) \(String(s[10..<14]))"
    }

    /// ISO timestamp (or plain yyyy-MM-dd) → short local date, Asia/Dhaka.
    static func date(_ iso: String?) -> String? {
        guard let iso else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        var date = fractional.date(from: iso) ?? plain.date(from: iso)
        if date == nil, iso.count >= 10 {
            let day = DateFormatter()
            day.dateFormat = "yyyy-MM-dd"
            day.timeZone = TimeZone(identifier: "Asia/Dhaka")
            date = day.date(from: String(iso.prefix(10)))
        }
        guard let date else { return nil }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }
}

// MARK: - Aurora background + glass (SettingsUsers-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct SettingsUsersAurora: View {
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
    func settingsUsersGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct SettingsUsersShimmer: ViewModifier {
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
    func settingsUsersShimmer() -> some View { modifier(SettingsUsersShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Settings Users — Light") {
    SettingsUsersScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
