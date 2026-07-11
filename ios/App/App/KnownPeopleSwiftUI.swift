//
//  KnownPeopleSwiftUI.swift
//  ALMA ERP — the agent's "চেনা মুখ" page (camera face registry + entrance watch)
//  as a native, READ-ONLY SwiftUI screen.
//
//  Mirrors the web /agent/known-people page (KnownPeopleManager) — same endpoints,
//  same Bangla labels, same blocks:
//    GET /api/assistant/known-people          → { people, thumbs, settings, maxPhotos }
//    GET /api/assistant/known-people/cameras  → { cameras, workRoomDeviceId }
//  Blocks: entrance-watch settings card (read-only digest) · search · role chips ·
//  Contacts-style people rows (photo/initials avatar + role capsule + active state) ·
//  person detail sheet (photo, role, note, photos count, added date).
//  All edits (add person, toggle, delete, settings, 🧪 test) stay on the web —
//  footer escape hatch opens /agent/known-people.
//  Carried lessons: lenient decoding (try? per field), cancellation-safe refresh,
//  auth-expired card, ONE loading shimmer set — never a global overlay.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum KnownPeoplePalette {
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

    /// One tint per registry role — owner gold, staff emerald, family violet.
    static func role(_ role: String) -> Color {
        switch role {
        case "owner": return coral
        case "staff": return emerald600
        case "family": return AlmaSwiftTheme.violet
        default: return .secondary
        }
    }
}

// MARK: - Models (same field names the web page types declare — lenient decode)

struct KnownPersonItem: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let role: String
    let photoPaths: [String]
    let active: Bool
    let note: String?
    let createdAt: String?

    private enum Keys: String, CodingKey {
        case id, name, role, photoPaths, active, note, createdAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        role = (try? c.decode(String.self, forKey: .role)) ?? "staff"
        photoPaths = (try? c.decode([String].self, forKey: .photoPaths)) ?? []
        active = (try? c.decode(Bool.self, forKey: .active)) ?? true
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }

    static func == (a: KnownPersonItem, b: KnownPersonItem) -> Bool {
        a.id == b.id && a.active == b.active
    }

    /// Same table the web ROLES constant declares — Bangla labels verbatim.
    var roleLabelBn: String {
        switch role {
        case "owner": return "মালিক"
        case "staff": return "স্টাফ"
        case "family": return "পরিবার"
        case "other": return "অন্যান্য"
        default: return role
        }
    }
}

struct KnownPeopleSettings: Decodable, Equatable {
    let enabled: Bool
    let deviceId: String
    let startHm: String
    let endHm: String
    let cooldownMin: Int?

    private enum Keys: String, CodingKey { case enabled, deviceId, startHm, endHm, cooldownMin }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? false
        deviceId = (try? c.decode(String.self, forKey: .deviceId)) ?? ""
        startHm = (try? c.decode(String.self, forKey: .startHm)) ?? "00:00"
        endHm = (try? c.decode(String.self, forKey: .endHm)) ?? "23:59"
        cooldownMin = Self.flexInt(c, .cooldownMin)
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

struct KnownPeopleCamera: Decodable, Equatable {
    let deviceId: String
    let channelId: String?
    let channelName: String?

    private enum Keys: String, CodingKey { case deviceId, channelId, channelName }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        deviceId = (try? c.decode(String.self, forKey: .deviceId)) ?? ""
        channelId = try? c.decodeIfPresent(String.self, forKey: .channelId)
        channelName = try? c.decodeIfPresent(String.self, forKey: .channelName)
    }
}

/// GET /api/assistant/known-people answers flat ({ people, thumbs, settings }), but
/// decode a `{ ok, data: {…} }` wrapper too, matching the app's defensive habit.
struct KnownPeopleListResponse: Decodable {
    let people: [KnownPersonItem]
    let thumbs: [String: String]
    let settings: KnownPeopleSettings?

