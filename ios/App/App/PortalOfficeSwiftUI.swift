//
//  PortalOfficeSwiftUI.swift
//  ALMA ERP — the staff Office tab (/portal/office) as a native SwiftUI screen.
//
//  Full ACTION PARITY with the web office app (owner instruction 2026-07-06):
//  every staff action the web offers that is NOT camera/GPS/file-upload dependent
//  is wired natively here. Same endpoints, same Bangla strings, same colours:
//    GET  /api/assistant/office/my-tasks       → today's still-open tasks {tasks:[{id,title,type,serial}]}
//    GET  /api/assistant/office/thread?taskId= → {task,comments:[{id,authorType,body,createdAt}],events}
//    POST /api/assistant/office/staff-action   → task actions (see below)
//         · {action:'done', taskId}                              → mark done
//         · {action:'comment', taskId, body}                     → text comment
//         · {action:'update', taskId, body}                      → answer Boss's update request
//         · {action:'self_create', title, detail}                → propose self-initiated work
//    GET  /api/assistant/office/chat           → group feed {businessId, messages:[…]}
//    POST /api/assistant/office/chat           → send a text message {body, attachments:[]}
//    POST /api/assistant/office/chat/explain   → {taskId} — agent explains one task in the group
//    GET  /api/assistant/office/notifications  → {unread, items:[…]}
//    POST /api/assistant/office/notifications  → mark read ({} = all, {id} = one)
//    POST /api/assistant/office/lunch          → {action:'start'|'end'} (45-min allowance)
//  Blocks: header · lunch card · আজকের কাজ (tap → native detail sheet: thread + ✅ done +
//  💬 comment + update answer) · নিজে থেকে কাজ composer · গ্রুপ চ্যাট sheet (send text +
//  explain a task) · নোটিফিকেশন feed with mark-read · small web links for photo proof only.
//  NOT native (web escape — needs the camera / file upload): proof-photo submission and
//  chat image attachments. A small labeled link opens exactly those in the web app.
//  Carried lessons: ONE spinner per action, never a global overlay. Chat sends don't confirm.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum PortalOfficePalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let violet = AlmaSwiftTheme.violet

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names the office routes return)

/// One row of GET /api/assistant/office/my-tasks — TodayTaskBrief on the server.
struct PortalOfficeTask: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let type: String?
    let serial: Int?

    private enum Keys: String, CodingKey { case id, title, type, serial }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        title = (try? c.decode(String.self, forKey: .title)) ?? "—"
        type = try? c.decodeIfPresent(String.self, forKey: .type)
        serial = Self.flexInt(c, .serial)
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

struct PortalOfficeTasksResponse: Decodable {
    let tasks: [PortalOfficeTask]
    private enum Keys: String, CodingKey { case ok, data, tasks }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        tasks = (try? c.decode([PortalOfficeTask].self, forKey: .tasks)) ?? []
    }
}

/// One OfficeNotice row from the notifications feed.
struct PortalOfficeNotice: Decodable, Identifiable, Equatable {
    let id: String
    let taskId: String?
    let kind: String?
    let title: String
    let body: String?
    var read: Bool
    let createdAt: String?

    private enum Keys: String, CodingKey { case id, taskId, kind, title, body, read, createdAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        taskId = try? c.decodeIfPresent(String.self, forKey: .taskId)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        title = (try? c.decode(String.self, forKey: .title)) ?? "—"
        body = try? c.decodeIfPresent(String.self, forKey: .body)
        read = (try? c.decodeIfPresent(Bool.self, forKey: .read)) ?? true
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct PortalOfficeNotifFeed: Decodable {
    let unread: Int
    let items: [PortalOfficeNotice]
    private enum Keys: String, CodingKey { case ok, data, unread, items }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        if let i = try? c.decodeIfPresent(Int.self, forKey: .unread) { unread = i }
        else if let d = try? c.decodeIfPresent(Double.self, forKey: .unread) { unread = Int(d.rounded()) }
        else { unread = 0 }
        items = (try? c.decode([PortalOfficeNotice].self, forKey: .items)) ?? []
    }
}

/// POST /api/assistant/office/lunch — start: {ok,status,startedAt} · end: {ok,status,durationMin}.
struct PortalOfficeLunchResponse: Decodable {
    let ok: Bool?
    let status: String?
    let startedAt: String?
    let durationMin: Int?

    private enum Keys: String, CodingKey { case ok, status, startedAt, durationMin }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        startedAt = try? c.decodeIfPresent(String.self, forKey: .startedAt)
        if let i = try? c.decodeIfPresent(Int.self, forKey: .durationMin) { durationMin = i }
        else if let d = try? c.decodeIfPresent(Double.self, forKey: .durationMin) { durationMin = Int(d.rounded()) }
        else { durationMin = nil }
    }
}

