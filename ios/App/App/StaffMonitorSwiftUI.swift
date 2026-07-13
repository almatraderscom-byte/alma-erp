//
//  StaffMonitorSwiftUI.swift
//  ALMA ERP — Staff Monitor as a native SwiftUI screen (read-only).
//
//  Mirrors the web /agent/staff-monitor page's staff blocks — same endpoint,
//  same colours, same Bangla labels:
//    GET /api/agent/staff-monitor            → live staff summaries + geo + feed
//    GET /api/agent/staff-monitor?date=YYYY-MM-DD → archived day summary
//  (Session-cookie route — the exact browser fetch the web page itself makes.
//   No key-authed agent routes; staff dispatch/nudge/escalate stay on web.)
//
//  Owner control panels (audit fix 2026-07-11): the web page's four top panels
//  come native as the SAFETY-CRITICAL essentials only —
//    · Agent Control Center: master PAUSE/RESUME (GET+PATCH /api/assistant/controls,
//      same {paused} payload as web AgentControlCenter.tsx); autonomy + capability
//      states shown READ-ONLY, changes stay web-escaped.
//    · Live Browser Watch: emergency "সব থামাও" STOP / resume (GET+POST
//      /api/assistant/live-browser/watch {action:stop|resume}) + read-only status
//      line; latest screenshot + live step feed stay web-escaped.
//    · Heartbeat / Models: read-only status rows (GET /api/assistant/heartbeat?limit=1,
//      GET /api/assistant/models); all toggling stays web-escaped.
//  Every mutating action passes a Bangla confirmationDialog first (file precedent:
//  Attendance/Expenses), and the server's echoed state is what the UI shows —
//  never an optimistic guess (claim-verifier ethos).
//
//  Blocks: Live/Archive day chips · KPI strip (active/tasks/unacked) · staff
//  cards with initials avatars + live status dots + day-progress bars + location
//  line (geo status + relative Bangla time) · per-staff detail sheet (progress,
//  location, productivity alerts, today's messages with ack badges) · web
//  escape hatch. Carried lessons: lenient decoding, cancellation-safe refresh.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum StaffMonitorPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let teal = Color(red: 0.506, green: 0.698, blue: 0.604)           // web #81B29A (progress gradient)
    static let sky500 = Color(red: 0.055, green: 0.647, blue: 0.914)         // #0EA5E9 (driving dot)

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }

    /// Web MonitorStaffCards statusInfo() — same precedence, same labels.
    static func status(_ s: StaffMonitorSummary) -> (color: Color, label: String) {
        if s.driving == true { return (sky500, "🚗 Driving") }
        if s.checkedIn == false { return (.secondary, "Awaiting") }
        if s.failed > 0 { return (red500, "Issues") }
        if s.completionPct >= 100 { return (emerald600, "Complete") }
        if s.started && s.completionPct >= 50 { return (amber500, "Working") }
        if s.started { return (amber500, "Started") }
        return (.secondary, "Idle")
    }

    /// Web GEO_LABEL table — Bangla strings verbatim.
    static func geo(_ status: String?) -> (icon: String, text: String, color: Color) {
        switch status {
        case "in_zone": return ("✅", "অফিসে", emerald600)
        case "outside": return ("🚨", "বাইরে", red500)
        case "stale": return ("⏸️", "পুরোনো লোকেশন", amber600)
        default: return ("❓", "লোকেশন নেই", .secondary)
        }
    }
}

// MARK: - Lenient int decoding (API mixes Int/Double/String numerics)

private func staffMonitorFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
    return nil
}

// MARK: - Models (same field names as src/agent/lib/staff-monitor-types.ts)

/// Web StaffSummary — one staff member's day progress.
struct StaffMonitorSummary: Decodable, Identifiable, Equatable {
    let staffId: String
    let staffName: String
    let dispatched: Int
    let delivered: Int
    let failed: Int
    let tasksTotal: Int
    let tasksDone: Int
    let completionPct: Int
    let started: Bool
    let lastActivityAt: String?
    let checkedIn: Bool?
    let driving: Bool?

    var id: String { staffId }

    private enum Keys: String, CodingKey {
        case staffId, staffName, dispatched, delivered, failed
        case tasksTotal, tasksDone, completionPct, started, lastActivityAt, checkedIn, driving
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        staffId = (try? c.decode(String.self, forKey: .staffId)) ?? UUID().uuidString
        staffName = (try? c.decode(String.self, forKey: .staffName)) ?? "—"
        dispatched = staffMonitorFlexInt(c, .dispatched) ?? 0
        delivered = staffMonitorFlexInt(c, .delivered) ?? 0
        failed = staffMonitorFlexInt(c, .failed) ?? 0
        tasksTotal = staffMonitorFlexInt(c, .tasksTotal) ?? 0
        tasksDone = staffMonitorFlexInt(c, .tasksDone) ?? 0
        completionPct = staffMonitorFlexInt(c, .completionPct) ?? 0
        started = (try? c.decodeIfPresent(Bool.self, forKey: .started)) ?? false
        lastActivityAt = try? c.decodeIfPresent(String.self, forKey: .lastActivityAt)
        checkedIn = try? c.decodeIfPresent(Bool.self, forKey: .checkedIn)
        driving = try? c.decodeIfPresent(Bool.self, forKey: .driving)
    }

    static func == (a: StaffMonitorSummary, b: StaffMonitorSummary) -> Bool {
        a.staffId == b.staffId && a.completionPct == b.completionPct && a.tasksDone == b.tasksDone
    }
}

/// Web GeoStaffStatus — office geo-fence state per staff.
struct StaffMonitorGeo: Decodable, Equatable {
    let staffId: String
    let staffName: String?
    let status: String
    let distanceM: Int?
    let lastUpdate: String?
    let mapsLink: String?

