//
//  TradingStaffSwiftUI.swift
//  ALMA ERP — the ALMA Trading staff admin (/agent/trading-staff) as a native
//  SwiftUI screen (read-only).
//
//  Mirrors the web page — same endpoint, same colours, same blocks:
//    GET /api/assistant/internal/trading-staff/upsert → { staff, eligibleUsers }
//  Web-parity blocks: sub-header ("ALMA Trading · Staff" + Bangla subtitle) ·
//  summary strip (staff/active/telegram counts) · "Linked Trading staff (N)"
//  cards (initials avatar · glowing active dot · ERP link line · Telegram chat
//  ID · role label) · "Link a new Trading staff" eligible-user list · detail
//  sheet. All WRITE actions (link/activate/deactivate/edit chat ID) stay on the
//  web — the footer escape hatch opens /agent/trading-staff.
//  Carried lessons: lenient decoding, cancellation-safe .refreshable, auth card.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum TradingStaffPalette {
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
    /// Web: active dot emerald glow · inactive dot red glow.
    static func activeDot(_ active: Bool) -> Color {
        active ? green400 : red500
    }
    static func activeText(_ active: Bool) -> Color {
        active ? emerald600 : red500
    }
}

// MARK: - Models (same field names the web page's interfaces declare)

struct TradingStaffMember: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let role: String
    let telegramChatId: String?
    let ntfyTopic: String?
    let active: Bool
    let userId: String?
    let user: LinkedUser?

    struct LinkedUser: Decodable, Equatable {
        let id: String?
        let name: String?
        let email: String?

        private enum Keys: String, CodingKey { case id, name, email }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            id = try? c.decodeIfPresent(String.self, forKey: .id)
            name = try? c.decodeIfPresent(String.self, forKey: .name)
            email = try? c.decodeIfPresent(String.self, forKey: .email)
        }
    }

    private enum Keys: String, CodingKey {
        case id, name, role, telegramChatId, ntfyTopic, active, userId, user
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? "Trading Staff"
        role = (try? c.decode(String.self, forKey: .role)) ?? "p2p_trader"
        telegramChatId = Self.flexString(c, .telegramChatId)
        ntfyTopic = try? c.decodeIfPresent(String.self, forKey: .ntfyTopic)
        active = (try? c.decodeIfPresent(Bool.self, forKey: .active)) ?? true
        userId = try? c.decodeIfPresent(String.self, forKey: .userId)
        user = try? c.decodeIfPresent(LinkedUser.self, forKey: .user)
    }

    /// Telegram chat IDs are strings in Prisma but numeric-looking — accept both
    /// JSON shapes (string or int), same spirit as the flexInt helpers elsewhere.
    private static func flexString(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> String? {
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return s }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return String(i) }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return String(Int(d.rounded())) }
        return nil
    }

    static func == (a: TradingStaffMember, b: TradingStaffMember) -> Bool {
        a.id == b.id && a.active == b.active && a.telegramChatId == b.telegramChatId && a.role == b.role
    }
}

struct TradingStaffUser: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let email: String?
    let role: String?

    private enum Keys: String, CodingKey { case id, name, email, role }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        email = try? c.decodeIfPresent(String.self, forKey: .email)
        role = try? c.decodeIfPresent(String.self, forKey: .role)
    }
}

/// The route returns the payload flat: `{ staff: […], eligibleUsers: […] }` —
/// decode leniently (and tolerate an apiDataSuccess-style `{ ok, data }` wrapper
/// in case the route is ever normalized like the approvals ones were).
struct TradingStaffListResponse: Decodable {
    let staff: [TradingStaffMember]
    let eligibleUsers: [TradingStaffUser]