/// One comment row of GET /api/assistant/office/thread — ThreadMessage on the server.
struct PortalOfficeThreadMsg: Decodable, Identifiable, Equatable {
    let id: String
    let authorType: String
    let body: String
    let createdAt: String?

    private enum Keys: String, CodingKey { case id, authorType, body, createdAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        authorType = (try? c.decode(String.self, forKey: .authorType)) ?? "staff"
        body = (try? c.decode(String.self, forKey: .body)) ?? ""
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

/// GET /api/assistant/office/thread → {task, comments:[…], events:[…]}.
struct PortalOfficeThread: Decodable {
    let comments: [PortalOfficeThreadMsg]
    private enum Keys: String, CodingKey { case comments }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        comments = (try? c.decode([PortalOfficeThreadMsg].self, forKey: .comments)) ?? []
    }
}

/// One group-chat message — ChatMessage on the server. `status == "pending"` rows
/// are owner-only agent drafts; the native staff screen never receives them.
struct PortalOfficeChatMsg: Decodable, Identifiable, Equatable {
    let id: String
    let authorType: String
    let authorName: String
    let body: String
    let attachmentCount: Int
    let status: String?
    let createdAt: String?

    private enum Keys: String, CodingKey { case id, authorType, authorName, body, attachments, status, createdAt }
    private struct Blob: Decodable { init(from decoder: Decoder) throws {} }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        authorType = (try? c.decode(String.self, forKey: .authorType)) ?? "staff"
        authorName = (try? c.decodeIfPresent(String.self, forKey: .authorName)) ?? "—"
        body = (try? c.decode(String.self, forKey: .body)) ?? ""
        attachmentCount = ((try? c.decodeIfPresent([Blob].self, forKey: .attachments)) ?? [])?.count ?? 0
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct PortalOfficeChatFeed: Decodable {
    let messages: [PortalOfficeChatMsg]
    private enum Keys: String, CodingKey { case messages }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        messages = (try? c.decode([PortalOfficeChatMsg].self, forKey: .messages)) ?? []
    }
}

/// staff-action responses only carry {ok, status, …}; we just need the success flag.
private struct PortalOfficeOk: Decodable {}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class PortalOfficeVM {
    var tasks: [PortalOfficeTask] = []
    var unread = 0
    var notices: [PortalOfficeNotice] = []
    var loading = false
    var error: String? = nil
    var notice: String? = nil            // one-line info strip (lunch / action results)
    var authExpired = false

    // Lunch — web LunchControl parity (45-min allowance, live countdown)
    var lunchActive = false
    var lunchStartedAt: Date? = nil
    var lunchBusy = false
    var markingRead = false

    // Task detail thread (web StaffDetail parity)
    var thread: [PortalOfficeThreadMsg] = []
    var threadLoading = false
    var actionBusyTaskId: String? = nil  // per-task spinner (done / comment / update)

    // Self-initiated proposal (web SelfInitiated parity)
    var creatingSelf = false

    // Group chat (web GroupChat parity)
    var chat: [PortalOfficeChatMsg] = []
    var chatLoading = false
    var chatSending = false
    var explainingTaskId: String? = nil

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            async let t: PortalOfficeTasksResponse = AlmaAPI.shared.get("/api/assistant/office/my-tasks")
            async let n: PortalOfficeNotifFeed = AlmaAPI.shared.get("/api/assistant/office/notifications")
            let (taskResp, feed) = try await (t, n)
            tasks = taskResp.tasks
            unread = feed.unread
            notices = feed.items
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

    /// Start/end lunch — the exact toggle the web LunchControl posts. Start is
    /// idempotent server-side: if a lunch is already open (e.g. started on the web),
    /// it returns the ORIGINAL startedAt, so the native timer resumes correctly.
    func lunchToggle() async {
        guard !lunchBusy else { return }
        lunchBusy = true
        notice = nil
        defer { lunchBusy = false }
        do {
            if lunchActive {
                let r: PortalOfficeLunchResponse = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/office/lunch", body: ["action": "end"])
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                withAnimation(.snappy) {
                    lunchActive = false
                    lunchStartedAt = nil
                }
                if let d = r.durationMin {
                    notice = "🍽️ লাঞ্চ শেষ — \(PortalOfficeFormat.bn(d)) মিনিট"
                }
            } else {
                let r: PortalOfficeLunchResponse = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/office/lunch", body: ["action": "start"])
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                withAnimation(.snappy) {
                    lunchStartedAt = PortalOfficeFormat.parse(r.startedAt ?? "") ?? Date()
                    lunchActive = true
                }
            }
        } catch AlmaAPIError.notAuthenticated {
            // The GET loads succeed for ANY logged-in user, so landing here while the
            // rest of the screen works means the route's 403 `not_staff` branch (AlmaAPI
            // folds 403 into notAuthenticated) — the owner has no lunch row to open.
            if authExpired {
                // genuinely logged out — the auth card is already showing
            } else {
                notice = "লাঞ্চ টাইমার শুধু স্টাফ অ্যাকাউন্টের জন্য।"
            }
        } catch AlmaAPIError.http(let status, _) where status == 404 {
            // `no_open_lunch` — our local state was stale (ended elsewhere); reset quietly.
            withAnimation(.snappy) {
                lunchActive = false
                lunchStartedAt = nil
            }
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            if Self.isCancellation(error) { return }
            self.error = error.localizedDescription
        }
    }