    private enum Keys: String, CodingKey { case staffId, staffName, status, distanceM, lastUpdate, mapsLink }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        staffId = (try? c.decode(String.self, forKey: .staffId)) ?? ""
        staffName = try? c.decodeIfPresent(String.self, forKey: .staffName)
        status = (try? c.decode(String.self, forKey: .status)) ?? "no_data"
        distanceM = staffMonitorFlexInt(c, .distanceM)
        lastUpdate = try? c.decodeIfPresent(String.self, forKey: .lastUpdate)
        mapsLink = try? c.decodeIfPresent(String.self, forKey: .mapsLink)
    }
}

/// Web ProductivityAlert — idle / proof-timeout / slow-task nudges.
struct StaffMonitorAlert: Decodable, Equatable {
    let staffId: String
    let staffName: String?
    let type: String
    let message: String
    let at: String?

    private enum Keys: String, CodingKey { case staffId, staffName, type, message, at }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        staffId = (try? c.decode(String.self, forKey: .staffId)) ?? ""
        staffName = try? c.decodeIfPresent(String.self, forKey: .staffName)
        type = (try? c.decode(String.self, forKey: .type)) ?? ""
        message = (try? c.decode(String.self, forKey: .message)) ?? ""
        at = try? c.decodeIfPresent(String.self, forKey: .at)
    }
}

/// Web StaffMonitorRow (outbox feed slice the detail sheet shows).
struct StaffMonitorFeedRow: Decodable, Identifiable, Equatable {
    let id: String
    let staffId: String?
    let staffName: String?
    let type: String
    let content: String
    let status: String
    let requiresAck: Bool
    let acknowledgedAt: String?
    let createdAt: String?
    let sentAt: String?

    private enum Keys: String, CodingKey {
        case id, staffId, staffName, type, content, status, requiresAck, acknowledgedAt, createdAt, sentAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        staffId = try? c.decodeIfPresent(String.self, forKey: .staffId)
        staffName = try? c.decodeIfPresent(String.self, forKey: .staffName)
        type = (try? c.decode(String.self, forKey: .type)) ?? ""
        content = (try? c.decode(String.self, forKey: .content)) ?? ""
        status = (try? c.decode(String.self, forKey: .status)) ?? ""
        requiresAck = (try? c.decodeIfPresent(Bool.self, forKey: .requiresAck)) ?? false
        acknowledgedAt = try? c.decodeIfPresent(String.self, forKey: .acknowledgedAt)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        sentAt = try? c.decodeIfPresent(String.self, forKey: .sentAt)
    }

    /// Web TYPE_LABELS — Bangla verbatim.
    var typeLabel: String {
        switch type {
        case "task_dispatch": return "টাস্ক"
        case "announcement": return "ঘোষণা"
        case "reminder": return "রিমাইন্ডার"
        case "presence": return "প্রেজেন্স"
        case "coaching": return "কোচিং"
        case "feedback_ack": return "ফিডব্যাক"
        case "task_redo": return "রিডু"
        case "proof_reminder": return "প্রমাণ"
        default: return type
        }
    }
}

/// GET /api/agent/staff-monitor — flat JSON (decode a `{ ok, data }` wrapper too,
/// defensively, matching the app's other screens).
struct StaffMonitorData: Decodable {
    let today: String?
    let isHistorical: Bool?
    let historyDates: [String]
    let staffSummaries: [StaffMonitorSummary]
    let geoStatus: [StaffMonitorGeo]
    let productivityAlerts: [StaffMonitorAlert]
    let feed: [StaffMonitorFeedRow]
    let historyFeed: [StaffMonitorFeedRow]
    let unackedMessages: [StaffMonitorFeedRow]
    let geoFenceMonitoringEnabled: Bool?
    let generatedAt: String?

