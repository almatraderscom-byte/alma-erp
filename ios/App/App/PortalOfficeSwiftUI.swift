//
//  PortalOfficeSwiftUI.swift
//  ALMA ERP — the staff Office tab (/portal/office) as a native SwiftUI screen.
//
//  Mirrors the web office app's session-authenticated surface — same endpoints,
//  same Bangla strings, same colours:
//    GET  /api/assistant/office/my-tasks       → today's still-open tasks {tasks:[{id,title,type,serial}]}
//    GET  /api/assistant/office/notifications  → {unread, items:[{id,taskId,kind,title,body,read,createdAt}]}
//    POST /api/assistant/office/notifications  → mark read ({} = all, {id} = one)
//    POST /api/assistant/office/lunch          → {action:'start'|'end'} (45-min allowance;
//                                                 start is idempotent and returns the open
//                                                 row's startedAt, so the timer resumes)
//  Blocks: header (kicker + date) · lunch card with live ৪৫-min countdown ·
//  আজকের কাজ list · নোটিফিকেশন feed with mark-read · web escape hatch.
//  NOT native (web escape instead): task detail/thread, proof photo upload,
//  self-initiated tasks, group chat, motivation/performer hero (server-rendered
//  only — no JSON endpoint), salah blocks (internal VPS-key routes, no session API).
//  Carried lessons: ONE spinner per action, never a global overlay.
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

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class PortalOfficeVM {
    var tasks: [PortalOfficeTask] = []
    var unread = 0
    var notices: [PortalOfficeNotice] = []
    var loading = false
    var error: String? = nil
    var notice: String? = nil            // one-line info strip (lunch results etc.)
    var authExpired = false

    // Lunch — web LunchControl parity (45-min allowance, live countdown)
    var lunchActive = false
    var lunchStartedAt: Date? = nil
    var lunchBusy = false
    var markingRead = false

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
        struct Ok: Decodable {}
        do {
            let _: Ok = try await AlmaAPI.shared.send(
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
        struct Ok: Decodable {}
        do {
            let _: Ok = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/office/notifications", body: ["id": n.id])
            withAnimation(.snappy) {
                if let i = notices.firstIndex(where: { $0.id == n.id }) { notices[i].read = true }
                unread = max(0, unread - 1)
            }
        } catch {
            // best-effort
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct PortalOfficeScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = PortalOfficeVM()
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
                // Proof photos, comments and ✅ done live in the web office app.
                Text("রেজাল্ট জমা দিতে বা কমেন্ট করতে কাজটিতে চাপ দিন।")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .portalOfficeGlass(colorScheme, corner: 16)
    }

    private func taskRow(_ t: PortalOfficeTask) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            // Submission (photos/comments/done) is the web app's job — deep-drop there.
            openWeb("/portal/office", "Office")
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
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
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
            Label("পুরো অফিস হাব (চ্যাট · ছবি জমা · সবকিছু) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
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