    /// Web bell's "সব পড়া হয়েছে" — POST {} marks everything in scope read.
    func markAllRead() async {
        guard !markingRead else { return }
        markingRead = true
        defer { markingRead = false }
        do {
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/notifications", body: [String: String]())
            withAnimation(.snappy) {
                for i in notices.indices { notices[i].read = true }
                unread = 0
            }
        } catch {
            // best-effort, like the web bell
        }
    }

    /// Tap one notice → mark just that one read (web onItem parity).
    func markRead(_ n: PortalOfficeNotice) async {
        guard !n.read else { return }
        do {
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/notifications", body: ["id": n.id])
            withAnimation(.snappy) {
                if let i = notices.firstIndex(where: { $0.id == n.id }) { notices[i].read = true }
                unread = max(0, unread - 1)
            }
        } catch {
            // best-effort
        }
    }

    // ── Task detail thread (web StaffDetail — GET thread) ──

    func loadThread(_ taskId: String) async {
        threadLoading = true
        thread = []
        defer { threadLoading = false }
        do {
            let t: PortalOfficeThread = try await AlmaAPI.shared.get(
                "/api/assistant/office/thread", query: ["taskId": taskId])
            thread = t.comments
        } catch {
            if Self.isCancellation(error) { return }
            // leave the thread empty; the sheet shows "এখনো কোনো মন্তব্য নেই"
        }
    }

    /// One staff-action POST — mark done / text comment / update answer.
    /// `action` is 'done' | 'comment' | 'update'. Body carried in the web's `body` field.
    /// Returns success so the caller can clear its composer.
    @discardableResult
    func taskAction(_ taskId: String, action: String, body: String = "") async -> Bool {
        guard actionBusyTaskId == nil else { return false }
        actionBusyTaskId = taskId
        defer { actionBusyTaskId = nil }
        do {
            var payload: [String: String] = ["action": action, "taskId": taskId]
            if !body.isEmpty { payload["body"] = body }
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/staff-action", body: payload)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            switch action {
            case "done":
                notice = "✅ কাজটি সম্পন্ন হিসেবে পাঠানো হয়েছে — Boss অনুমোদন দিলে চূড়ান্ত হবে।"
                await load()   // done drops it from the open list
            case "comment": notice = "💬 কমেন্ট পাঠানো হয়েছে।"
            case "update":  notice = "📤 আপডেট পাঠানো হয়েছে।"
            default: break
            }
            await loadThread(taskId)   // reflect the new comment in the open sheet
            return true
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            return false
        }
    }

    /// Web SelfInitiated — propose an extra task the staff did on their own initiative.
    @discardableResult
    func createSelfInitiated(title: String, detail: String) async -> Bool {
        guard !creatingSelf else { return false }
        creatingSelf = true
        defer { creatingSelf = false }
        do {
            var payload: [String: String] = ["action": "self_create", "title": title]
            if !detail.isEmpty { payload["detail"] = detail }
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/staff-action", body: payload)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = "✨ নিজ উদ্যোগের কাজ পাঠানো হয়েছে — Boss অনুমোদন দিলে পারফরম্যান্সে +পয়েন্ট।"
            return true
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            return false
        }
    }

    // ── Group chat (web GroupChat — GET/POST chat, POST chat/explain) ──

    func loadChat() async {
        chatLoading = true
        defer { chatLoading = false }
        do {
            let feed: PortalOfficeChatFeed = try await AlmaAPI.shared.get("/api/assistant/office/chat")
            // Staff never see 'pending' agent drafts, but filter defensively.
            chat = feed.messages.filter { $0.status != "pending" }
        } catch {
            if Self.isCancellation(error) { return }
            // best-effort; keep whatever we had
        }
    }

    /// Send a TEXT message to the group. Images stay web (needs the file picker).
    @discardableResult
    func sendChat(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !chatSending else { return false }
        chatSending = true
        defer { chatSending = false }
        do {
            // Web posts { body, attachments: [] }; native sends text only.
            struct Payload: Encodable { let body: String; let attachments: [String] }
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/chat", body: Payload(body: trimmed, attachments: []))
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadChat()
            return true
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return false
        }
    }