    private enum Keys: String, CodingKey { case ok, data, staff, eligibleUsers }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        staff = (try? c.decode([TradingStaffMember].self, forKey: .staff)) ?? []
        eligibleUsers = (try? c.decode([TradingStaffUser].self, forKey: .eligibleUsers)) ?? []
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class TradingStaffVM {
    var staff: [TradingStaffMember] = []
    var eligibleUsers: [TradingStaffUser] = []
    var filter = "ALL"                    // ALL | ACTIVE | INACTIVE (client-side)
    var loading = false
    var error: String? = nil
    var authExpired = false

    /// Users not yet linked to a staff row — the web's `availableUsers` computation.
    var availableUsers: [TradingStaffUser] {
        let linked = Set(staff.compactMap { $0.userId })
        return eligibleUsers.filter { !linked.contains($0.id) }
    }

    var filteredStaff: [TradingStaffMember] {
        switch filter {
        case "ACTIVE": return staff.filter { $0.active }
        case "INACTIVE": return staff.filter { !$0.active }
        default: return staff
        }
    }

    var activeCount: Int { staff.filter { $0.active }.count }
    var telegramCount: Int { staff.filter { !($0.telegramChatId ?? "").isEmpty }.count }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: TradingStaffListResponse = try await AlmaAPI.shared.get(
                "/api/assistant/internal/trading-staff/upsert")
            staff = resp.staff
            eligibleUsers = resp.eligibleUsers
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

    // ── Native writes (owner 2026-07-11) — web upsert() parity, one POST for all. ──

    var toast: String? = nil
    var saving = false

    struct UpsertBody: Encodable {
        var id: String? = nil
        var userId: String? = nil
        var name: String? = nil
        var role: String? = nil
        var telegramChatId: String? = nil
        var active: Bool? = nil
    }
    private struct UpsertResponse: Decodable { let ok: Bool?, error: String? }

    func upsert(_ body: UpsertBody) async -> Bool {
        saving = true
        defer { saving = false }
        do {
            let res: UpsertResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/internal/trading-staff/upsert", body: body)
            if let err = res.error {
                toast = "সেভ ব্যর্থ: \(err)"
                return false
            }
            toast = "সেভ হয়েছে"
            await load()
            return true
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return false
        } catch {
            if Self.isCancellation(error) { return false }
            toast = "সেভ ব্যর্থ: \(error.localizedDescription)"
            return false
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct TradingStaffScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = TradingStaffVM()
    @State private var selected: TradingStaffMember? = nil
    @State private var linking: TradingStaffUser? = nil
    @State private var editingChatId: TradingStaffMember? = nil
    @State private var chatIdDraft = ""
    @State private var editingRole: TradingStaffMember? = nil
    @State private var roleDraft = ""
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                header
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                filterChips
                summaryStrip
                staffSection
                eligibleSection
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(TradingStaffAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { member in
            TradingStaffDetailSheet(member: member, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            "\(linking?.name ?? "")-কে Trading staff হিসেবে link করবেন?",
            isPresented: Binding(get: { linking != nil }, set: { if !$0 { linking = nil } }),
            titleVisibility: .visible
        ) {
            Button("হ্যাঁ, link করুন") {
                if let u = linking {
                    Task {
                        _ = await vm.upsert(.init(userId: u.id, name: u.name,
                                                  role: "p2p_trader", active: true))
                    }
                }
                linking = nil
            }
            Button("বাতিল", role: .cancel) { linking = nil }
        }
        .alert("Telegram Chat ID", isPresented: Binding(
            get: { editingChatId != nil }, set: { if !$0 { editingChatId = nil } })) {
            TextField("123456789", text: $chatIdDraft)
            Button("Save") {
                if let m = editingChatId {
                    let v = chatIdDraft.trimmingCharacters(in: .whitespaces)
                    Task { _ = await vm.upsert(.init(id: m.id, telegramChatId: v.isEmpty ? nil : v)) }
                }
                editingChatId = nil
            }
            Button("বাতিল", role: .cancel) { editingChatId = nil }
        }
        .alert("Role", isPresented: Binding(
            get: { editingRole != nil }, set: { if !$0 { editingRole = nil } })) {
            TextField("p2p_trader", text: $roleDraft)
            Button("Save") {
                if let m = editingRole, !roleDraft.isEmpty {
                    Task { _ = await vm.upsert(.init(id: m.id, role: roleDraft)) }
                }
                editingRole = nil
            }
            Button("বাতিল", role: .cancel) { editingRole = nil }
        }
        .overlay(alignment: .bottom) {
            if let t = vm.toast {
                Text(t)
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .task {
                        try? await Task.sleep(nanoseconds: 2_600_000_000)
                        withAnimation { vm.toast = nil }
                    }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: vm.toast != nil)
    }

    // ── Header (web AgentSubHeader parity: "ALMA Trading · Staff" + subtitle) ──

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Text("ALMA Trading").font(.headline.weight(.bold))
                Text("Staff")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(TradingStaffPalette.accentText(colorScheme))
            }
            Text("Binance P2P trader-দের লিঙ্ক ও Telegram chat ID")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    // ── Filter chips (native — client-side Active/Inactive slice) ──

    private var filterChips: some View {
        HStack(spacing: 8) {
            staffChip("All", active: vm.filter == "ALL") { vm.filter = "ALL" }
            staffChip("Active", active: vm.filter == "ACTIVE") { vm.filter = "ACTIVE" }
            staffChip("Inactive", active: vm.filter == "INACTIVE") { vm.filter = "INACTIVE" }
            Spacer()
            if !vm.staff.isEmpty {
                Text("\(vm.staff.count)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(TradingStaffPalette.accentText(colorScheme))
                    .padding(.horizontal, 9).padding(.vertical, 4)
                    .background(TradingStaffPalette.coral.opacity(0.18), in: Capsule())
                    .overlay(Capsule().strokeBorder(TradingStaffPalette.coral.opacity(0.4), lineWidth: 1))
            }
        }
    }

    // ── Summary strip (honest client-side counts, KPI-card look) ──

    private var summaryStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("STAFF", vm.staff.count, TradingStaffPalette.goldLt)
                kpiCard("ACTIVE", vm.activeCount, TradingStaffPalette.emerald600)
                kpiCard("INACTIVE", vm.staff.count - vm.activeCount,
                        vm.staff.count - vm.activeCount > 0 ? TradingStaffPalette.red500 : .primary)
                kpiCard("TELEGRAM", vm.telegramCount,
                        vm.telegramCount < vm.staff.count ? TradingStaffPalette.amber600 : .primary)
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    private func kpiCard(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text("\(value)").font(.headline.weight(.bold)).foregroundStyle(tint)
        }
        .frame(minWidth: 84, alignment: .leading)
        .padding(12)
        .tradingStaffGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Linked staff (web "Linked Trading staff (N)" section) ──

    @ViewBuilder private var staffSection: some View {
        sectionHeader("Linked Trading staff (\(vm.staff.count))")
        if vm.loading && vm.staff.isEmpty {
            loadingRows
        } else if vm.staff.isEmpty && vm.error == nil && !vm.authExpired {
            Text("এখনো কোনো Trading staff লিঙ্ক করা হয়নি।")
                .font(.footnote).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .tradingStaffGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        } else {
            ForEach(vm.filteredStaff) { member in
                TradingStaffCard(member: member) { selected = member }
                    .contextMenu {
                        Button {
                            Task { _ = await vm.upsert(.init(id: member.id, active: !member.active)) }
                        } label: {
                            Label(member.active ? "Deactivate" : "Activate",
                                  systemImage: member.active ? "pause.circle" : "play.circle")
                        }
                        Button {
                            editingChatId = member
                            chatIdDraft = member.telegramChatId ?? ""
                        } label: {
                            Label("Telegram Chat ID", systemImage: "paperplane")
                        }
                        Button {
                            editingRole = member
                            roleDraft = member.role ?? "p2p_trader"
                        } label: {
                            Label("Role বদলান", systemImage: "person.text.rectangle")
                        }
                    }
            }
            if vm.filteredStaff.isEmpty && !vm.staff.isEmpty {
                Text("এই ফিল্টারে কেউ নেই")
                    .font(.footnote).foregroundStyle(.secondary)
                    .padding(.vertical, 20)
            }
        }
    }

    // ── Eligible users (web "Link a new Trading staff" — read-only here) ──

    @ViewBuilder private var eligibleSection: some View {
        sectionHeader("Link a new Trading staff")
        if vm.availableUsers.isEmpty {
            if !vm.loading && !vm.authExpired {
                Text("সব eligible User ইতিমধ্যে লিঙ্ক করা আছে। নতুন trader add করতে User Management থেকে User তৈরি করুন (businessAccess-এ ALMA_TRADING রাখুন)।")
                    .font(.footnote).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .tradingStaffGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(vm.availableUsers) { u in
                    HStack(spacing: 10) {
                        Text(TradingStaffFormat.initials(u.name))
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.secondary)
                            .frame(width: 30, height: 30)
                            .background(Color.primary.opacity(0.06), in: Circle())
                            .overlay(Circle().strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(u.name).font(.footnote.weight(.semibold))
                            Text([u.email, u.role].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption2).foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        // Native link (owner 2026-07-11): web upsert {userId, role, active}.
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            linking = u
                        } label: {
                            Text("Link")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(TradingStaffPalette.accentText(colorScheme))
                                .padding(.horizontal, 12).padding(.vertical, 5)
                                .background(TradingStaffPalette.coral.opacity(0.13), in: Capsule())
                                .overlay(Capsule().strokeBorder(TradingStaffPalette.coral.opacity(0.35), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .disabled(vm.saving)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .tradingStaffGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    // ── Shared bits ──

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.bold)).textCase(.uppercase)
            .foregroundStyle(TradingStaffPalette.accentText(colorScheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
    }

    /// The web's accent chip (gold variant) on the app's glass surface.
    private func staffChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? TradingStaffPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? TradingStaffPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? TradingStaffPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, success, info }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", TradingStaffPalette.red500)
        case .success: ("checkmark.circle", TradingStaffPalette.emerald600)
        case .info: ("info.circle", Color.secondary)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).tradingStaffGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .tradingStaffGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 96)
                .tradingStaffGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .tradingStaffShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/agent/trading-staff", "Trading staff")
        } label: {
            Label("সব অপশন (এডিট / লিঙ্ক সহ) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Staff card (mirrors one web staff row card)

@available(iOS 17.0, *)
private struct TradingStaffCard: View {
    let member: TradingStaffMember
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                avatar
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(member.name).font(.subheadline.weight(.bold))
                        // Web: glowing 2.5px status dot next to the name.
                        Circle()
                            .fill(TradingStaffPalette.activeDot(member.active))
                            .frame(width: 9, height: 9)
                            .shadow(color: TradingStaffPalette.activeDot(member.active).opacity(0.6),
                                    radius: 3)
                    }
                    // Web meta line: "ERP: {user} · Role: {role} · Active/Inactive"
                    Text("ERP: \(member.user?.name ?? "— unlinked —") · Role: \(member.role)")
                        .font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                statusPill
            }

            telegramRow
        }
        .padding(14)
        .tradingStaffGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .opacity(member.active ? 1 : 0.7)   // web: inactive rows at opacity-70
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }

    private var avatar: some View {
        Text(TradingStaffFormat.initials(member.name))
            .font(.caption.weight(.bold))
            .foregroundStyle(TradingStaffPalette.accentText(colorScheme))
            .frame(width: 34, height: 34)
            .background(TradingStaffPalette.coral.opacity(0.16), in: Circle())
            .overlay(Circle().strokeBorder(TradingStaffPalette.coral.opacity(0.35), lineWidth: 1))
    }

    private var statusPill: some View {
        Text(member.active ? "Active" : "Inactive")
            .font(.caption2.weight(.bold))
            .foregroundStyle(TradingStaffPalette.activeText(member.active))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(TradingStaffPalette.activeText(member.active).opacity(0.10), in: Capsule())
            .overlay(Capsule().strokeBorder(
                TradingStaffPalette.activeText(member.active).opacity(0.30), lineWidth: 1))
    }

    @ViewBuilder private var telegramRow: some View {
        if let chatId = member.telegramChatId, !chatId.isEmpty {
            HStack(spacing: 6) {
                Image(systemName: "paperplane.fill")
                    .font(.caption2)
                    .foregroundStyle(TradingStaffPalette.accentText(colorScheme))
                Text("Telegram chat ID").font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Text(chatId)
                    .font(.footnote.monospaced())
                    .foregroundStyle(TradingStaffPalette.accentText(colorScheme))
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(TradingStaffPalette.coral.opacity(0.05), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(TradingStaffPalette.coral.opacity(0.25), lineWidth: 1))
        } else {
            Text("Telegram chat ID নেই — dispatch পাঠানো যাবে না")
                .font(.caption2.weight(.bold))
                .foregroundStyle(TradingStaffPalette.amber600)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(TradingStaffPalette.amber500.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .strokeBorder(TradingStaffPalette.amber500.opacity(0.30), lineWidth: 1))
        }
    }
}

// MARK: - Detail sheet (full record; edits stay on the web)

@available(iOS 17.0, *)
private struct TradingStaffDetailSheet: View {
    let member: TradingStaffMember
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                infoRows
                webLink
            }
            .padding(18)
        }
        .presentationBackground { TradingStaffAurora() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text(TradingStaffFormat.initials(member.name))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(TradingStaffPalette.accentText(colorScheme))
                .frame(width: 44, height: 44)
                .background(TradingStaffPalette.coral.opacity(0.16), in: Circle())
                .overlay(Circle().strokeBorder(TradingStaffPalette.coral.opacity(0.35), lineWidth: 1))
            VStack(alignment: .leading, spacing: 2) {
                Text(member.name).font(.headline)
                Text(member.role).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text(member.active ? "Active" : "Inactive")
                .font(.caption2.weight(.bold))
                .foregroundStyle(TradingStaffPalette.activeText(member.active))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(TradingStaffPalette.activeText(member.active).opacity(0.10), in: Capsule())
                .overlay(Capsule().strokeBorder(
                    TradingStaffPalette.activeText(member.active).opacity(0.30), lineWidth: 1))
        }
    }

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow("ERP user", member.user?.name ?? "— unlinked —")
            infoRow("Email", member.user?.email ?? "—")
            infoRow("Role label", member.role)
            infoRow("Telegram chat ID", member.telegramChatId ?? "—",
                    color: (member.telegramChatId ?? "").isEmpty
                        ? TradingStaffPalette.amber600
                        : TradingStaffPalette.accentText(colorScheme),
                    mono: true)
            infoRow("ntfy topic", member.ntfyTopic ?? "—")
            infoRow("Staff ID", member.id, mono: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .tradingStaffGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ label: String, _ value: String,
                         color: Color = .primary, mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value)
                .font(mono ? .footnote.monospaced() : .footnote.weight(.semibold))
                .foregroundStyle(color)
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/agent/trading-staff", "Trading staff")
        } label: {
            Label("এডিট / Activate-Deactivate — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Formatting helpers

private enum TradingStaffFormat {
    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (TradingStaff-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct TradingStaffAurora: View {
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
    func tradingStaffGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct TradingStaffShimmer: ViewModifier {
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
    func tradingStaffShimmer() -> some View { modifier(TradingStaffShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Trading staff — Light") {
    TradingStaffScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
