//
//  TaskSpotlightSwiftUI.swift
//  ALMA ERP — the Operations → Task Spotlight admin page as a native SwiftUI screen.
//
//  Mirrors the web /operations/task-spotlight page — same endpoints, same colours:
//    GET   /api/operational-tasks                    → admin task list (all businesses
//                                                      when business_id is omitted)
//    PATCH /api/operational-tasks/{id}  {action: "archive"}
//    PATCH /api/operational-tasks/{id}  {action: "resend", assignment_id}
//  Web-parity blocks: live task cards (priority badge · status · completion %) with
//  per-assignee rows (name — STATUS) · Archive · Resend spotlight. Native re-set as
//  Reminders-app-style rows: status circles, initials avatars, due badges (overdue
//  red / today amber), status filter chips, detail sheet. Task CREATION stays on the
//  web (footer escape hatch) — it needs the multi-employee picker + banner upload.
//  Carried lessons: ONE spinner per row, never a global overlay.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum TaskSpotlightPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Web: CRITICAL tone-red · HIGH tone-amber · else muted (bg-white/[0.06]).
    static func priority(_ p: String?) -> Color {
        switch p {
        case "CRITICAL": return red500
        case "HIGH": return amber600
        default: return .secondary
        }
    }

    /// Assignment status → Reminders-style circle tint.
    static func assignment(_ s: String?) -> Color {
        switch s {
        case "COMPLETED": return emerald600
        case "IN_PROGRESS": return amber500
        case "ACKNOWLEDGED": return goldLt
        case "EXPIRED": return red500
        default: return .secondary          // ACTIVE / ARCHIVED
        }
    }

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names listTasksForAdmin returns)

struct TaskSpotlightAssignment: Decodable, Identifiable, Equatable {
    let id: String
    let userId: String?
    let status: String?
    let acknowledgedAt: String?
    let startedAt: String?
    let completedAt: String?
    let lastSpotlightAt: String?
    let assigneeName: String?
    let assigneeEmail: String?

    private struct Assignee: Decodable {
        let name: String?
        let email: String?
    }
    private enum Keys: String, CodingKey {
        case id, userId, status, acknowledgedAt, startedAt, completedAt, lastSpotlightAt, assignee
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        userId = try? c.decodeIfPresent(String.self, forKey: .userId)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        acknowledgedAt = try? c.decodeIfPresent(String.self, forKey: .acknowledgedAt)
        startedAt = try? c.decodeIfPresent(String.self, forKey: .startedAt)
        completedAt = try? c.decodeIfPresent(String.self, forKey: .completedAt)
        lastSpotlightAt = try? c.decodeIfPresent(String.self, forKey: .lastSpotlightAt)
        let assignee = try? c.decodeIfPresent(Assignee.self, forKey: .assignee)
        assigneeName = assignee?.name
        assigneeEmail = assignee?.email
    }

    /// Web row: `{a.assignee?.name || a.userId}` — same fallback chain.
    var displayName: String { assigneeName ?? userId ?? "—" }

    static func == (a: TaskSpotlightAssignment, b: TaskSpotlightAssignment) -> Bool {
        a.id == b.id && a.status == b.status
    }
}