    /// Web "বুঝিয়ে দিন" — staff asks the agent to explain one task in the group.
    func explainTask(_ taskId: String) async {
        guard explainingTaskId == nil else { return }
        explainingTaskId = taskId
        defer { explainingTaskId = nil }
        do {
            let _: PortalOfficeOk = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/chat/explain", body: ["taskId": taskId])
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await loadChat()
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct PortalOfficeScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = PortalOfficeVM()
    @State private var detailTask: PortalOfficeTask? = nil
    @State private var showSelfCreate = false
    @State private var showChat = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                header
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                if let ok = vm.notice { noticeCard(ok, tone: .info) }
                lunchCard
                if vm.loading && vm.tasks.isEmpty && vm.notices.isEmpty {
                    loadingRows
                } else {
                    tasksCard
                    chatCard
                    noticesCard
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(PortalOfficeAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $detailTask) { t in
            PortalTaskDetailSheet(task: t, vm: vm, openWeb: openWeb)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showSelfCreate) {
            PortalSelfInitiatedSheet(vm: vm)
                .presentationDetents([.height(360)])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showChat) {
            PortalGroupChatSheet(vm: vm, openWeb: openWeb)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Header (web .phead parity: kicker + title + sub + Bangla date) ──

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("আমার অফিস · মোবাইল অ্যাপ")
                .font(.caption2.weight(.bold)).textCase(.uppercase)
                .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
            Text("👷 আমার কাজ")
                .font(.title3.weight(.bold))
            Text("কাজ দেখুন, রেজাল্ট জমা দিন, আর Boss-এর ফিডব্যাক সাথে সাথে পান।")
                .font(.caption).foregroundStyle(.secondary)
            Text(PortalOfficeFormat.headerDate())
                .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }

    // ── Lunch card (web LunchControl — 45-min allowance, live countdown) ──

    private static let lunchLimitSec = 45 * 60

    private var lunchCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                officeBadge("fork.knife")
                VStack(alignment: .leading, spacing: 1) {
                    Text("লাঞ্চ").font(.footnote.weight(.semibold))
                    Text("৪৫ মিনিটের বিরতি").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
            }
            if vm.lunchActive, let started = vm.lunchStartedAt {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let elapsed = Int(context.date.timeIntervalSince(started))
                    let remaining = Self.lunchLimitSec - elapsed
                    let over = remaining <= 0
                    let mm = abs(remaining) / 60
                    let ss = abs(remaining) % 60
                    let clock = "\(PortalOfficeFormat.bn(mm)):\(PortalOfficeFormat.bn(String(format: "%02d", ss)))"
                    HStack(spacing: 10) {
                        // Web strings verbatim: "🍽️ লাঞ্চ · X:XX বাকি" / "⚠️ X:XX বেশি"
                        Text(over ? "🍽️ লাঞ্চ · ⚠️ \(clock) বেশি" : "🍽️ লাঞ্চ · \(clock) বাকি")
                            .font(.subheadline.weight(.bold).monospacedDigit())
                            .foregroundStyle(over ? PortalOfficePalette.red500 : PortalOfficePalette.amber600)
                        Spacer()
                        if vm.lunchBusy {
                            ProgressView().controlSize(.small)
                        } else {
                            chipButton("ফিরে এসেছি", icon: "checkmark",
                                       tint: PortalOfficePalette.emerald600,
                                       text: PortalOfficePalette.emerald600) {
                                Task { await vm.lunchToggle() }
                            }
                            .frame(width: 140)
                        }
                    }
                }
            } else if vm.lunchBusy {
                ProgressView().controlSize(.small)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            } else {
                chipButton("🍽️ লাঞ্চে যাচ্ছি", icon: nil,
                           tint: PortalOfficePalette.coral,
                           text: PortalOfficePalette.accentText(colorScheme)) {
                    Task { await vm.lunchToggle() }
                }
            }
        }
        .padding(14)
        .portalOfficeGlass(colorScheme, corner: 16)
    }

    // ── আজকের কাজ (GET my-tasks — today's still-open tasks, serial order) ──