    private enum Keys: String, CodingKey {
        case ok, data, today, isHistorical, historyDates, staffSummaries, geoStatus
        case productivityAlerts, feed, historyFeed, unackedMessages, geoFenceMonitoringEnabled, generatedAt
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        today = try? c.decodeIfPresent(String.self, forKey: .today)
        isHistorical = try? c.decodeIfPresent(Bool.self, forKey: .isHistorical)
        historyDates = (try? c.decodeIfPresent([String].self, forKey: .historyDates)) ?? []
        staffSummaries = (try? c.decodeIfPresent([StaffMonitorSummary].self, forKey: .staffSummaries)) ?? []
        geoStatus = (try? c.decodeIfPresent([StaffMonitorGeo].self, forKey: .geoStatus)) ?? []
        productivityAlerts = (try? c.decodeIfPresent([StaffMonitorAlert].self, forKey: .productivityAlerts)) ?? []
        feed = (try? c.decodeIfPresent([StaffMonitorFeedRow].self, forKey: .feed)) ?? []
        historyFeed = (try? c.decodeIfPresent([StaffMonitorFeedRow].self, forKey: .historyFeed)) ?? []
        unackedMessages = (try? c.decodeIfPresent([StaffMonitorFeedRow].self, forKey: .unackedMessages)) ?? []
        geoFenceMonitoringEnabled = try? c.decodeIfPresent(Bool.self, forKey: .geoFenceMonitoringEnabled)
        generatedAt = try? c.decodeIfPresent(String.self, forKey: .generatedAt)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class StaffMonitorVM {
    var data: StaffMonitorData? = nil
    /// nil = live (Today); "YYYY-MM-DD" = archived day summary.
    var selectedDate: String? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    var isLive: Bool { selectedDate == nil }

    func load(silent: Bool = false) async {
        if !silent { loading = true }
        defer { if !silent { loading = false } }
        do {
            let resp: StaffMonitorData = try await AlmaAPI.shared.get(
                "/api/agent/staff-monitor", query: ["date": selectedDate])
            data = resp
            error = nil
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            // Silent 10s ticks never blank a working screen with an error banner.
            if !silent || data == nil {
                self.error = error.localizedDescription
            }
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    // ── Derived lookups for the cards / detail sheet ──

    func geo(for staffId: String) -> StaffMonitorGeo? {
        data?.geoStatus.first { $0.staffId == staffId }
    }
    func alerts(for staffId: String) -> [StaffMonitorAlert] {
        data?.productivityAlerts.filter { $0.staffId == staffId } ?? []
    }
    func messages(for staffId: String) -> [StaffMonitorFeedRow] {
        let rows = (data?.feed.isEmpty == false ? data?.feed : data?.historyFeed) ?? []
        return rows.filter { $0.staffId == staffId }
    }
    var activeCount: Int {
        // checkedIn may be missing in older payloads — treat undefined as active
        // (same rule as the web MonitorStaffCards).
        data?.staffSummaries.filter { $0.checkedIn != false }.count ?? 0
    }
    var tasksDoneTotal: (done: Int, total: Int) {
        let s = data?.staffSummaries ?? []
        return (s.reduce(0) { $0 + $1.tasksDone }, s.reduce(0) { $0 + $1.tasksTotal })
    }
}

// MARK: - Owner control panels — models (web monitor panels' exact shapes)

/// GET/PATCH /api/assistant/controls — web AgentControls (agent-controls.ts).
/// Web defaulting rule mirrored: paused only when explicitly true, capabilities
/// ON unless explicitly false, autonomy falls back to "ask".
private struct StaffMonitorAgentControls: Decodable {
    let paused: Bool
    let autonomy: String
    let webResearch: Bool
    let socialPosting: Bool
    let imageVideoGen: Bool

    private enum Keys: String, CodingKey { case paused, autonomy, capabilities }
    private enum CapKeys: String, CodingKey { case webResearch, socialPosting, imageVideoGen }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        paused = (try? c.decodeIfPresent(Bool.self, forKey: .paused)) ?? false
        autonomy = (try? c.decodeIfPresent(String.self, forKey: .autonomy)) ?? "ask"
        let caps = try? c.nestedContainer(keyedBy: CapKeys.self, forKey: .capabilities)
        webResearch = (try? caps?.decodeIfPresent(Bool.self, forKey: .webResearch)) ?? true
        socialPosting = (try? caps?.decodeIfPresent(Bool.self, forKey: .socialPosting)) ?? true
        imageVideoGen = (try? caps?.decodeIfPresent(Bool.self, forKey: .imageVideoGen)) ?? true
    }

    /// Web AUTONOMY_OPTIONS labels verbatim.
    var autonomyLabel: String {
        switch autonomy {
        case "notify": return "করে জানাও"
        case "auto": return "স্বয়ংক্রিয়"
        default: return "আগে জিজ্ঞেস"
        }
    }
}

/// GET /api/assistant/live-browser/watch — status essentials only (the native
/// panel never decodes latestScreenshot: ~100KB dataURL, web-escaped anyway).
private struct StaffMonitorWatchDevice: Decodable {
    let name: String
    let online: Bool
    private enum Keys: String, CodingKey { case name, online }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "Chrome"
        online = (try? c.decodeIfPresent(Bool.self, forKey: .online)) ?? false
    }
}

private struct StaffMonitorWatchStep: Decodable {
    let action: String
    let target: String
    let status: String
    private enum Keys: String, CodingKey { case action, target, status }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        action = (try? c.decodeIfPresent(String.self, forKey: .action)) ?? ""
        target = (try? c.decodeIfPresent(String.self, forKey: .target)) ?? ""
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
    }
}

private struct StaffMonitorWatchFeed: Decodable {
    let enabled: Bool
    let devices: [StaffMonitorWatchDevice]
    let steps: [StaffMonitorWatchStep]

    private enum Keys: String, CodingKey { case enabled, devices, steps }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        devices = (try? c.decodeIfPresent([StaffMonitorWatchDevice].self, forKey: .devices)) ?? []
        steps = (try? c.decodeIfPresent([StaffMonitorWatchStep].self, forKey: .steps)) ?? []
    }

    var onlineCount: Int { devices.filter(\.online).count }
    /// Web LiveBrowserWatchPanel `running` rule verbatim.
    var running: Bool { steps.contains { $0.status == "queued" || $0.status == "delivered" } }
    var currentStep: StaffMonitorWatchStep? {
        steps.first { $0.status == "queued" || $0.status == "delivered" }
    }
}

/// Web ACTION_BN table (subset shown on the one-line "current step" status).
private func staffMonitorActionBN(_ action: String) -> String {
    switch action {
    case "navigate": return "🌐 পেজ খুলছে"
    case "read_text": return "📖 পড়ছে"
    case "read_dom": return "👀 দেখছে"
    case "click": return "🖱️ ক্লিক"
    case "type": return "⌨️ লিখছে"
    case "press": return "⏎ কী চাপছে"
    case "select_option": return "🔽 অপশন বাছছে"
    case "hover": return "🫳 হোভার"
    case "scroll", "scroll_to": return "↕️ স্ক্রল"
    case "wait": return "⏳ অপেক্ষা"
    case "screenshot": return "📸 স্ক্রিনশট"
    case "go_back": return "↩️ পিছনে"
    case "switch_tab": return "🗂️ ট্যাব বদল"
    case "close_tab": return "❌ ট্যাব বন্ধ"
    case "ping": return "📡 পিং"
    default: return action
    }
}