struct TaskSpotlightTask: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let description: String?
    let priority: String?
    var status: String                       // ACTIVE | ARCHIVED
    let deadline: String?
    let bannerImageUrl: String?
    let acknowledgmentRequired: Bool?
    let allowDismiss: Bool?
    let createdAt: String?
    let createdByName: String?
    let stats: Stats
    let assignments: [TaskSpotlightAssignment]

    struct Stats: Decodable, Equatable {
        let assigned: Int
        let completed: Int
        let acknowledged: Int
        let completionRate: Int

        private enum Keys: String, CodingKey { case assigned, completed, acknowledged, completionRate }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            assigned = Self.flexInt(c, .assigned) ?? 0
            completed = Self.flexInt(c, .completed) ?? 0
            acknowledged = Self.flexInt(c, .acknowledged) ?? 0
            completionRate = Self.flexInt(c, .completionRate) ?? 0
        }
        init() { assigned = 0; completed = 0; acknowledged = 0; completionRate = 0 }
        private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
            if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
            if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
            if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
            return nil
        }
    }

    private struct CreatedBy: Decodable {
        let name: String?
    }
    private enum Keys: String, CodingKey {
        case id, title, description, priority, status, deadline, bannerImageUrl
        case acknowledgmentRequired, allowDismiss, createdAt, createdBy, stats, assignments
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        title = (try? c.decode(String.self, forKey: .title)) ?? "—"
        description = try? c.decodeIfPresent(String.self, forKey: .description)
        priority = try? c.decodeIfPresent(String.self, forKey: .priority)
        status = (try? c.decode(String.self, forKey: .status)) ?? "ACTIVE"
        deadline = try? c.decodeIfPresent(String.self, forKey: .deadline)
        bannerImageUrl = try? c.decodeIfPresent(String.self, forKey: .bannerImageUrl)
        acknowledgmentRequired = try? c.decodeIfPresent(Bool.self, forKey: .acknowledgmentRequired)
        allowDismiss = try? c.decodeIfPresent(Bool.self, forKey: .allowDismiss)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        createdByName = (try? c.decodeIfPresent(CreatedBy.self, forKey: .createdBy))?.name
        stats = (try? c.decode(Stats.self, forKey: .stats)) ?? Stats()
        assignments = (try? c.decode([TaskSpotlightAssignment].self, forKey: .assignments)) ?? []
    }

    var isDone: Bool { stats.assigned > 0 && stats.completed >= stats.assigned }
    var isOverdue: Bool {
        guard status == "ACTIVE", !isDone,
              let d = TaskSpotlightFormat.parse(deadline) else { return false }
        return d < Date()
    }
    var isDueToday: Bool {
        guard let d = TaskSpotlightFormat.parse(deadline) else { return false }
        return TaskSpotlightFormat.dhakaCalendar.isDate(d, inSameDayAs: Date())
    }

    static func == (a: TaskSpotlightTask, b: TaskSpotlightTask) -> Bool {
        a.id == b.id && a.status == b.status && a.stats == b.stats && a.assignments == b.assignments
    }
}

/// operational-tasks routes wrap payloads via apiDataSuccess → `{ ok, data: {…} }`
/// — decode both the wrapped and flat shapes (same lesson as approvals).
struct TaskSpotlightListResponse: Decodable {
    let tasks: [TaskSpotlightTask]

    private enum Keys: String, CodingKey { case ok, data, tasks }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        tasks = (try? c.decode([TaskSpotlightTask].self, forKey: .tasks)) ?? []
    }
}

struct TaskSpotlightActionResponse: Decodable {
    let archived: Bool?
    let resent: Bool?

    private enum Keys: String, CodingKey { case ok, data, archived, resent }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        archived = try? c.decodeIfPresent(Bool.self, forKey: .archived)
        resent = try? c.decodeIfPresent(Bool.self, forKey: .resent)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
@MainActor
final class TaskSpotlightVM {
    var tasks: [TaskSpotlightTask] = []
    var statusFilter = "ACTIVE"              // ACTIVE | ARCHIVED | ALL (client-side)
    var loading = false
    var busyTaskIds: Set<String> = []        // per-card archive spinner
    var busyAssignmentIds: Set<String> = []  // per-row resend spinner
    var error: String? = nil
    var notice: String? = nil                // the web's toast line
    var authExpired = false

    var filtered: [TaskSpotlightTask] {
        switch statusFilter {
        case "ALL": return tasks
        default: return tasks.filter { $0.status == statusFilter }
        }
    }
    var activeCount: Int { tasks.filter { $0.status == "ACTIVE" }.count }
    var overdueCount: Int { tasks.filter { $0.isOverdue }.count }
    var doneCount: Int { tasks.filter { $0.status == "ACTIVE" && $0.isDone }.count }

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            // business_id omitted on purpose — listTasksForAdmin(null) returns every
            // business's tasks, which is what the owner wants on one native screen.
            let resp: TaskSpotlightListResponse = try await AlmaAPI.shared.get("/api/operational-tasks")
            tasks = resp.tasks
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