    private var tasksCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                officeBadge("checklist")
                VStack(alignment: .leading, spacing: 1) {
                    Text("আজকের কাজ").font(.footnote.weight(.semibold))
                    Text("আমার কাজ · \(PortalOfficeFormat.headerDate())")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if !vm.tasks.isEmpty {
                    Text(PortalOfficeFormat.bn(vm.tasks.count))
                        .font(.caption.weight(.bold))
                        .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(PortalOfficePalette.coral.opacity(0.18), in: Capsule())
                        .overlay(Capsule().strokeBorder(PortalOfficePalette.coral.opacity(0.4), lineWidth: 1))
                }
            }
            if vm.tasks.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("আজ কোনো কাজ নেই").font(.footnote.weight(.semibold))
                    Text("নতুন কাজ এলে এখানে দেখতে পাবেন।").font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            } else {
                ForEach(vm.tasks) { t in
                    taskRow(t)
                }
                Text("রেজাল্ট জমা দিতে, কমেন্ট করতে বা ✅ সম্পন্ন দিতে কাজটিতে চাপ দিন।")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            // ── নিজে থেকে একটা কাজ (web SelfInitiated composer) ──
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                showSelfCreate = true
            } label: {
                Label("✨ নিজে থেকে একটা কাজ করেছি — জমা দিন", systemImage: "plus.circle")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(PortalOfficePalette.violet)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(PortalOfficePalette.violet.opacity(0.12), in: Capsule())
                    .overlay(Capsule().strokeBorder(PortalOfficePalette.violet.opacity(0.4),
                                                    style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
        .padding(14)
        .portalOfficeGlass(colorScheme, corner: 16)
    }

    private func taskRow(_ t: PortalOfficeTask) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            detailTask = t
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(PortalOfficeFormat.bn(t.serial ?? 0))
                    .font(.caption.weight(.bold))
                    .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                    .frame(width: 26, height: 26)
                    .background(PortalOfficePalette.coral.opacity(0.16), in: Circle())
                    .overlay(Circle().strokeBorder(PortalOfficePalette.coral.opacity(0.35), lineWidth: 1))
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.title)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    if let type = t.type, !type.isEmpty {
                        Text("📦 \(type)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 4)
                if vm.actionBusyTaskId == t.id {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }

    // ── গ্রুপ চ্যাট (web GroupChat — open the native chat sheet) ──

    private var chatCard: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            showChat = true
        } label: {
            HStack(spacing: 10) {
                officeBadge("bubble.left.and.bubble.right")
                VStack(alignment: .leading, spacing: 1) {
                    Text("অফিস গ্রুপ চ্যাট").font(.footnote.weight(.semibold))
                    Text("● Agent, আপনি, টিম").font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .padding(14)
        .portalOfficeGlass(colorScheme, corner: 16)
    }

    // ── নোটিফিকেশন (GET/POST notifications — web NotifBell parity) ──

    private var noticesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                officeBadge("bell")
                Text("নোটিফিকেশন").font(.footnote.weight(.semibold))
                if vm.unread > 0 {
                    Text(vm.unread > 9 ? "৯+" : PortalOfficeFormat.bn(vm.unread))
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2.5)
                        .background(PortalOfficePalette.red500, in: Capsule())
                }
                Spacer()
                if vm.unread > 0 {
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        Task { await vm.markAllRead() }
                    } label: {
                        Text("সব পড়া হয়েছে")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.markingRead)
                }
            }
            if vm.notices.isEmpty {
                Text("কোনো নোটিফিকেশন নেই।")
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.vertical, 6)
            } else {
                ForEach(vm.notices) { n in
                    noticeRow(n)
                }
            }
        }
        .padding(14)
        .portalOfficeGlass(colorScheme, corner: 16)
    }

    private func noticeRow(_ n: PortalOfficeNotice) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            Task { await vm.markRead(n) }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Text(PortalOfficeFormat.kindIcon(n.kind))
                    .font(.footnote)
                    .frame(width: 26, height: 26)
                    .background(Color.primary.opacity(0.05), in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(n.title)
                        .font(.caption.weight(n.read ? .regular : .bold))
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                    if let body = n.body, !body.isEmpty {
                        Text(body).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Text(PortalOfficeFormat.timeAgo(n.createdAt))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if !n.read {
                    Circle().fill(PortalOfficePalette.coral).frame(width: 7, height: 7)
                        .padding(.top, 5)
                }
            }
            .padding(.vertical, 3)
        }
        .buttonStyle(.plain)
    }

    // ── Shared bits ──

    /// Squircle SF-symbol badge — coral→violet gradient, the app's card-header mark.
    private func officeBadge(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 34, height: 34)
            .background(
                LinearGradient(colors: [PortalOfficePalette.coral, AlmaSwiftTheme.violet],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .shadow(color: PortalOfficePalette.coral.opacity(0.35), radius: 5, y: 2)
    }

    private func chipButton(_ label: String, icon: String?, tint: Color, text: Color,
                            action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            action()
        } label: {
            Group {
                if let icon {
                    Label(label, systemImage: icon)
                } else {
                    Text(label)
                }
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(text)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background(tint.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, success, info }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", PortalOfficePalette.red500)
        case .success: ("checkmark.circle", PortalOfficePalette.emerald600)
        case .info: ("info.circle", Color.secondary)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).portalOfficeGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .portalOfficeGlass(colorScheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<3, id: \.self) { _ in
            Color.clear.frame(height: 110)
                .portalOfficeGlass(colorScheme, corner: 16)
                .portalOfficeShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/portal/office", "Office")
        } label: {
            Label("ওয়েব ভার্সন", systemImage: "safari")
                .font(.caption2)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary.opacity(0.7))
        .padding(.vertical, 4)
    }
}