    private enum Keys: String, CodingKey { case ok, data, people, thumbs, settings }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        people = (try? c.decode([KnownPersonItem].self, forKey: .people)) ?? []
        thumbs = (try? c.decode([String: String].self, forKey: .thumbs)) ?? [:]
        settings = try? c.decodeIfPresent(KnownPeopleSettings.self, forKey: .settings)
    }
}

struct KnownPeopleCamerasResponse: Decodable {
    let cameras: [KnownPeopleCamera]
    let workRoomDeviceId: String?

    private enum Keys: String, CodingKey { case ok, data, cameras, workRoomDeviceId }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        cameras = (try? c.decode([KnownPeopleCamera].self, forKey: .cameras)) ?? []
        workRoomDeviceId = try? c.decodeIfPresent(String.self, forKey: .workRoomDeviceId)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class KnownPeopleVM {
    var people: [KnownPersonItem] = []
    var thumbs: [String: String] = [:]
    var settings: KnownPeopleSettings? = nil
    var cameras: [KnownPeopleCamera] = []
    var workRoomDeviceId: String? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    // Search + role filter (native additions; the web list has neither).
    var search = ""
    var roleFilter = "all"        // all | owner | staff | family | other

    var filtered: [KnownPersonItem] {
        people.filter { p in
            (roleFilter == "all" || p.role == roleFilter) &&
            (search.isEmpty
                || p.name.localizedCaseInsensitiveContains(search)
                || p.roleLabelBn.contains(search)
                || p.role.localizedCaseInsensitiveContains(search))
        }
    }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            // Same two fetches the web page fires on mount; cameras is best-effort
            // there (`.catch(() => {})`), so a cameras failure never fails the screen.
            async let listTask: KnownPeopleListResponse =
                AlmaAPI.shared.get("/api/assistant/known-people")
            async let camerasTask: KnownPeopleCamerasResponse? = Self.optionalCameras()
            let resp = try await listTask
            people = resp.people
            thumbs = resp.thumbs
            settings = resp.settings
            if let cams = await camerasTask {
                cameras = cams.cameras
                workRoomDeviceId = cams.workRoomDeviceId
            }
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = "লোড করা যায়নি — নেটওয়ার্ক সমস্যা"
        }
    }

    private static func optionalCameras() async -> KnownPeopleCamerasResponse? {
        try? await AlmaAPI.shared.get("/api/assistant/known-people/cameras")
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    /// Camera dropdown text the web builds: channelName || deviceId, plus the
    /// "(Work Room — বর্তমান)" suffix on the owner's work-room device.
    func cameraLabel(_ deviceId: String) -> String {
        guard !deviceId.isEmpty else { return "— বাছাই করুন —" }
        let cam = cameras.first { $0.deviceId == deviceId }
        var label = (cam?.channelName?.isEmpty == false ? cam!.channelName! : deviceId)
        if deviceId == workRoomDeviceId { label += " (Work Room — বর্তমান)" }
        return label
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct KnownPeopleScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = KnownPeopleVM()
    @State private var selected: KnownPersonItem? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                header
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                settingsCard
                searchBar
                roleChips
                if vm.loading && vm.people.isEmpty { loadingRows }
                peopleList
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(KnownPeopleAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { person in
            KnownPersonDetailSheet(
                person: person,
                thumbURL: vm.thumbs[person.id],
                openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Header (web AgentSubHeader parity) ──

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            (Text("চেনা ").font(.title3.weight(.bold))
             + Text("মুখ").font(.title3.weight(.bold))
                .foregroundStyle(KnownPeoplePalette.accentText(colorScheme)))
            Text("এন্ট্রান্স ক্যামেরা • কে ঢুকলো-বের হলো • অপরিচিত অ্যালার্ট")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    // ── Entrance-watch settings (read-only digest of the web's settings card) ──

    @ViewBuilder private var settingsCard: some View {
        if let s = vm.settings {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("🚪 এন্ট্রান্স ক্যামেরা").font(.subheadline.weight(.bold))
                    Spacer()
                    // Web toggle button text verbatim — shown as a status capsule here.
                    Text(s.enabled ? "ON ✅" : "OFF ⛔")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(s.enabled ? KnownPeoplePalette.emerald600 : KnownPeoplePalette.red500)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background((s.enabled ? KnownPeoplePalette.emerald600 : KnownPeoplePalette.red500).opacity(0.12),
                                    in: Capsule())
                        .overlay(Capsule().strokeBorder(
                            (s.enabled ? KnownPeoplePalette.emerald600 : KnownPeoplePalette.red500).opacity(0.35),
                            lineWidth: 1))
                }
                settingsRow("ক্যামেরা", vm.cameraLabel(s.deviceId))
                HStack(alignment: .top, spacing: 14) {
                    settingsRow("শুরু", s.startHm)
                    settingsRow("শেষ", s.endHm)
                    settingsRow("কুলডাউন (মিনিট)", s.cooldownMin.map { "\($0)" } ?? "—")
                }
                Text("ওয়াচ চালু/বন্ধ, ক্যামেরা বদল আর 🧪 টেস্ট — ওয়েবে")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .knownPeopleGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        } else if !vm.loading && !vm.authExpired && vm.error == nil {
            Text("সেটিংস লোড হয়নি")
                .font(.footnote).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .knownPeopleGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    private func settingsRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.semibold))
        }
    }

    // ── Search + role chips (iOS Contacts feel) ──

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.footnote).foregroundStyle(.secondary)
            TextField("নাম খুঁজুন", text: $vm.search)
                .font(.subheadline)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !vm.search.isEmpty {
                Button {
                    vm.search = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .knownPeopleGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var roleChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                knownPeopleChip("সব", active: vm.roleFilter == "all") { vm.roleFilter = "all" }
                // Web ROLES table — Bangla labels verbatim.
                knownPeopleChip("মালিক", active: vm.roleFilter == "owner") { vm.roleFilter = "owner" }
                knownPeopleChip("স্টাফ", active: vm.roleFilter == "staff") { vm.roleFilter = "staff" }
                knownPeopleChip("পরিবার", active: vm.roleFilter == "family") { vm.roleFilter = "family" }
                knownPeopleChip("অন্যান্য", active: vm.roleFilter == "other") { vm.roleFilter = "other" }
            }
            .padding(.horizontal, 2)
        }
    }

    /// The web's accent chip (gold variant) on the app's glass surface.
    private func knownPeopleChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? KnownPeoplePalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? KnownPeoplePalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? KnownPeoplePalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── People list (web "👥 চেনা মানুষের তালিকা" card, Contacts-style rows) ──

    @ViewBuilder private var peopleList: some View {
        if !vm.loading || !vm.people.isEmpty {
            Text("👥 চেনা মানুষের তালিকা (\(vm.filtered.count))")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 2)
        }
        ForEach(vm.filtered) { person in
            KnownPersonRow(person: person, thumbURL: vm.thumbs[person.id]) {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                selected = person
            }
        }
        if !vm.loading && vm.people.isEmpty && vm.error == nil && !vm.authExpired {
            // Web empty-state string verbatim.
            VStack(spacing: 6) {
                Text("👤").font(.largeTitle)
                Text("এখনো কেউ যোগ হয়নি। আপনার আর স্টাফদের ছবি যোগ করুন — তাহলে ক্যামেরা চেনা মুখ আলাদা করতে পারবে।")
                    .font(.footnote).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 30)
            .padding(.horizontal, 10)
        } else if !vm.loading && !vm.people.isEmpty && vm.filtered.isEmpty {
            Text("কিছু পাওয়া যায়নি")
                .font(.footnote).foregroundStyle(.secondary)
                .padding(.top, 24)
        }
    }

    // ── Shared bits ──

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(KnownPeoplePalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).knownPeopleGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .knownPeopleGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<5, id: \.self) { _ in
            Color.clear.frame(height: 68)
                .knownPeopleGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .knownPeopleShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/agent/known-people", "Known people")
        } label: {
            Label("যোগ/এডিট/টেস্ট — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Person row (iOS Contacts feel: avatar · name · role capsule · state)

@available(iOS 17.0, *)
private struct KnownPersonRow: View {
    let person: KnownPersonItem
    let thumbURL: String?
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 12) {
            KnownPersonAvatar(person: person, thumbURL: thumbURL, size: 46)
            VStack(alignment: .leading, spacing: 2) {
                Text(person.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                // Web sub-line parity: role label • Nটা ছবি
                Text("\(person.roleLabelBn) • \(person.photoPaths.count)টা ছবি")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            roleCapsule
            if !person.active {
                Text("OFF")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(KnownPeoplePalette.red500)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(KnownPeoplePalette.red500.opacity(0.12), in: Capsule())
            }
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .knownPeopleGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture(perform: onTap)
        .opacity(person.active ? 1 : 0.6)
    }

    private var roleCapsule: some View {
        let tint = KnownPeoplePalette.role(person.role)
        return Text(person.roleLabelBn)
            .font(.caption2.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Avatar (signed thumb URL when the registry has a photo, initials otherwise)

@available(iOS 17.0, *)
private struct KnownPersonAvatar: View {
    let person: KnownPersonItem
    let thumbURL: String?
    let size: CGFloat
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if let thumbURL, let url = URL(string: thumbURL) {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        initialsCircle
                    }
                }
            } else {
                initialsCircle
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(KnownPeoplePalette.coral.opacity(0.35), lineWidth: 1))
    }

    private var initialsCircle: some View {
        ZStack {
            Circle().fill(KnownPeoplePalette.coral.opacity(0.16))
            Text(KnownPeopleFormat.initials(person.name))
                .font(.system(size: size * 0.36, weight: .bold))
                .foregroundStyle(KnownPeoplePalette.accentText(colorScheme))
        }
    }
}

// MARK: - Detail sheet (read-only person card; edits stay on the web)

@available(iOS 17.0, *)
private struct KnownPersonDetailSheet: View {
    let person: KnownPersonItem
    let thumbURL: String?
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                headerCard
                infoCard
                webLink
            }
            .padding(18)
        }
        .presentationBackground { KnownPeopleAurora() }
    }

    private var headerCard: some View {
        HStack(spacing: 14) {
            KnownPersonAvatar(person: person, thumbURL: thumbURL, size: 64)
            VStack(alignment: .leading, spacing: 4) {
                Text(person.name).font(.headline)
                HStack(spacing: 6) {
                    let tint = KnownPeoplePalette.role(person.role)
                    Text(person.roleLabelBn)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(tint)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(tint.opacity(0.12), in: Capsule())
                        .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
                    Text(person.active ? "ON" : "OFF")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(person.active ? KnownPeoplePalette.green400 : KnownPeoplePalette.red500)
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background((person.active ? KnownPeoplePalette.emerald600 : KnownPeoplePalette.red500).opacity(0.12),
                                    in: Capsule())
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .knownPeopleGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var infoCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow("রেফারেন্স ছবি", "\(person.photoPaths.count)টা ছবি")
            if let note = person.note, !note.isEmpty {
                infoRow("নোট", note)
            }
            if let added = KnownPeopleFormat.dateTime(person.createdAt) {
                infoRow("যোগ হয়েছে", added)
            }
            Text(person.active
                 ? "এন্ট্রান্স ওয়াচ এই মুখটা চেনে — দেখা গেলে অ্যালার্টে নাম আসবে।"
                 : "এই মুখটা এখন OFF — ম্যাচিংয়ে ধরা হবে না।")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .knownPeopleGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.semibold))
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/agent/known-people", "Known people")
        } label: {
            Label("এডিট/ছবি বদল/মুছুন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Formatting helpers

private enum KnownPeopleFormat {
    /// createdAt → "5/7/2026, 8:50 PM" style (web: new Date(...).toLocaleString()).
    static func dateTime(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
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

    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (KnownPeople-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct KnownPeopleAurora: View {
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
    func knownPeopleGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct KnownPeopleShimmer: ViewModifier {
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
    func knownPeopleShimmer() -> some View { modifier(KnownPeopleShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Known people — Light") {
    KnownPeopleScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