    // ── NP-7 (OP-03): native task creation — the web createTask payload verbatim ──

    struct AssigneeOption: Decodable, Identifiable {
        let id: String
        let name: String
        private enum Keys: String, CodingKey { case id, name }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
            name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "—"
        }
    }

    var assignees: [AssigneeOption] = []
    var creating = false

    func loadAssignees(businessId: String = "ALMA_LIFESTYLE") async {
        struct Resp: Decodable {
            let users: [AssigneeOption]
            private enum Keys: String, CodingKey { case ok, data, users, assignees }
            init(from decoder: Decoder) throws {
                let root = try decoder.container(keyedBy: Keys.self)
                let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
                users = (try? c.decodeIfPresent([AssigneeOption].self, forKey: .users))
                    ?? (try? c.decodeIfPresent([AssigneeOption].self, forKey: .assignees)) ?? []
            }
        }
        if let r: Resp = try? await AlmaAPI.shared.get(
            "/api/operational-tasks/assignees", query: ["business_id": businessId]) {
            assignees = r.users
        }
    }

    /// POST /api/operational-tasks — web createTask body verbatim.
    func createTask(title: String, description: String, priority: String,
                    deadline: String, bannerUrl: String, ackRequired: Bool,
                    allowDismiss: Bool, assigneeIds: [String],
                    businessId: String = "ALMA_LIFESTYLE") async -> Bool {
        guard !creating, !title.isEmpty, !description.isEmpty, !assigneeIds.isEmpty else {
            error = "Title, description, and at least one assignee required"
            return false
        }
        creating = true
        defer { creating = false }
        struct Body: Encodable {
            let title: String
            let description: String
            let priority: String
            let deadline: String?
            let banner_image_url: String?
            let acknowledgment_required: Bool
            let allow_dismiss: Bool
            let business_id: String
            let assignee_user_ids: [String]
        }
        struct Resp: Decodable { let ok: Bool?; let error: String? }
        do {
            let _: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/operational-tasks",
                body: Body(title: title, description: description, priority: priority,
                           deadline: deadline.isEmpty ? nil : deadline,
                           banner_image_url: bannerUrl.isEmpty ? nil : bannerUrl,
                           acknowledgment_required: ackRequired, allow_dismiss: allowDismiss,
                           business_id: businessId, assignee_user_ids: assigneeIds))
            notice = "Task spotlight published"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load()
            return true
        } catch {
            self.error = "Create ব্যর্থ: \(error.localizedDescription)"
            return false
        }
    }

    /// PATCH {action: "archive"} — same body the web archiveTask sends.
    func archive(_ task: TaskSpotlightTask) async {
        guard !busyTaskIds.contains(task.id) else { return }
        busyTaskIds.insert(task.id)
        notice = nil
        defer { busyTaskIds.remove(task.id) }
        do {
            let _: TaskSpotlightActionResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/operational-tasks/\(task.id)", body: ["action": "archive"])
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "Task archived"                    // web toast verbatim
            await load()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
        }
    }

    /// PATCH {action: "resend", assignment_id} — resets one employee's spotlight.
    func resend(taskId: String, assignmentId: String) async {
        guard !busyAssignmentIds.contains(assignmentId) else { return }
        busyAssignmentIds.insert(assignmentId)
        notice = nil
        defer { busyAssignmentIds.remove(assignmentId) }
        do {
            let _: TaskSpotlightActionResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/operational-tasks/\(taskId)",
                body: ["action": "resend", "assignment_id": assignmentId])
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "Spotlight reset — employee will see on next Start Work"   // web toast verbatim
            await load()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct TaskSpotlightScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = TaskSpotlightVM()
    @State private var selected: TaskSpotlightTask? = nil
    @State private var archiving: TaskSpotlightTask? = nil
    @State private var showCreate = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if let ok = vm.notice { noticeCard(ok, tone: .success) }
                statusChips
                kpiStrip
                if vm.loading && vm.tasks.isEmpty { loadingRows }
                ForEach(vm.filtered) { task in
                    TaskSpotlightCard(
                        task: task,
                        busy: vm.busyTaskIds.contains(task.id),
                        onTap: { selected = task },
                        onArchive: { archiving = task })
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
        .background(TaskSpotlightAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { task in
            TaskSpotlightDetailSheet(
                task: task, vm: vm,
                onArchive: { selected = nil; archiving = task },
                openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            "টাস্কটি আর্কাইভ করবেন?",
            isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil } }),
            titleVisibility: .visible,
            presenting: archiving
        ) { task in
            Button("Archive", role: .destructive) {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                Task { await vm.archive(task) }
            }
            Button("বাতিল", role: .cancel) {}
        } message: { task in
            Text("\(task.title) — সব অসম্পূর্ণ অ্যাসাইনমেন্টও আর্কাইভ হবে।")
        }
    }

    /// Status filter chips — ACTIVE / ARCHIVED / ALL, client-side (the admin API
    /// returns everything in one call).
    private var statusChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(["ACTIVE", "ARCHIVED", "ALL"], id: \.self) { s in
                    spotlightChip(s == "ALL" ? "All" : s.capitalized, active: vm.statusFilter == s) {
                        vm.statusFilter = s
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .padding(.top, 4)
    }

    /// Small KPI strip: live tasks · overdue · fully-done — the numbers the web page
    /// makes the owner compute by eye from the "Live tasks" list.
    private var kpiStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("ACTIVE", vm.activeCount, TaskSpotlightPalette.goldLt)
                kpiCard("OVERDUE", vm.overdueCount, TaskSpotlightPalette.red500)
                kpiCard("DONE", vm.doneCount, TaskSpotlightPalette.emerald600)
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
        .taskSpotlightGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "checklist").font(.largeTitle).foregroundStyle(.secondary)
            Text(vm.statusFilter == "ACTIVE" ? "কোনো চলমান টাস্ক নেই" : "কিছু নেই")
                .foregroundStyle(.secondary)
            Text("নতুন Task Spotlight তৈরি করতে ওয়েব পেজটি ব্যবহার করুন।")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 70)
        .padding(.bottom, 30)
    }

    // ── Shared bits ──

    private func spotlightChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? TaskSpotlightPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? TaskSpotlightPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? TaskSpotlightPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, success }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", TaskSpotlightPalette.red500)
        case .success: ("checkmark.circle", TaskSpotlightPalette.emerald600)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).taskSpotlightGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .taskSpotlightGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 110)
                .taskSpotlightGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .taskSpotlightShimmer()
        }
    }

    /// NP-7 (OP-03): task creation runs natively.
    private var webEscape: some View {
        Button {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            showCreate = true
        } label: {
            Label("✨ নতুন Task Spotlight তৈরি করুন", systemImage: "plus.circle")
                .font(.footnote.weight(.bold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(TaskSpotlightPalette.coral.opacity(0.12), in: Capsule())
                .foregroundStyle(TaskSpotlightPalette.coral)
                .overlay(Capsule().strokeBorder(TaskSpotlightPalette.coral.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .padding(.vertical, 6)
        .sheet(isPresented: $showCreate) {
            TaskSpotlightCreateSheet(vm: vm) { showCreate = false }
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }
}

// MARK: - NP-7 (OP-03): create sheet (web form parity)

@available(iOS 17.0, *)
private struct TaskSpotlightCreateSheet: View {
    let vm: TaskSpotlightVM
    let onDone: () -> Void
    @State private var title = ""
    @State private var descriptionText = ""
    @State private var priority = "NORMAL"
    @State private var deadline = ""
    @State private var bannerUrl = ""
    @State private var ackRequired = true
    @State private var allowDismiss = false
    @State private var assigneeIds: Set<String> = []

    var body: some View {
        NavigationStack {
            Form {
                Section("টাস্ক") {
                    TextField("Title", text: $title)
                    TextField("Description", text: $descriptionText, axis: .vertical).lineLimit(3...6)
                    Picker("Priority", selection: $priority) {
                        Text("Normal").tag("NORMAL")
                        Text("High").tag("HIGH")
                        Text("Urgent").tag("URGENT")
                    }
                    TextField("Deadline YYYY-MM-DD (ঐচ্ছিক)", text: $deadline)
                        .keyboardType(.numbersAndPunctuation)
                    TextField("Banner image URL (ঐচ্ছিক)", text: $bannerUrl)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Toggle("Acknowledgment required", isOn: $ackRequired)
                    Toggle("Allow dismiss", isOn: $allowDismiss)
                }
                Section("Assignees (কমপক্ষে ১ জন) — \(assigneeIds.count) selected") {
                    if vm.assignees.isEmpty {
                        Text("লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(vm.assignees) { u in
                        Toggle(u.name, isOn: Binding(
                            get: { assigneeIds.contains(u.id) },
                            set: { on in if on { assigneeIds.insert(u.id) } else { assigneeIds.remove(u.id) } }))
                    }
                }
                if let err = vm.error {
                    Section { Text(err).font(.caption).foregroundStyle(.red) }
                }
            }
            .navigationTitle("New spotlight")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("বাতিল") { onDone() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(vm.creating ? "…" : "Publish") {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task {
                            if await vm.createTask(title: title, description: descriptionText,
                                                   priority: priority, deadline: deadline,
                                                   bannerUrl: bannerUrl, ackRequired: ackRequired,
                                                   allowDismiss: allowDismiss,
                                                   assigneeIds: Array(assigneeIds)) {
                                onDone()
                            }
                        }
                    }
                    .disabled(vm.creating || title.trimmingCharacters(in: .whitespaces).isEmpty
                              || descriptionText.trimmingCharacters(in: .whitespaces).isEmpty
                              || assigneeIds.isEmpty)
                }
            }
            .task { await vm.loadAssignees() }
        }
    }
}

// MARK: - Task card (Reminders-style row: status circle · due badge · avatars · progress)

@available(iOS 17.0, *)
private struct TaskSpotlightCard: View {
    let task: TaskSpotlightTask
    let busy: Bool
    let onTap: () -> Void
    let onArchive: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                statusCircle
                VStack(alignment: .leading, spacing: 2) {
                    Text(task.title)
                        .font(.subheadline.weight(.bold))
                        .strikethrough(task.status == "ARCHIVED")
                        .foregroundStyle(task.status == "ARCHIVED" ? .secondary : .primary)
                    if let desc = task.description, !desc.isEmpty {
                        Text(desc).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer(minLength: 4)
                if let p = task.priority, p == "CRITICAL" || p == "HIGH" {
                    Text(p).font(.caption2.weight(.heavy))
                        .foregroundStyle(TaskSpotlightPalette.priority(p))
                }
            }

            HStack(spacing: 6) {
                dueBadge
                if task.status == "ARCHIVED" {
                    Text("ARCHIVED").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
                }
                Spacer()
                avatarStack
            }

            progressLine

            if task.status == "ACTIVE" {
                actionRow
            }
        }
        .padding(14)
        .taskSpotlightGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }

    /// Reminders-style leading circle — filled check when everyone is done,
    /// half-filled while in flight, open circle when nobody started.
    private var statusCircle: some View {
        let (icon, tint): (String, Color) =
            task.isDone ? ("checkmark.circle.fill", TaskSpotlightPalette.emerald600)
            : task.stats.acknowledged > 0 ? ("circle.lefthalf.filled", TaskSpotlightPalette.amber500)
            : ("circle", Color.secondary)
        return Image(systemName: icon)
            .font(.system(size: 20, weight: .regular))
            .foregroundStyle(tint)
    }

    /// Due badge — overdue red, due today amber, else quiet date text.
    @ViewBuilder private var dueBadge: some View {
        if let deadline = TaskSpotlightFormat.dateTime(task.deadline) {
            if task.isOverdue {
                badge("⏰ \(deadline) — সময় পেরিয়ে গেছে", TaskSpotlightPalette.red500)
            } else if task.isDueToday && !task.isDone {
                badge("আজ \(deadline)", TaskSpotlightPalette.amber500)
            } else {
                Text(deadline).font(.caption2).foregroundStyle(.secondary)
            }
        } else {
            Text("কোনো ডেডলাইন নেই").font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func badge(_ text: String, _ tint: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .foregroundStyle(tint)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(tint.opacity(0.12), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.30), lineWidth: 0.8))
    }

    /// Overlapping initials avatars — first 4 assignees + "+N".
    private var avatarStack: some View {
        HStack(spacing: -8) {
            ForEach(task.assignments.prefix(4)) { a in
                Text(TaskSpotlightFormat.initials(a.displayName))
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(TaskSpotlightPalette.accentText(colorScheme))
                    .frame(width: 26, height: 26)
                    .background(TaskSpotlightPalette.coral.opacity(0.16), in: Circle())
                    .overlay(Circle().strokeBorder(TaskSpotlightPalette.coral.opacity(0.35), lineWidth: 1))
                    .overlay(Circle().strokeBorder(Color.white.opacity(colorScheme == .dark ? 0.15 : 0.6), lineWidth: 1))
            }
            if task.assignments.count > 4 {
                Text("+\(task.assignments.count - 4)")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 26, height: 26)
                    .background(Color.primary.opacity(0.06), in: Circle())
            }
        }
    }

    /// Web: "{rate}% complete ({completed}/{assigned})" — as a thin native bar.
    private var progressLine: some View {
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.08))
                    Capsule()
                        .fill(task.isDone ? TaskSpotlightPalette.emerald600 : TaskSpotlightPalette.coral)
                        .frame(width: geo.size.width * CGFloat(min(max(task.stats.completionRate, 0), 100)) / 100)
                }
            }
            .frame(height: 5)
            Text("\(task.stats.completionRate)% complete (\(task.stats.completed)/\(task.stats.assigned))")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var actionRow: some View {
        HStack(spacing: 10) {
            if busy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Processing…").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            } else {
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    onArchive()
                } label: {
                    Label("Archive", systemImage: "archivebox")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color.primary.opacity(0.06), in: Capsule())
                        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 2)
    }
}