/// GET /api/assistant/heartbeat?limit=1 — settings.enabled + wakesToday only.
private struct StaffMonitorHeartbeatStatus: Decodable {
    let enabled: Bool
    let wakesToday: Int
    private enum Keys: String, CodingKey { case settings, wakesToday }
    private enum SettingsKeys: String, CodingKey { case enabled }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let s = try? c.nestedContainer(keyedBy: SettingsKeys.self, forKey: .settings)
        enabled = (try? s?.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        wakesToday = staffMonitorFlexInt(c, .wakesToday) ?? 0
    }
}

/// GET /api/assistant/models — reduced to an on/off count for the status row.
private struct StaffMonitorModelsStatus: Decodable {
    let total: Int
    let on: Int
    private enum Keys: String, CodingKey { case models }
    private struct Row: Decodable {
        let enabled: Bool
        private enum RKeys: String, CodingKey { case enabled }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: RKeys.self)
            enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true
        }
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let rows = (try? c.decodeIfPresent([Row].self, forKey: .models)) ?? []
        total = rows.count
        on = rows.filter(\.enabled).count
    }
}

/// The four mutating actions the native panel offers — each carries its own
/// Bangla confirm copy so a single confirmationDialog serves all of them.
private enum StaffMonitorControlAction {
    case pauseAgent, resumeAgent, stopBrowser, resumeBrowser

    var title: String {
        switch self {
        case .pauseAgent: return "Agent বন্ধ করবেন?"
        case .resumeAgent: return "Agent আবার চালু করবেন?"
        case .stopBrowser: return "লাইভ ব্রাউজার — সব থামাবেন?"
        case .resumeBrowser: return "লাইভ ব্রাউজার আবার চালু করবেন?"
        }
    }
    var message: String {
        switch self {
        case .pauseAgent: return "এখন কোনো উত্তর বা কাজ করবে না (ওয়েব + টেলিগ্রাম)।"
        case .resumeAgent: return "Agent আবার উত্তর ও কাজ শুরু করবে।"
        case .stopBrowser: return "সার্ভার-সাইড কিল-সুইচ — অপেক্ষমাণ সব কমান্ড সাথে সাথে বাতিল হবে।"
        case .resumeBrowser: return "Agent আবার আপনার Chrome-এ কাজ করতে পারবে।"
        }
    }
    var confirmLabel: String {
        switch self {
        case .pauseAgent: return "🛑 Agent বন্ধ করুন"
        case .resumeAgent: return "🟢 চালু করুন"
        case .stopBrowser: return "⏹ সব থামাও"
        case .resumeBrowser: return "▶️ আবার চালু করো"
        }
    }
    var isDestructive: Bool {
        switch self {
        case .pauseAgent, .stopBrowser: return true
        case .resumeAgent, .resumeBrowser: return false
        }
    }
}

// MARK: - Owner control panels — view model

@available(iOS 17.0, *)
@Observable
private final class StaffMonitorControlsVM {
    var controls: StaffMonitorAgentControls? = nil
    var watch: StaffMonitorWatchFeed? = nil
    var heartbeat: StaffMonitorHeartbeatStatus? = nil
    var models: StaffMonitorModelsStatus? = nil
    var busy = false
    var actionError: String? = nil

    /// Each GET fails independently — a 403 (non-owner), AGENT_ENABLED gate, or
    /// cold start just hides that panel; the rest of the screen never blanks.
    func loadAll() async {
        if let c: StaffMonitorAgentControls = try? await AlmaAPI.shared.get("/api/assistant/controls") {
            controls = c
        }
        await refreshWatch()
        if let h: StaffMonitorHeartbeatStatus =
            try? await AlmaAPI.shared.get("/api/assistant/heartbeat", query: ["limit": "1"]) {
            heartbeat = h
        }
        if let m: StaffMonitorModelsStatus = try? await AlmaAPI.shared.get("/api/assistant/models") {
            models = m
        }
    }

    func refreshWatch() async {
        if let w: StaffMonitorWatchFeed =
            try? await AlmaAPI.shared.get("/api/assistant/live-browser/watch", query: ["limit": "30"]) {
            watch = w
        }
    }

    /// PATCH {paused} — exactly the web AgentControlCenter payload. The route
    /// echoes the full updated controls back; showing that echo (not an
    /// optimistic flip) IS the verification.
    func setPaused(_ paused: Bool) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        struct Body: Encodable { let paused: Bool }
        do {
            let updated: StaffMonitorAgentControls =
                try await AlmaAPI.shared.send("PATCH", "/api/assistant/controls", body: Body(paused: paused))
            controls = updated
            actionError = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            actionError = "পরিবর্তন ব্যর্থ: \(error.localizedDescription)"
        }
    }

    /// POST {action: stop|resume} — web LiveBrowserWatchPanel payload. Server
    /// replies {ok, enabled}; the feed is re-fetched so the pill shows the
    /// server's verified state.
    func liveBrowser(stop: Bool) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        struct Body: Encodable { let action: String }
        struct Resp: Decodable { let ok: Bool?; let enabled: Bool? }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/live-browser/watch", body: Body(action: stop ? "stop" : "resume"))
            if r.ok == true {
                actionError = nil
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } else {
                actionError = "ব্যর্থ — আবার চেষ্টা করুন"
            }
        } catch {
            actionError = "ব্যর্থ: \(error.localizedDescription)"
        }
        await refreshWatch()
    }
}

// MARK: - Owner control panels — section view

@available(iOS 17.0, *)
private struct StaffMonitorControlsSection: View {
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = StaffMonitorControlsVM()
    @State private var pending: StaffMonitorControlAction? = nil

