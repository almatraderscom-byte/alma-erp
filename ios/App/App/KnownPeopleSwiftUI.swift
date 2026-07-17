//
//  KnownPeopleSwiftUI.swift
//  ALMA ERP — the agent's "চেনা মুখ" page (camera face registry + entrance watch)
//  as a native SwiftUI screen with FULL ACTION PARITY (NP-0 header refresh 2026-07-17).
//
//  Mirrors the web /agent/known-people page (KnownPeopleManager) — same endpoints,
//  same Bangla labels, same blocks:
//    GET /api/assistant/known-people          → { people, thumbs, settings, maxPhotos }
//    GET /api/assistant/known-people/cameras  → { cameras, workRoomDeviceId }
//  Blocks: entrance-watch settings card (read-only digest) · search · role chips ·
//  Contacts-style people rows (photo/initials avatar + role capsule + active state) ·
//  person detail sheet (photo, role, note, photos count, added date).
//  NATIVE WRITES (verified 2026-07-17): entrance-watch settings save (POST …/settings),
//  add person (POST), edit person/photos (PATCH), active toggle (PATCH), delete
//  (DELETE), and 🧪 test (POST …/test). No web escape needed for edits.
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

    // ── Native writes (owner 2026-07-11) — web KnownPeopleManager parity. ──

    var toast: String? = nil
    var busy = false

    private struct SettingsBody: Encodable {
        let deviceId: String, enabled: Bool, startHm: String, endHm: String, cooldownMin: Int
    }
    /// The API expects photo OBJECTS with RAW base64 (`{base64, mimeType}`) — a
    /// data-URL string array silently matched nothing server-side and every native
    /// add failed with "at least one photo required" (owner report 2026-07-12).
    struct PhotoBody: Encodable { let base64: String, mimeType: String }
    private struct AddBody: Encodable { let name: String, role: String, photos: [PhotoBody] }
    private struct ActiveBody: Encodable { let active: Bool }
    private struct WriteResponse: Decodable { let ok: Bool?, error: String? }

    /// Web saveSettings — patch merges over current settings.
    func saveSettings(deviceId: String? = nil, enabled: Bool? = nil,
                      startHm: String? = nil, endHm: String? = nil,
                      cooldownMin: Int? = nil) async -> Bool {
        guard let s = settings else { return false }
        busy = true
        defer { busy = false }
        do {
            let res: WriteResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/known-people/settings",
                body: SettingsBody(deviceId: deviceId ?? s.deviceId,
                                   enabled: enabled ?? s.enabled,
                                   startHm: startHm ?? s.startHm,
                                   endHm: endHm ?? s.endHm,
                                   cooldownMin: cooldownMin ?? s.cooldownMin ?? 30))
            if let err = res.error { toast = err; return false }
            toast = "✅ সেটিংস সেভ হয়েছে"
            await load()
            return true
        } catch {
            toast = "সেভ হয়নি — নেটওয়ার্ক সমস্যা"
            return false
        }
    }

    /// Web addPerson — ≤3 small base64 photos (data-URL prefix like fileToSmallBase64).
    func addPerson(name: String, role: String, photos: [Data]) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            let encoded = photos.prefix(3).map {
                PhotoBody(base64: $0.base64EncodedString(), mimeType: "image/jpeg")
            }
            let res: WriteResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/known-people",
                body: AddBody(name: name, role: role, photos: encoded))
            if let err = res.error { toast = "⚠️ \(err)"; return false }
            toast = "✅ \(name) যোগ হয়েছে"
            await load()
            return true
        } catch {
            toast = "⚠️ যোগ করা যায়নি — আবার চেষ্টা করুন"
            return false
        }
    }

    /// Native edit (owner 2026-07-12 — no more "ওয়েবে খুলুন"): PATCH name/role.
    func updatePerson(_ p: KnownPersonItem, name: String, role: String) async -> Bool {
        busy = true
        defer { busy = false }
        struct EditBody: Encodable { let name: String, role: String }
        do {
            let res: WriteResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/known-people/\(p.id)",
                body: EditBody(name: name, role: role))
            if let err = res.error { toast = "⚠️ \(err)"; return false }
            toast = "✅ সেভ হয়েছে"
            await load()
            return true
        } catch {
            toast = "⚠️ সেভ হয়নি — নেটওয়ার্ক সমস্যা"
            return false
        }
    }

    /// Swap ALL reference photos (server replacePhotos — same PhotoBody format).
    func replacePhotos(_ p: KnownPersonItem, photos: [Data]) async -> Bool {
        busy = true
        defer { busy = false }
        struct ReplaceBody: Encodable { let replacePhotos: [PhotoBody] }
        do {
            let encoded = photos.prefix(3).map {
                PhotoBody(base64: $0.base64EncodedString(), mimeType: "image/jpeg")
            }
            let res: WriteResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/known-people/\(p.id)",
                body: ReplaceBody(replacePhotos: encoded))
            if let err = res.error { toast = "⚠️ \(err)"; return false }
            toast = "✅ ছবি বদলে দেওয়া হয়েছে"
            await load()
            return true
        } catch {
            toast = "⚠️ ছবি বদলানো যায়নি — নেটওয়ার্ক সমস্যা"
            return false
        }
    }

    func toggleActive(_ p: KnownPersonItem) async {
        busy = true
        defer { busy = false }
        struct Resp: Decodable { let ok: Bool? }
        let _: Resp? = try? await AlmaAPI.shared.send(
            "PATCH", "/api/assistant/known-people/\(p.id)", body: ActiveBody(active: !p.active))
        await load()
    }

    func removePerson(_ p: KnownPersonItem) async {
        busy = true
        defer { busy = false }
        struct Resp: Decodable { let ok: Bool? }
        let _: Resp? = try? await AlmaAPI.shared.send(
            "DELETE", "/api/assistant/known-people/\(p.id)")
        toast = "\(p.name) মুছে ফেলা হয়েছে"
        await load()
    }

    /// Web runTest — 🧪 live camera check, result rendered as a toast digest.
    func runTest() async {
        struct TestResp: Decodable {
            let ran: Bool?, error: String?
            let matched: Bool?, name: String?
        }
        busy = true
        defer { busy = false }
        struct Empty: Encodable {}
        do {
            let res: TestResp = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/known-people/test", body: Empty())
            if let err = res.error {
                toast = "🧪 টেস্ট ব্যর্থ: \(err)"
            } else if res.matched == true {
                toast = "🧪 চিনেছে: \(res.name ?? "কেউ একজন")"
            } else {
                toast = res.ran == true ? "🧪 টেস্ট চলল — কাউকে চেনেনি" : "🧪 টেস্ট চালানো যায়নি"
            }
        } catch {
            toast = "🧪 টেস্ট ব্যর্থ — নেটওয়ার্ক সমস্যা"
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct KnownPeopleScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = KnownPeopleVM()
    @State private var selected: KnownPersonItem? = nil
    @State private var showAdd = false
    @State private var removing: KnownPersonItem? = nil
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
                vm: vm)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showAdd) { KnownPeopleAddSheet(vm: vm) }
        .confirmationDialog(
            "\(removing?.name ?? "")-কে মুছে ফেলবেন?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible
        ) {
            Button("হ্যাঁ, মুছুন", role: .destructive) {
                if let p = removing { Task { await vm.removePerson(p) } }
                removing = nil
            }
            Button("বাতিল", role: .cancel) { removing = nil }
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
                    // Native watch toggle (owner 2026-07-11) — web saveSettings parity.
                    Toggle("", isOn: Binding(
                        get: { s.enabled },
                        set: { on in Task { _ = await vm.saveSettings(enabled: on) } }))
                        .labelsHidden()
                        .tint(KnownPeoplePalette.emerald600)
                }
                // Camera picker (web dropdown parity).
                Menu {
                    ForEach(vm.cameras, id: \.deviceId) { cam in
                        Button(vm.cameraLabel(cam.deviceId)) {
                            Task { _ = await vm.saveSettings(deviceId: cam.deviceId) }
                        }
                    }
                } label: {
                    settingsRow("ক্যামেরা", vm.cameraLabel(s.deviceId))
                }
                .buttonStyle(.plain)
                HStack(alignment: .top, spacing: 14) {
                    settingsRow("শুরু", s.startHm)
                    settingsRow("শেষ", s.endHm)
                    // Cooldown stepper (web number input parity).
                    VStack(alignment: .leading, spacing: 2) {
                        Text("কুলডাউন (মিনিট)").font(.caption2).foregroundStyle(.secondary)
                        HStack(spacing: 8) {
                            Text(s.cooldownMin.map { "\($0)" } ?? "—")
                                .font(.footnote.weight(.semibold)).monospacedDigit()
                            Stepper("", value: Binding(
                                get: { s.cooldownMin ?? 30 },
                                set: { v in Task { _ = await vm.saveSettings(cooldownMin: max(1, v)) } }),
                                in: 1...240)
                                .labelsHidden()
                                .scaleEffect(0.75, anchor: .leading)
                        }
                    }
                }
                HStack(spacing: 8) {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        Task { await vm.runTest() }
                    } label: {
                        HStack(spacing: 4) {
                            if vm.busy { ProgressView().controlSize(.mini) }
                            Text("🧪 লাইভ টেস্ট").font(.caption.weight(.bold))
                        }
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Color.primary.opacity(0.06), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.busy)
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        showAdd = true
                    } label: {
                        Text("+ নতুন মুখ").font(.caption.weight(.bold))
                            .foregroundStyle(KnownPeoplePalette.accentText(colorScheme))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(KnownPeoplePalette.coral.opacity(0.12), in: Capsule())
                            .overlay(Capsule().strokeBorder(KnownPeoplePalette.coral.opacity(0.3), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
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
            .contextMenu {
                Button {
                    Task { await vm.toggleActive(person) }
                } label: {
                    Label(person.active ? "Inactive করুন" : "Active করুন",
                          systemImage: person.active ? "pause.circle" : "play.circle")
                }
                Button(role: .destructive) {
                    removing = person
                } label: {
                    Label("মুছে ফেলুন", systemImage: "trash")
                }
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

// MARK: - Detail sheet — FULL native edit (owner 2026-07-12): name/role save,
// photo replace, delete. No more "ওয়েবে খুলুন" punt.

@available(iOS 17.0, *)
private struct KnownPersonDetailSheet: View {
    let person: KnownPersonItem
    let thumbURL: String?
    let vm: KnownPeopleVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var editName = ""
    @State private var editRole = "staff"
    @State private var pickedItems: [PhotosPickerItem] = []
    @State private var newPhotos: [Data] = []
    @State private var saving = false
    @State private var swapping = false
    @State private var confirmDelete = false
    @State private var feedback: String? = nil

    private static let roles: [(String, String)] = [
        ("মালিক", "owner"), ("স্টাফ", "staff"), ("পরিবার", "family"), ("অন্যান্য", "other"),
    ]

    private var dirty: Bool {
        editName.trimmingCharacters(in: .whitespaces) != person.name || editRole != person.role
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                headerCard
                infoCard
                editCard
                photoCard
                deleteButton
            }
            .padding(18)
        }
        .presentationBackground { KnownPeopleAurora() }
        .onAppear {
            editName = person.name
            editRole = person.role
        }
        .confirmationDialog("\(person.name)-কে মুছে ফেলবেন?",
                            isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("হ্যাঁ, মুছুন", role: .destructive) {
                Task {
                    await vm.removePerson(person)
                    dismiss()
                }
            }
            Button("থাক", role: .cancel) {}
        }
    }

    private var editCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("এডিট").font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            TextField("নাম", text: $editName)
                .font(.subheadline)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Color.primary.opacity(0.06),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            Picker("Role", selection: $editRole) {
                ForEach(Self.roles, id: \.1) { r in Text(r.0).tag(r.1) }
            }
            .pickerStyle(.segmented)
            Button {
                guard dirty, !saving else { return }
                saving = true
                Task {
                    defer { saving = false }
                    let ok = await vm.updatePerson(person,
                                                   name: editName.trimmingCharacters(in: .whitespaces),
                                                   role: editRole)
                    feedback = vm.toast
                    UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
                    if ok { dismiss() }
                }
            } label: {
                HStack(spacing: 8) {
                    if saving { ProgressView().tint(.white).controlSize(.small) }
                    Text(saving ? "সেভ হচ্ছে…" : "সেভ করুন").font(.footnote.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(dirty && !saving ? KnownPeoplePalette.coral : KnownPeoplePalette.coral.opacity(0.35),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!dirty || saving)
            if let feedback {
                Text(feedback).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .knownPeopleGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var photoCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("রেফারেন্স ছবি বদল").font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            PhotosPicker(selection: $pickedItems, maxSelectionCount: 3, matching: .images) {
                HStack(spacing: 8) {
                    Image(systemName: newPhotos.isEmpty ? "photo.badge.plus" : "checkmark.circle.fill")
                    Text(newPhotos.isEmpty ? "নতুন ১-৩টা পরিষ্কার মুখের ছবি বাছুন"
                                           : "\(newPhotos.count)টা ছবি বাছাই হয়েছে")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(newPhotos.isEmpty ? .secondary : KnownPeoplePalette.emerald600)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Color.primary.opacity(0.05),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            }
            .onChange(of: pickedItems) { _, items in
                Task { newPhotos = await KnownPeoplePhotoPrep.shrink(items) }
            }
            Button {
                guard !newPhotos.isEmpty, !swapping else { return }
                swapping = true
                Task {
                    defer { swapping = false }
                    let ok = await vm.replacePhotos(person, photos: newPhotos)
                    feedback = vm.toast
                    UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
                    if ok { dismiss() }
                }
            } label: {
                HStack(spacing: 8) {
                    if swapping { ProgressView().tint(.white).controlSize(.small) }
                    Text(swapping ? "বদলানো হচ্ছে…" : "ছবি বদলে দিন").font(.footnote.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(!newPhotos.isEmpty && !swapping
                            ? KnownPeoplePalette.emerald600 : KnownPeoplePalette.emerald600.opacity(0.35),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(newPhotos.isEmpty || swapping)
            Text("নতুন ছবি আগের সব রেফারেন্স ছবির জায়গা নেবে।")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .knownPeopleGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var deleteButton: some View {
        Button(role: .destructive) {
            confirmDelete = true
        } label: {
            Label("\(person.name)-কে মুছে ফেলুন", systemImage: "trash")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(KnownPeoplePalette.red500)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(KnownPeoplePalette.red500.opacity(0.1),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.top, 2)
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

// MARK: - Add person (owner 2026-07-11 — web addPerson parity: name + role + ≤3 photos
// as small base64 data-URLs, POST /api/assistant/known-people).

import PhotosUI

/// Shared picked-photo shrink (web fileToSmallBase64 parity): ≤640px JPEG q0.7.
@available(iOS 17.0, *)
enum KnownPeoplePhotoPrep {
    static func shrink(_ items: [PhotosPickerItem]) async -> [Data] {
        var loaded: [Data] = []
        for item in items.prefix(3) {
            if let data = try? await item.loadTransferable(type: Data.self),
               let ui = UIImage(data: data) {
                let side: CGFloat = 640
                let scale = min(1, side / max(ui.size.width, ui.size.height))
                let target = CGSize(width: ui.size.width * scale,
                                    height: ui.size.height * scale)
                let renderer = UIGraphicsImageRenderer(size: target)
                let small = renderer.image { _ in
                    ui.draw(in: CGRect(origin: .zero, size: target))
                }
                if let jpeg = small.jpegData(compressionQuality: 0.7) {
                    loaded.append(jpeg)
                }
            }
        }
        return loaded
    }
}

@available(iOS 17.0, *)
private struct KnownPeopleAddSheet: View {
    let vm: KnownPeopleVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    @State private var name = ""
    @State private var role = "staff"
    @State private var pickedItems: [PhotosPickerItem] = []
    @State private var photos: [Data] = []
    @State private var submitting = false
    @State private var errorText: String? = nil

    // Web ROLES verbatim.
    private static let roles: [(String, String)] = [
        ("মালিক", "owner"), ("স্টাফ", "staff"), ("পরিবার", "family"), ("অন্যান্য", "other"),
    ]

    private var canSubmit: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty && !photos.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("নতুন মুখ যোগ করুন").font(.subheadline.weight(.bold)).padding(.top, 20)
            TextField("নাম *", text: $name)
                .font(.subheadline)
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Color.primary.opacity(0.06),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            Picker("Role", selection: $role) {
                ForEach(Self.roles, id: \.1) { r in Text(r.0).tag(r.1) }
            }
            .pickerStyle(.segmented)
            PhotosPicker(selection: $pickedItems, maxSelectionCount: 3, matching: .images) {
                HStack(spacing: 8) {
                    Image(systemName: photos.isEmpty ? "photo.badge.plus" : "checkmark.circle.fill")
                    Text(photos.isEmpty ? "১-৩টা পরিষ্কার মুখের ছবি বাছুন *"
                                        : "\(photos.count)টা ছবি বাছাই হয়েছে")
                        .font(.caption.weight(.semibold))
                }
                .foregroundStyle(photos.isEmpty ? .secondary : KnownPeoplePalette.emerald600)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 12)
                .background(Color.primary.opacity(0.05),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            }
            .onChange(of: pickedItems) { _, items in
                Task { photos = await KnownPeoplePhotoPrep.shrink(items) }
            }
            if let errorText {
                Text(errorText).font(.caption2.weight(.semibold))
                    .foregroundStyle(KnownPeoplePalette.red500)
            }
            Button {
                submit()
            } label: {
                HStack(spacing: 8) {
                    if submitting { ProgressView().tint(.white) }
                    Text(submitting ? "সেভ হচ্ছে…" : "যোগ করুন").font(.subheadline.weight(.bold))
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(canSubmit && !submitting
                            ? KnownPeoplePalette.coral : KnownPeoplePalette.coral.opacity(0.4),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit || submitting)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .presentationDetents([.height(400)])
        .presentationDragIndicator(.visible)
        .background(AlmaSwiftTheme.rootBg(scheme))
    }

    private func submit() {
        guard canSubmit, !submitting else { return }
        submitting = true; errorText = nil
        Task {
            defer { submitting = false }
            let ok = await vm.addPerson(
                name: name.trimmingCharacters(in: .whitespaces), role: role, photos: photos)
            UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
            if ok { dismiss() } else { errorText = vm.toast }
        }
    }
}