// MARK: - Detail sheet (full description + per-assignee rows + resend/archive)

@available(iOS 17.0, *)
private struct TaskSpotlightDetailSheet: View {
    let task: TaskSpotlightTask
    let vm: TaskSpotlightVM
    let onArchive: () -> Void
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    /// Live copy — the VM reloads after resend, keep the sheet's rows fresh.
    private var current: TaskSpotlightTask { vm.tasks.first { $0.id == task.id } ?? task }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                if let banner = current.bannerImageUrl, let url = URL(string: banner) {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        Color.primary.opacity(0.05)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 140)
                    .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                }
                descriptionCard
                assigneeList
                if current.status == "ACTIVE" { archiveButton }
                webLink
            }
            .padding(18)
        }
        .presentationBackground { TaskSpotlightAurora() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(current.title).font(.headline)
                Spacer()
                if let p = current.priority {
                    Text(p).font(.caption2.weight(.heavy))
                        .foregroundStyle(TaskSpotlightPalette.priority(p))
                }
            }
            Text(metaLine).font(.caption).foregroundStyle(.secondary)
        }
    }

    private var metaLine: String {
        var bits: [String] = [current.status]
        if let by = current.createdByName { bits.append("by \(by)") }
        if let d = TaskSpotlightFormat.dateTime(current.createdAt) { bits.append(d) }
        return bits.joined(separator: " · ")
    }

    private var descriptionCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("নির্দেশনা").font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(current.description ?? "—")
                .font(.footnote)
                .lineSpacing(2.5)
            HStack(spacing: 10) {
                if let deadline = TaskSpotlightFormat.dateTime(current.deadline) {
                    Label(deadline, systemImage: "calendar")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(current.isOverdue ? TaskSpotlightPalette.red500 : .secondary)
                }
                if current.acknowledgmentRequired == true {
                    Label("Acknowledgment required", systemImage: "checkmark.seal")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .taskSpotlightGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    /// Per-assignee rows — Reminders-style status circle + name + status + resend.
    private var assigneeList: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("অ্যাসাইনি (\(current.assignments.count))")
                .font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            ForEach(current.assignments) { a in
                assigneeRow(a)
            }
            if current.assignments.isEmpty {
                Text("কাউকে অ্যাসাইন করা হয়নি").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .taskSpotlightGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func assigneeRow(_ a: TaskSpotlightAssignment) -> some View {
        let tint = TaskSpotlightPalette.assignment(a.status)
        return HStack(spacing: 10) {
            Image(systemName: statusIcon(a.status))
                .font(.system(size: 18))
                .foregroundStyle(tint)
            Text(TaskSpotlightFormat.initials(a.displayName))
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(TaskSpotlightPalette.accentText(colorScheme))
                .frame(width: 26, height: 26)
                .background(TaskSpotlightPalette.coral.opacity(0.16), in: Circle())
                .overlay(Circle().strokeBorder(TaskSpotlightPalette.coral.opacity(0.35), lineWidth: 1))
            VStack(alignment: .leading, spacing: 1) {
                Text(a.displayName).font(.footnote.weight(.semibold))
                HStack(spacing: 4) {
                    Text(a.status ?? "—")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(tint)
                    if let ts = timestampLine(a) {
                        Text("· \(ts)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 4)
            if current.status == "ACTIVE" && a.status != "COMPLETED" {
                if vm.busyAssignmentIds.contains(a.id) {
                    ProgressView().controlSize(.small)
                } else {
                    Button {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        Task { await vm.resend(taskId: current.id, assignmentId: a.id) }
                    } label: {
                        // Web button verbatim: "Resend spotlight"
                        Label("Resend", systemImage: "paperplane")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(TaskSpotlightPalette.accentText(colorScheme))
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(TaskSpotlightPalette.coral.opacity(0.13), in: Capsule())
                            .overlay(Capsule().strokeBorder(TaskSpotlightPalette.coral.opacity(0.35), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func statusIcon(_ status: String?) -> String {
        switch status {
        case "COMPLETED": return "checkmark.circle.fill"
        case "IN_PROGRESS": return "circle.lefthalf.filled"
        case "ACKNOWLEDGED": return "eye.circle"
        case "EXPIRED": return "exclamationmark.circle.fill"
        case "ARCHIVED": return "archivebox.circle"
        default: return "circle"     // ACTIVE — not seen yet
        }
    }

    private func timestampLine(_ a: TaskSpotlightAssignment) -> String? {
        if let t = TaskSpotlightFormat.timeAgo(a.completedAt), a.status == "COMPLETED" { return t }
        if let t = TaskSpotlightFormat.timeAgo(a.startedAt), a.status == "IN_PROGRESS" { return t }
        if let t = TaskSpotlightFormat.timeAgo(a.acknowledgedAt), a.status == "ACKNOWLEDGED" { return t }
        return nil
    }

    private var archiveButton: some View {
        Button {
            dismiss()
            onArchive()
        } label: {
            Label("Archive task", systemImage: "archivebox")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity).padding(.vertical, 4)
        }
        .buttonStyle(.bordered)
        .tint(TaskSpotlightPalette.red500)
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/operations/task-spotlight", "Task Spotlight")
        } label: {
            Label("সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Formatting helpers (web util parity)

private enum TaskSpotlightFormat {
    static let dhakaCalendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return c
    }()

    static func parse(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// ISO → "5/7/2026, 8:50 PM" style in Asia/Dhaka (web: toLocaleString()).
    static func dateTime(_ iso: String?) -> String? {
        guard let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateStyle = .short
        f.timeStyle = .short
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    /// Bangla relative time — same strings as the app's other native screens.
    static func timeAgo(_ iso: String?) -> String? {
        guard let date = parse(iso) else { return nil }
        let mins = Int(Date().timeIntervalSince(date) / 60)
        if mins < 1 { return "এইমাত্র" }
        if mins < 60 { return "\(mins) মিনিট আগে" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs) ঘণ্টা আগে" }
        return "\(hrs / 24) দিন আগে"
    }

    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (TaskSpotlight-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct TaskSpotlightAurora: View {
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
    func taskSpotlightGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct TaskSpotlightShimmer: ViewModifier {
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
    func taskSpotlightShimmer() -> some View { modifier(TaskSpotlightShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Task Spotlight — Light") {
    TaskSpotlightScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