// MARK: - Task detail sheet (web StaffDetail — thread + ✅ done + 💬 comment + update)

@available(iOS 17.0, *)
private struct PortalTaskDetailSheet: View {
    let task: PortalOfficeTask
    @Bindable var vm: PortalOfficeVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var busy: Bool { vm.actionBusyTaskId == task.id }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // Task header
                    VStack(alignment: .leading, spacing: 6) {
                        Text(task.title).font(.headline.weight(.bold))
                        if let type = task.type, !type.isEmpty {
                            Text("📦 \(type)")
                                .font(.caption).foregroundStyle(.secondary)
                                .padding(.horizontal, 10).padding(.vertical, 4)
                                .background(Color.primary.opacity(0.05), in: Capsule())
                        }
                    }

                    // Thread (web .msgs)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("আলোচনা").font(.caption.weight(.bold)).textCase(.uppercase)
                            .foregroundStyle(.secondary)
                        if vm.threadLoading {
                            HStack { ProgressView().controlSize(.small); Text("লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary) }
                        } else if vm.thread.isEmpty {
                            Text("এখনো কোনো মন্তব্য নেই")
                                .font(.caption).foregroundStyle(.secondary)
                        } else {
                            ForEach(vm.thread) { c in threadBubble(c) }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .portalOfficeGlass(colorScheme, corner: 14)

                    // Compose: comment / update answer
                    VStack(alignment: .leading, spacing: 10) {
                        Text("📎 রেজাল্ট / কমেন্ট জমা দিন").font(.footnote.weight(.semibold))
                        HStack(spacing: 8) {
                            TextField("কমেন্ট লিখুন…", text: $draft, axis: .vertical)
                                .lineLimit(1...4)
                                .focused($focused)
                                .font(.footnote)
                                .padding(.horizontal, 12).padding(.vertical, 9)
                                .background(Color.primary.opacity(0.05),
                                            in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            Button {
                                let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                                guard !text.isEmpty else { return }
                                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                                Task {
                                    // Answer a Boss update request as 'update'; a plain note as 'comment'.
                                    if await vm.taskAction(task.id, action: "comment", body: text) { draft = "" }
                                }
                            } label: {
                                if busy {
                                    ProgressView().controlSize(.small).frame(width: 60)
                                } else {
                                    Text("পাঠান").font(.footnote.weight(.semibold))
                                        .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                                        .padding(.horizontal, 14).padding(.vertical, 9)
                                        .background(PortalOfficePalette.coral.opacity(0.14), in: Capsule())
                                        .overlay(Capsule().strokeBorder(PortalOfficePalette.coral.opacity(0.35), lineWidth: 1))
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(busy || draft.trimmingCharacters(in: .whitespaces).isEmpty)
                        }

                        // ✅ Mark done (web "✅ সম্পন্ন হিসেবে চিহ্নিত করুন")
                        Button {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            Task {
                                if await vm.taskAction(task.id, action: "done") { dismiss() }
                            }
                        } label: {
                            if busy {
                                ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 9)
                            } else {
                                Label("✅ সম্পন্ন হিসেবে চিহ্নিত করুন", systemImage: "checkmark.seal")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(PortalOfficePalette.emerald600)
                                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                                    .background(PortalOfficePalette.emerald600.opacity(0.13), in: Capsule())
                                    .overlay(Capsule().strokeBorder(PortalOfficePalette.emerald600.opacity(0.35), lineWidth: 1))
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .portalOfficeGlass(colorScheme, corner: 14)

                    // Photo proof stays web (needs the camera / file upload).
                    Button {
                        openWeb("/portal/office", "Office")
                    } label: {
                        Label("📷 ছবি জমা দিতে ওয়েবে খুলুন", systemImage: "safari")
                            .font(.caption).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 2)

                    Text("Boss অনুমোদন দিলে কাজটি সম্পন্ন হবে। নোটিফিকেশন এই অ্যাপে ও টেলিগ্রামে পাবেন।")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                .padding(16)
            }
            .background(PortalOfficeAurora())
            .navigationTitle("কাজের বিস্তারিত")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("বন্ধ") { dismiss() }
                }
            }
        }
        .task { await vm.loadThread(task.id) }
    }

    private func threadBubble(_ c: PortalOfficeThreadMsg) -> some View {
        let isOwner = c.authorType == "owner"
        let isAgent = c.authorType == "agent"
        let who = isOwner ? "Boss" : isAgent ? "Agent" : "আপনি"
        return HStack(alignment: .top, spacing: 8) {
            Text(isOwner ? "M" : isAgent ? "🤖" : "•")
                .font(.caption2.weight(.bold))
                .frame(width: 24, height: 24)
                .background(Color.primary.opacity(0.06), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(who).font(.caption2.weight(.bold))
                    Text(PortalOfficeFormat.timeAgo(c.createdAt)).font(.caption2).foregroundStyle(.secondary)
                }
                Text(c.body).font(.caption).foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Self-initiated sheet (web SelfInitiated — title + optional detail)

@available(iOS 17.0, *)
private struct PortalSelfInitiatedSheet: View {
    @Bindable var vm: PortalOfficeVM
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var detail = ""
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 14) {
                Text("✨ নিজে থেকে একটা কাজ করেছি")
                    .font(.headline.weight(.bold))
                Text("Boss অনুমোদন দিলে পারফরম্যান্সে +পয়েন্ট।")
                    .font(.caption).foregroundStyle(.secondary)

                TextField("কাজের শিরোনাম", text: $title)
                    .focused($focused)
                    .font(.footnote)
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .background(Color.primary.opacity(0.05),
                                in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                TextField("বিস্তারিত (ঐচ্ছিক)", text: $detail, axis: .vertical)
                    .lineLimit(2...5)
                    .font(.footnote)
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .background(Color.primary.opacity(0.05),
                                in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                Button {
                    let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    Task {
                        if await vm.createSelfInitiated(title: t,
                                                        detail: detail.trimmingCharacters(in: .whitespacesAndNewlines)) {
                            dismiss()
                        }
                    }
                } label: {
                    if vm.creatingSelf {
                        ProgressView().controlSize(.small).frame(maxWidth: .infinity).padding(.vertical, 10)
                    } else {
                        Text("পাঠান").font(.footnote.weight(.semibold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(PortalOfficePalette.violet, in: Capsule())
                    }
                }
                .buttonStyle(.plain)
                .disabled(vm.creatingSelf || title.trimmingCharacters(in: .whitespaces).isEmpty)

                Spacer()
            }
            .padding(18)
            .background(PortalOfficeAurora())
            .navigationTitle("নতুন কাজ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("বাতিল") { dismiss() } }
            }
        }
        .onAppear { focused = true }
    }
}

// MARK: - Group chat sheet (web GroupChat — send text + explain a task)

@available(iOS 17.0, *)
private struct PortalGroupChatSheet: View {
    @Bindable var vm: PortalOfficeVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var tasksOpen = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            if vm.chatLoading && vm.chat.isEmpty {
                                HStack { ProgressView().controlSize(.small); Text("লোড হচ্ছে…").font(.caption).foregroundStyle(.secondary) }
                                    .padding(.top, 20)
                            } else if vm.chat.isEmpty {
                                Text("— এখনো কোনো বার্তা নেই। প্রথম বার্তাটি লিখুন। —")
                                    .font(.caption).foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity).padding(.top, 24)
                            } else {
                                ForEach(vm.chat) { m in chatBubble(m) }
                            }
                            Color.clear.frame(height: 1).id("bottom")
                        }
                        .padding(14)
                    }
                    .onChange(of: vm.chat.count) { _, _ in
                        withAnimation(.snappy) { proxy.scrollTo("bottom", anchor: .bottom) }
                    }
                }

                // "আজকের কাজ" explain picker (staff only tool)
                if tasksOpen {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("আজকের কাজ — যেটা বুঝছেন না, সেটায় চাপ দিন")
                            .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                        if vm.tasks.isEmpty {
                            Text("আজ আপনার কোনো বাকি কাজ নেই।")
                                .font(.caption2).foregroundStyle(.secondary)
                        } else {
                            ForEach(vm.tasks) { t in
                                Button {
                                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                                    Task {
                                        await vm.explainTask(t.id)
                                        tasksOpen = false
                                    }
                                } label: {
                                    HStack(spacing: 8) {
                                        Text(PortalOfficeFormat.bn(t.serial ?? 0))
                                            .font(.caption2.weight(.bold))
                                            .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                                            .frame(width: 22, height: 22)
                                            .background(PortalOfficePalette.coral.opacity(0.16), in: Circle())
                                        Text(t.title).font(.caption).foregroundStyle(.primary).lineLimit(1)
                                        Spacer(minLength: 4)
                                        if vm.explainingTaskId == t.id {
                                            ProgressView().controlSize(.small)
                                        } else {
                                            Text("বুঝিয়ে দিন")
                                                .font(.caption2.weight(.semibold))
                                                .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                                        }
                                    }
                                }
                                .buttonStyle(.plain)
                                .disabled(vm.explainingTaskId != nil)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(.ultraThinMaterial)
                }

                // Composer (web .cp-foot — text only; image attach stays web)
                HStack(spacing: 8) {
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        withAnimation(.snappy) { tasksOpen.toggle() }
                    } label: {
                        Image(systemName: "list.bullet.clipboard")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(tasksOpen ? PortalOfficePalette.accentText(colorScheme) : .secondary)
                            .frame(width: 36, height: 36)
                            .background(Color.primary.opacity(0.05), in: Circle())
                    }
                    .buttonStyle(.plain)
                    Button {
                        openWeb("/portal/office", "Office")   // image attach needs the file picker
                    } label: {
                        Image(systemName: "camera")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 36, height: 36)
                            .background(Color.primary.opacity(0.05), in: Circle())
                    }
                    .buttonStyle(.plain)
                    TextField("গ্রুপে মেসেজ লিখুন…", text: $draft, axis: .vertical)
                        .lineLimit(1...4)
                        .focused($focused)
                        .font(.footnote)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(Color.primary.opacity(0.05),
                                    in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    Button {
                        let text = draft
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        Task { if await vm.sendChat(text) { draft = "" } }
                    } label: {
                        if vm.chatSending {
                            ProgressView().controlSize(.small).frame(width: 52)
                        } else {
                            Text("পাঠান").font(.footnote.weight(.semibold))
                                .foregroundStyle(PortalOfficePalette.accentText(colorScheme))
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.chatSending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .padding(12)
                .background(.ultraThinMaterial)
            }
            .background(PortalOfficeAurora())
            .navigationTitle("অফিস গ্রুপ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("বন্ধ") { dismiss() } }
            }
        }
        .task { await vm.loadChat() }
    }

    private func chatBubble(_ m: PortalOfficeChatMsg) -> some View {
        let isAgent = m.authorType == "agent"
        let isOwner = m.authorType == "owner"
        let name = isAgent ? "Agent" : isOwner ? "Boss" : m.authorName
        return HStack(alignment: .top, spacing: 8) {
            Text(isAgent ? "🤖" : isOwner ? "M" : (m.authorName.first.map(String.init) ?? "•").uppercased())
                .font(.caption2.weight(.bold))
                .frame(width: 26, height: 26)
                .background(Color.primary.opacity(0.06), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(name).font(.caption2.weight(.bold))
                    Text(PortalOfficeFormat.timeAgo(m.createdAt)).font(.caption2).foregroundStyle(.secondary)
                }
                if m.attachmentCount > 0 {
                    Label("\(PortalOfficeFormat.bn(m.attachmentCount)) ছবি — ওয়েবে দেখুন",
                          systemImage: "photo")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if !m.body.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text(m.body).font(.caption).foregroundStyle(.primary)
                        .multilineTextAlignment(.leading)
                }
            }
            Spacer(minLength: 0)
        }
    }
}

// MARK: - Formatting helpers (web util parity)

private enum PortalOfficeFormat {
    /// ASCII digits → Bangla numerals — the web's `bn()` helper.
    private static let bnDigits: [Character] = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"]
    static func bn(_ n: Int) -> String { bn(String(n)) }
    static func bn(_ s: String) -> String {
        String(s.map { c -> Character in
            if c.isASCII, let v = c.wholeNumberValue, (0...9).contains(v) { return bnDigits[v] }
            return c
        })
    }

    static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// Bangla long date for the header, e.g. "২৪ জুন, মঙ্গলবার" (web dhakaHeaderDate).
    static func headerDate() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "bn_BD")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        f.dateFormat = "d MMMM, EEEE"
        return f.string(from: Date())
    }

    /// Bangla relative time — the web bell's exact strings (Bangla digits).
    static func timeAgo(_ iso: String?) -> String {
        guard let iso, let date = parse(iso) else { return "" }
        let m = Int(Date().timeIntervalSince(date) / 60)
        if m < 1 { return "এইমাত্র" }
        if m < 60 { return "\(bn(m)) মিনিট আগে" }
        let h = m / 60
        if h < 24 { return "\(bn(h)) ঘণ্টা আগে" }
        return "\(bn(h / 24)) দিন আগে"
    }

    /// Web KIND_ICON table verbatim.
    static func kindIcon(_ kind: String?) -> String {
        switch kind {
        case "completed": return "✅"
        case "comment": return "💬"
        case "approved": return "👍"
        case "redo": return "🔄"
        case "update_request": return "⏰"
        case "escalation": return "🚨"
        case "self_initiated": return "✨"
        case "award": return "🏆"
        case "group_message": return "👥"
        case "task_assigned": return "📋"
        default: return "🔔"
        }
    }
}

// MARK: - Aurora background + glass (PortalOffice-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct PortalOfficeAurora: View {
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
    func portalOfficeGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct PortalOfficeShimmer: ViewModifier {
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
    func portalOfficeShimmer() -> some View { modifier(PortalOfficeShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Office — Light") {
    PortalOfficeScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