    var body: some View {
        VStack(spacing: 10) {
            if vm.controls != nil { controlCenterCard }
            if vm.watch != nil { liveBrowserCard }
            if vm.heartbeat != nil || vm.models != nil { statusCard }
        }
        .task {
            await vm.loadAll()
            // Watch state must stay fresh (emergency panel); 10s matches the
            // screen's own live cadence. Cancelled with the view, like the parent.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if Task.isCancelled { break }
                await vm.refreshWatch()
            }
        }
        .confirmationDialog(
            pending?.title ?? "",
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
            titleVisibility: .visible,
            presenting: pending
        ) { action in
            Button(action.confirmLabel, role: action.isDestructive ? .destructive : nil) {
                run(action)
            }
            Button("বাতিল", role: .cancel) {}
        } message: { action in
            Text(action.message)
        }
    }

    private func run(_ action: StaffMonitorControlAction) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task {
            switch action {
            case .pauseAgent: await vm.setPaused(true)
            case .resumeAgent: await vm.setPaused(false)
            case .stopBrowser: await vm.liveBrowser(stop: true)
            case .resumeBrowser: await vm.liveBrowser(stop: false)
            }
        }
    }

    // ── 🎛️ Control Center: native master pause + read-only autonomy/capabilities ──

    @ViewBuilder private var controlCenterCard: some View {
        if let c = vm.controls {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Text("🎛️ কন্ট্রোল সেন্টার")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    if vm.busy { ProgressView().controlSize(.mini) }
                }
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.paused ? "🛑 Agent বন্ধ আছে" : "🟢 Agent চালু আছে")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(c.paused ? StaffMonitorPalette.red500
                                                      : StaffMonitorPalette.emerald600)
                        Text(c.paused
                             ? "এখন কোনো উত্তর বা কাজ করবে না (ওয়েব + টেলিগ্রাম)।"
                             : "সব কিছু বন্ধ করতে চাইলে সুইচ দিয়ে সাথে সাথে থামান।")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    // Binding never flips optimistically — it only raises the confirm
                    // dialog; the switch moves when the server echo lands.
                    Toggle("", isOn: Binding(
                        get: { !c.paused },
                        set: { on in pending = on ? .resumeAgent : .pauseAgent }))
                        .labelsHidden()
                        .tint(StaffMonitorPalette.emerald600)
                        .disabled(vm.busy)
                }
                Divider().opacity(0.4)
                // READ-ONLY (owner spec): changing autonomy/capabilities stays on web.
                readOnlyRow("🧭 অটোনমি", c.autonomyLabel)
                readOnlyRow("🔎 ওয়েব রিসার্চ", c.webResearch ? "চালু" : "বন্ধ", ok: c.webResearch)
                readOnlyRow("📣 সোশ্যাল পোস্ট ও অ্যাড", c.socialPosting ? "চালু" : "বন্ধ", ok: c.socialPosting)
                readOnlyRow("🎨 ছবি ও ভিডিও", c.imageVideoGen ? "চালু" : "বন্ধ", ok: c.imageVideoGen)
                if let err = vm.actionError {
                    Text(err).font(.caption2).foregroundStyle(StaffMonitorPalette.red500)
                }
                webChangeLink("অটোনমি ও ফিচার বদলাতে — ওয়েবে খুলুন")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    // ── 🖥️ Live Browser: native emergency STOP/resume + read-only status line ──

    @ViewBuilder private var liveBrowserCard: some View {
        if let w = vm.watch {
            let tint = w.enabled ? StaffMonitorPalette.red500 : StaffMonitorPalette.emerald600
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Text("🖥️ লাইভ ব্রাউজার")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    if w.running {
                        statusPill("🤖 কাজ চলছে", StaffMonitorPalette.amber600)
                    }
                    statusPill(w.enabled ? "🟢 চালু · অনলাইন \(w.onlineCount)" : "🔴 বন্ধ",
                               w.enabled ? StaffMonitorPalette.emerald600 : .secondary)
                }
                if let step = w.currentStep {
                    Text("\(staffMonitorActionBN(step.action))\(step.target.isEmpty ? "" : " · \(step.target)")")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    pending = w.enabled ? .stopBrowser : .resumeBrowser
                } label: {
                    Text(w.enabled ? "⏹ সব থামাও" : "▶️ আবার চালু করো")
                        .font(.footnote.weight(.bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(tint.opacity(0.15), in: Capsule())
                        .foregroundStyle(tint)
                        .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(vm.busy)
                webChangeLink("স্ক্রিনশট ও লাইভ স্টেপ ফিড — ওয়েবে খুলুন")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    // ── 💓/🧠 Heartbeat + models: read-only status rows only ──

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("এজেন্ট স্ট্যাটাস")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            if let h = vm.heartbeat {
                readOnlyRow("💓 হার্টবিট",
                            h.enabled ? "চালু · আজ \(h.wakesToday) বার জেগেছে" : "বন্ধ",
                            ok: h.enabled)
            }
            if let m = vm.models {
                readOnlyRow("🧠 মডেল", "\(m.on)/\(m.total) চালু", ok: m.on > 0)
            }
            webChangeLink("হার্টবিট ও মডেল কন্ট্রোল — ওয়েবে খুলুন")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Shared bits ──

    private func readOnlyRow(_ label: String, _ value: String, ok: Bool? = nil) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.primary.opacity(0.85))
            Spacer()
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(ok == nil ? StaffMonitorPalette.accentText(colorScheme)
                                 : (ok == true ? StaffMonitorPalette.emerald600
                                               : StaffMonitorPalette.red500))
        }
    }

    private func statusPill(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(color.opacity(0.10), in: Capsule())
            .overlay(Capsule().strokeBorder(color.opacity(0.30), lineWidth: 0.8))
    }

    private func webChangeLink(_ label: String) -> some View {
        Button { openWeb("/agent/staff-monitor", "Staff monitor") } label: {
            Label(label, systemImage: "safari").font(.caption2)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct StaffMonitorScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = StaffMonitorVM()
    @State private var selected: StaffMonitorSummary? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                headerBar
                dayChips
                if vm.authExpired { authCard }
                if let err = vm.error, vm.data == nil { errorCard(err) }
                if vm.data != nil { kpiStrip }
                // Owner control panels (web page order: control panels above staff blocks).
                if !vm.authExpired { StaffMonitorControlsSection(openWeb: openWeb) }
                geoFenceNote
                if vm.loading && vm.data == nil { loadingRows }
                staffCards
                alertsSection
                if let d = vm.data, !vm.loading, d.staffSummaries.isEmpty, vm.error == nil, !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(StaffMonitorAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task {
            await vm.load()
            // Web parity: auto-refresh every 10s while live; SwiftUI cancels this
            // task when the screen leaves the hierarchy.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if Task.isCancelled { break }
                if vm.isLive { await vm.load(silent: true) }
            }
        }
        .sheet(item: $selected) { s in
            StaffMonitorDetailSheet(summary: s, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Header: Live pulse / archive badge + meta line (web sticky header parity) ──

    private var headerBar: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Staff Monitor").font(.subheadline.weight(.bold))
                Text(metaLine).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            if vm.isLive { livePulse } else if let d = vm.selectedDate { archiveBadge(d) }
        }
        .padding(.top, 4)
    }

    private var metaLine: String {
        guard let d = vm.data else { return "কন্ট্রোল • হার্টবিট • স্টাফ মনিটর" }
        if !vm.isLive { return "Viewing archive · press \"Today\" to return" }
        var bits: [String] = []
        if let today = d.today { bits.append(today) }
        bits.append("auto-refresh 10s")
        if let t = StaffMonitorFormat.clock(d.generatedAt) { bits.append("last \(t)") }
        return bits.joined(separator: " · ")
    }

    private var livePulse: some View {
        HStack(spacing: 5) {
            Circle().fill(StaffMonitorPalette.emerald600).frame(width: 7, height: 7)
                .shadow(color: StaffMonitorPalette.emerald600.opacity(0.6), radius: 3)
            Text("LIVE").font(.caption2.weight(.heavy))
                .foregroundStyle(StaffMonitorPalette.emerald600)
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(StaffMonitorPalette.emerald600.opacity(0.10), in: Capsule())
        .overlay(Capsule().strokeBorder(StaffMonitorPalette.emerald600.opacity(0.30), lineWidth: 1))
    }

    private func archiveBadge(_ date: String) -> some View {
        HStack(spacing: 5) {
            Circle().fill(Color.secondary).frame(width: 7, height: 7)
            Text(date).font(.caption2.weight(.bold)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(Color.primary.opacity(0.06), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.12), lineWidth: 1))
    }

    // ── Day summary chips: Today (live) + archived dates ──

    @ViewBuilder private var dayChips: some View {
        if let dates = vm.data?.historyDates, !dates.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    staffMonitorChip("Today", active: vm.isLive) {
                        vm.selectedDate = nil
                        Task { await vm.load() }
                    }
                    ForEach(dates, id: \.self) { d in
                        staffMonitorChip(d, active: vm.selectedDate == d) {
                            vm.selectedDate = d
                            Task { await vm.load() }
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    // ── KPI strip: active staff / tasks / unacked (web header badges + alert count) ──

    private var kpiStrip: some View {
        let tasks = vm.tasksDoneTotal
        let unacked = vm.data?.unackedMessages.count ?? 0
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("ACTIVE", "\(vm.activeCount)",
                        vm.activeCount > 0 ? StaffMonitorPalette.emerald600 : .primary)
                kpiCard("TASKS", "\(tasks.done)/\(tasks.total)", .primary)
                kpiCard("UNACKED", "\(unacked)",
                        unacked > 0 ? StaffMonitorPalette.amber600 : .primary)
                kpiCard("STAFF", "\(vm.data?.staffSummaries.count ?? 0)",
                        StaffMonitorPalette.accentText(colorScheme))
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    private func kpiCard(_ label: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.headline.weight(.bold)).foregroundStyle(tint)
        }
        .frame(minWidth: 84, alignment: .leading)
        .padding(12)
        .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Geo-fence OFF note (web Bangla string verbatim) ──

    @ViewBuilder private var geoFenceNote: some View {
        if vm.data?.geoFenceMonitoringEnabled == false {
            Label("Office time-এ continuous location tracking বন্ধ। Attendance check-in/out-এ location এখনও বাধ্যতামূলক।",
                  systemImage: "location.slash")
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    // ── Staff cards ──

    @ViewBuilder private var staffCards: some View {
        if let summaries = vm.data?.staffSummaries, !summaries.isEmpty {
            ForEach(summaries) { s in
                StaffMonitorCard(
                    summary: s,
                    geo: vm.geo(for: s.staffId),
                    alertCount: vm.alerts(for: s.staffId).count,
                    onTap: { selected = s })
            }
        }
    }

    // ── Productivity alerts (web "⚡ Productivity" block) ──

    @ViewBuilder private var alertsSection: some View {
        if let alerts = vm.data?.productivityAlerts, !alerts.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("⚡ Productivity")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                ForEach(Array(alerts.enumerated()), id: \.offset) { _, a in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(a.staffName ?? "—").font(.caption.weight(.bold))
                        Text(a.message).font(.caption).foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("👥").font(.largeTitle)
            Text("আজকে কোনো স্টাফ অ্যাক্টিভ নেই।")
                .foregroundStyle(.secondary)
        }
        .padding(.top, 60)
        .padding(.bottom, 30)
    }

    // ── Shared bits ──

    private func staffMonitorChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? StaffMonitorPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? StaffMonitorPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? StaffMonitorPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func errorCard(_ message: String) -> some View {
        VStack(spacing: 10) {
            Label("লোড করা যায়নি: \(message)", systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(StaffMonitorPalette.red500)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("আবার চেষ্টা") { Task { await vm.load() } }
                .font(.footnote.weight(.semibold))
                .buttonStyle(.bordered)
                .tint(StaffMonitorPalette.coral)
        }
        .padding(12)
        .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 110)
                .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .staffMonitorShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/agent/staff-monitor", "Staff monitor")
        } label: {
            Label("সব কন্ট্রোল ও অ্যাকশন (টাস্ক দাও • মেসেজ • এসকালেট) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Staff card (web MonitorStaffCards / MonitorStaffHub row parity)

@available(iOS 17.0, *)
private struct StaffMonitorCard: View {
    let summary: StaffMonitorSummary
    let geo: StaffMonitorGeo?
    let alertCount: Int
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let status = StaffMonitorPalette.status(summary)
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .center, spacing: 10) {
                StaffMonitorAvatar(name: summary.staffName, dot: status.color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(summary.staffName).font(.footnote.weight(.semibold)).lineLimit(1)
                    locationLine
                }
                Spacer(minLength: 4)
                Text(status.label)
                    .font(.system(size: 9, weight: .bold))
                    .textCase(.uppercase)
                    .foregroundStyle(status.color)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(status.color.opacity(0.12), in: Capsule())
                    .overlay(Capsule().strokeBorder(status.color.opacity(0.30), lineWidth: 0.8))
            }

            // Day-progress bar (web: coral→teal gradient + tabular % on the right)
            HStack(spacing: 8) {
                StaffMonitorProgressBar(percent: summary.completionPct)
                Text("\(summary.completionPct)%")
                    .font(.caption2.weight(.bold).monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Text("📤 \(summary.dispatched)").font(.caption2).foregroundStyle(.secondary)
                Text("✓ \(summary.delivered)").font(.caption2).foregroundStyle(.secondary)
                if summary.failed > 0 {
                    Text("✗ \(summary.failed)").font(.caption2.weight(.bold))
                        .foregroundStyle(StaffMonitorPalette.red500)
                }
                if alertCount > 0 {
                    Text("⚡ \(alertCount)").font(.caption2.weight(.bold))
                        .foregroundStyle(StaffMonitorPalette.amber600)
                }
                Spacer()
                Text("🎯 \(summary.tasksDone)/\(summary.tasksTotal)")
                    .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }

    /// Location line: geo-fence state (Bangla verbatim) + relative last-seen time.
    private var locationLine: some View {
        let g = StaffMonitorPalette.geo(geo?.status)
        var text = "\(g.icon) \(g.text)"
        if geo?.status == "outside", let d = geo?.distanceM { text += " (\(d)m)" }
        let seen = geo?.lastUpdate ?? summary.lastActivityAt
        if let ago = StaffMonitorFormat.timeAgo(seen), !ago.isEmpty { text += " · \(ago)" }
        return Text(text).font(.caption2).foregroundStyle(g.color).lineLimit(1)
    }
}

/// Initials avatar + live status dot (web StaffInitial + dot overlay).
@available(iOS 17.0, *)
private struct StaffMonitorAvatar: View {
    let name: String
    let dot: Color

    var body: some View {
        Text(StaffMonitorFormat.initials(name))
            .font(.subheadline.weight(.black))
            .foregroundStyle(StaffMonitorPalette.coral)
            .frame(width: 38, height: 38)
            .background(
                LinearGradient(colors: [StaffMonitorPalette.coral.opacity(0.20),
                                        StaffMonitorPalette.teal.opacity(0.10)],
                               startPoint: .topLeading, endPoint: .bottomTrailing),
                in: Circle())
            .overlay(Circle().strokeBorder(StaffMonitorPalette.coral.opacity(0.25), lineWidth: 1))
            .overlay(alignment: .bottomTrailing) {
                Circle()
                    .fill(dot)
                    .frame(width: 11, height: 11)
                    .overlay(Circle().strokeBorder(Color.white.opacity(0.9), lineWidth: 1.6))
                    .shadow(color: dot.opacity(0.55), radius: 3)
                    .offset(x: 1.5, y: 1.5)
            }
    }
}

/// Web progress bar: coral→teal gradient fill on a faint track.
@available(iOS 17.0, *)
private struct StaffMonitorProgressBar: View {
    let percent: Int

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                if percent > 0 {
                    Capsule()
                        .fill(LinearGradient(colors: [StaffMonitorPalette.coral, StaffMonitorPalette.teal],
                                             startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(6, geo.size.width * CGFloat(min(percent, 100)) / 100))
                }
            }
        }
        .frame(height: 6)
    }
}

// MARK: - Detail sheet (per-staff: progress · location · alerts · today's messages)

@available(iOS 17.0, *)
private struct StaffMonitorDetailSheet: View {
    let summary: StaffMonitorSummary
    let vm: StaffMonitorVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    private var geo: StaffMonitorGeo? { vm.geo(for: summary.staffId) }
    private var alerts: [StaffMonitorAlert] { vm.alerts(for: summary.staffId) }
    private var messages: [StaffMonitorFeedRow] { vm.messages(for: summary.staffId) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                progressCard
                locationCard
                if !alerts.isEmpty { alertsCard }
                messagesCard
                webLink
            }
            .padding(18)
        }
        .presentationBackground { StaffMonitorAurora() }
    }

    private var header: some View {
        let status = StaffMonitorPalette.status(summary)
        return HStack(spacing: 12) {
            StaffMonitorAvatar(name: summary.staffName, dot: status.color)
            VStack(alignment: .leading, spacing: 2) {
                Text(summary.staffName).font(.headline)
                HStack(spacing: 6) {
                    Text(status.label)
                        .font(.caption2.weight(.heavy)).textCase(.uppercase)
                        .foregroundStyle(status.color)
                    if let ago = StaffMonitorFormat.timeAgo(summary.lastActivityAt), !ago.isEmpty {
                        Text("· \(ago)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer()
        }
    }

    private var progressCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("আজকের অগ্রগতি")
                .font(.caption2.weight(.heavy)).textCase(.uppercase).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Text("\(summary.completionPct)%")
                    .font(.title3.weight(.bold).monospacedDigit())
                    .foregroundStyle(summary.completionPct >= 100
                                     ? StaffMonitorPalette.emerald600
                                     : StaffMonitorPalette.accentText(colorScheme))
                StaffMonitorProgressBar(percent: summary.completionPct)
            }
            HStack(spacing: 0) {
                statCell("📤", "\(summary.dispatched)", "Dispatched")
                statCell("✓", "\(summary.delivered)", "Delivered")
                statCell("✗", "\(summary.failed)", "Failed",
                         tint: summary.failed > 0 ? StaffMonitorPalette.red500 : .secondary)
                statCell("🎯", "\(summary.tasksDone)/\(summary.tasksTotal)", "Tasks")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func statCell(_ icon: String, _ value: String, _ label: String,
                          tint: Color = .primary) -> some View {
        VStack(spacing: 2) {
            Text(icon).font(.caption)
            Text(value).font(.footnote.weight(.bold).monospacedDigit()).foregroundStyle(tint)
            Text(label).font(.system(size: 9)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private var locationCard: some View {
        let g = StaffMonitorPalette.geo(geo?.status)
        return VStack(alignment: .leading, spacing: 6) {
            Text("লোকেশন")
                .font(.caption2.weight(.heavy)).textCase(.uppercase).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Text("\(g.icon) \(g.text)\(geo?.status == "outside" ? (geo?.distanceM).map { " (\($0)m)" } ?? "" : "")")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(g.color)
                Spacer()
                if let link = geo?.mapsLink, let url = URL(string: link) {
                    Link(destination: url) {
                        Label("ম্যাপ", systemImage: "map")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(StaffMonitorPalette.accentText(colorScheme))
                    }
                }
            }
            if let ago = StaffMonitorFormat.timeAgo(geo?.lastUpdate), !ago.isEmpty {
                Text("শেষ আপডেট \(ago)").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var alertsCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("⚡ Productivity")
                .font(.caption2.weight(.heavy)).textCase(.uppercase).foregroundStyle(.secondary)
            ForEach(Array(alerts.enumerated()), id: \.offset) { _, a in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(a.message).font(.caption).foregroundStyle(StaffMonitorPalette.amber600)
                    Spacer(minLength: 0)
                    if let t = StaffMonitorFormat.clock(a.at) {
                        Text(t).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var messagesCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("আজকের মেসেজ")
                .font(.caption2.weight(.heavy)).textCase(.uppercase).foregroundStyle(.secondary)
            if messages.isEmpty {
                Text("এই স্টাফের অতিরিক্ত ডেটা এখনও নেই।")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(messages.prefix(12)) { m in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(m.typeLabel)
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(StaffMonitorPalette.accentText(colorScheme))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(StaffMonitorPalette.coral.opacity(0.12), in: Capsule())
                            if let t = StaffMonitorFormat.clock(m.sentAt ?? m.createdAt) {
                                Text(t).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                            }
                            Spacer()
                            ackBadge(m)
                        }
                        Text(m.content)
                            .font(.caption)
                            .foregroundStyle(.primary.opacity(0.85))
                            .lineLimit(4)
                    }
                    .padding(.vertical, 2)
                    if m.id != messages.prefix(12).last?.id { Divider().opacity(0.4) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    /// Web AckBadge parity: ✓ time · ⏳ unseen · sending…
    @ViewBuilder private func ackBadge(_ m: StaffMonitorFeedRow) -> some View {
        if let ack = m.acknowledgedAt, let t = StaffMonitorFormat.clock(ack) {
            Text("✓ \(t)")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(StaffMonitorPalette.emerald600)
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(StaffMonitorPalette.emerald600.opacity(0.10), in: Capsule())
        } else if m.status == "delivered" || m.status == "sent" {
            Text("⏳ unseen")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(StaffMonitorPalette.amber600)
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(StaffMonitorPalette.amber500.opacity(0.10), in: Capsule())
        } else if m.status == "queued" || m.status == "pending" {
            Text("sending…")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/agent/staff-monitor", "Staff monitor")
        } label: {
            Label("টাস্ক দাও • মেসেজ • এসকালেট — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Formatting helpers (web util parity)

private enum StaffMonitorFormat {
    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// Web fmtTime: HH:mm in Asia/Dhaka.
    static func clock(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    /// Bangla relative time — the app's shared strings.
    static func timeAgo(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let mins = Int(Date().timeIntervalSince(date) / 60)
        if mins < 1 { return "এইমাত্র" }
        if mins < 60 { return "\(mins) মিনিট আগে" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs) ঘণ্টা আগে" }
        return "\(hrs / 24) দিন আগে"
    }

    /// Web StaffInitial: single first letter, uppercased.
    static func initials(_ name: String) -> String {
        guard let first = name.trimmingCharacters(in: .whitespaces).first else { return "?" }
        return String(first).uppercased()
    }
}

// MARK: - Aurora background + glass (StaffMonitor-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct StaffMonitorAurora: View {
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
    func staffMonitorGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct StaffMonitorShimmer: ViewModifier {
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
    func staffMonitorShimmer() -> some View { modifier(StaffMonitorShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Staff Monitor — Light") {
    StaffMonitorScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
