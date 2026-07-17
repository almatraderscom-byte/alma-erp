//
//  StaffMonitorSwiftUI.swift
//  ALMA ERP — LIVE Business Monitor as a compact five-tab native control room.
//
//  NP-1 shell (roadmap §4 mobile IA): sticky status strip (LIVE pulse + Agent /
//  Browser / Heartbeat / alert chips) + five tabs — Overview · Agents · Staff ·
//  Feed · System — with the date/history control under the tabs. The old single
//  oversized vertical page is retired; every tab renders lazy content only.
//  /agent/live-watch deep-links here with the Agents tab selected (AG-08 —
//  one canonical native implementation, never a WKWebView).
//
//  Data: same endpoints the web page fetches:
//    GET /api/agent/staff-monitor            → live staff summaries + geo + feed
//    GET /api/agent/staff-monitor?date=YYYY-MM-DD → archived day summary
//
//  Owner control panels (NP-2, full parity): the Agents tab now lives in
//  StaffMonitorAgentsSwiftUI.swift — control center (pause/autonomy/capabilities),
//  Autonomy SLO, per-model toggles, heartbeat timeline + actions, live browser
//  watch (devices/screenshot/steps/stop), and the model-routing dial. The screen
//  owns ONE StaffMonitorControlsVM (status-strip chips read it on every tab).
//  Every mutating action passes a Bangla confirmationDialog first when dangerous,
//  and the server's echoed state is what the UI shows — never an optimistic guess.
//
//  Blocks: Live/Archive day chips · KPI strip (active/tasks/unacked) · staff
//  cards with initials avatars + live status dots + day-progress bars + location
//  line (geo status + relative Bangla time) · per-staff detail sheet (progress,
//  location, productivity alerts, today's messages with ack badges).
//  Carried lessons: lenient decoding, cancellation-safe refresh.
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

/// Web AgentDutyRow.
struct StaffMonitorDuty: Decodable, Identifiable {
    let id: String
    let duty: String
    let label: String
    let status: String
    let detail: String?
    let ranAt: String?
    let time: String?
    private enum Keys: String, CodingKey { case id, duty, label, status, detail, ranAt, time }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        duty = (try? c.decodeIfPresent(String.self, forKey: .duty)) ?? ""
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? duty
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "pending"
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
        ranAt = try? c.decodeIfPresent(String.self, forKey: .ranAt)
        time = try? c.decodeIfPresent(String.self, forKey: .time)
    }
}

/// Web SalahDutyRow.
struct StaffMonitorSalah: Decodable, Identifiable {
    let waqt: String
    let label: String
    let scheduledTime: String
    let status: String
    let doneTime: String?
    let reminders: Int
    var id: String { waqt }
    private enum Keys: String, CodingKey { case waqt, label, scheduledTime, status, doneTime, reminders }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        waqt = (try? c.decodeIfPresent(String.self, forKey: .waqt)) ?? UUID().uuidString
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? waqt
        scheduledTime = (try? c.decodeIfPresent(String.self, forKey: .scheduledTime)) ?? ""
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? "pending"
        doneTime = try? c.decodeIfPresent(String.self, forKey: .doneTime)
        reminders = staffMonitorFlexInt(c, .reminders) ?? 0
    }
}

/// Web ContinuousServiceHealth.
struct StaffMonitorService: Decodable, Identifiable {
    let key: String
    let label: String
    let healthy: Bool
    var id: String { key }
    private enum Keys: String, CodingKey { case key, label, healthy }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        key = (try? c.decodeIfPresent(String.self, forKey: .key)) ?? UUID().uuidString
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? key
        healthy = (try? c.decodeIfPresent(Bool.self, forKey: .healthy)) ?? false
    }
}

/// Web MonitorWarning.
struct StaffMonitorWarning: Decodable {
    let severity: String
    let kind: String
    let message: String
    private enum Keys: String, CodingKey { case severity, kind, message }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        severity = (try? c.decodeIfPresent(String.self, forKey: .severity)) ?? "warn"
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? ""
    }
}

/// Web PendingApprovalRow.
struct StaffMonitorApproval: Decodable, Identifiable {
    let id: String
    let type: String
    let summary: String
    let createdAt: String?
    let staffName: String?
    private enum Keys: String, CodingKey { case id, type, summary, createdAt, staffName }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? ""
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        staffName = try? c.decodeIfPresent(String.self, forKey: .staffName)
    }
}

/// Web ActiveReminderRow / ActiveTodoRow (feed tab cards).
struct StaffMonitorReminder: Decodable, Identifiable {
    let id: String
    let title: String
    let dueAt: String?
    private enum Keys: String, CodingKey { case id, title, dueAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        dueAt = try? c.decodeIfPresent(String.self, forKey: .dueAt)
    }
}

struct StaffMonitorTodo: Decodable, Identifiable {
    let id: String
    let title: String
    let priority: String
    let dueHint: String?
    private enum Keys: String, CodingKey { case id, title, priority, dueHint }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        priority = (try? c.decodeIfPresent(String.self, forKey: .priority)) ?? ""
        dueHint = try? c.decodeIfPresent(String.self, forKey: .dueHint)
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
    let failures: [StaffMonitorFeedRow]
    let geoFenceMonitoringEnabled: Bool?
    let generatedAt: String?
    // NP-3 additions (web payload fields the tabs render)
    let agentDuties: [StaffMonitorDuty]
    let salahDuties: [StaffMonitorSalah]
    let continuousServices: [StaffMonitorService]
    let warnings: [StaffMonitorWarning]
    let pendingApprovals: [StaffMonitorApproval]
    let activeReminders: [StaffMonitorReminder]
    let activeTodos: [StaffMonitorTodo]
    var dutyEnabled: [String: Bool]
    let dutyTimeOverrides: [String: String]

    private enum Keys: String, CodingKey {
        case ok, data, today, isHistorical, historyDates, staffSummaries, geoStatus
        case productivityAlerts, feed, historyFeed, unackedMessages, failures
        case geoFenceMonitoringEnabled, generatedAt
        case agentDuties, salahDuties, continuousServices, warnings, pendingApprovals
        case activeReminders, activeTodos, dutyEnabled, dutyTimeOverrides
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
        failures = (try? c.decodeIfPresent([StaffMonitorFeedRow].self, forKey: .failures)) ?? []
        geoFenceMonitoringEnabled = try? c.decodeIfPresent(Bool.self, forKey: .geoFenceMonitoringEnabled)
        generatedAt = try? c.decodeIfPresent(String.self, forKey: .generatedAt)
        agentDuties = (try? c.decodeIfPresent([StaffMonitorDuty].self, forKey: .agentDuties)) ?? []
        salahDuties = (try? c.decodeIfPresent([StaffMonitorSalah].self, forKey: .salahDuties)) ?? []
        continuousServices = (try? c.decodeIfPresent([StaffMonitorService].self, forKey: .continuousServices)) ?? []
        warnings = (try? c.decodeIfPresent([StaffMonitorWarning].self, forKey: .warnings)) ?? []
        pendingApprovals = (try? c.decodeIfPresent([StaffMonitorApproval].self, forKey: .pendingApprovals)) ?? []
        activeReminders = (try? c.decodeIfPresent([StaffMonitorReminder].self, forKey: .activeReminders)) ?? []
        activeTodos = (try? c.decodeIfPresent([StaffMonitorTodo].self, forKey: .activeTodos)) ?? []
        dutyEnabled = (try? c.decodeIfPresent([String: Bool].self, forKey: .dutyEnabled)) ?? [:]
        dutyTimeOverrides = (try? c.decodeIfPresent([String: String].self, forKey: .dutyTimeOverrides)) ?? [:]
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

// MARK: - Monitor tabs (web MonitorTabs parity — five tabs, neon accents verbatim)

enum StaffMonitorTab: String, CaseIterable {
    case overview, agents, staff, feed, system

    var label: String {
        switch self {
        case .overview: return "Overview"
        case .agents: return "Agents"
        case .staff: return "Staff"
        case .feed: return "Feed"
        case .system: return "System"
        }
    }
    var icon: String {
        switch self {
        case .overview: return "📊"
        case .agents: return "🤖"
        case .staff: return "👥"
        case .feed: return "📨"
        case .system: return "⚙️"
        }
    }
    /// Web MonitorTabs neon hexes verbatim (#5B8CFF/#A855F7/#EC4899/#22D3A5/#E07A5F).
    var neon: Color {
        switch self {
        case .overview: return Color(red: 0.357, green: 0.549, blue: 1.000)
        case .agents: return Color(red: 0.659, green: 0.333, blue: 0.969)
        case .staff: return Color(red: 0.925, green: 0.282, blue: 0.600)
        case .feed: return Color(red: 0.133, green: 0.827, blue: 0.647)
        case .system: return Color(red: 0.878, green: 0.478, blue: 0.373)
        }
    }
}

@available(iOS 17.0, *)
struct StaffMonitorScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var vm = StaffMonitorVM()
    @State private var controlsVM = StaffMonitorControlsVM()
    @State private var ops = StaffMonitorOpsStore()
    @State private var selected: StaffMonitorSummary? = nil
    @State private var tab: StaffMonitorTab
    @State private var feedExpanded = false
    @State private var expandedStaff: String? = nil
    /// Web MonitorAlertPanel parity: dismissals key on alert CONTENT, session-scoped.
    @State private var dismissedAlerts: Set<String> = []
    let openWeb: (_ path: String, _ title: String) -> Void

    /// `initialTab` lets deep links land on a specific tab — /agent/live-watch
    /// opens the Agents (live browser) tab (AG-08, one canonical implementation).
    init(openWeb: @escaping (_ path: String, _ title: String) -> Void,
         initialTab: StaffMonitorTab = .overview) {
        self.openWeb = openWeb
        _tab = State(initialValue: initialTab)
    }

    var body: some View {
        // Status strip + tab strip live OUTSIDE the scroll view — genuinely sticky
        // (roadmap §4.2 first fold), tab content scrolls beneath them.
        VStack(spacing: 0) {
            headerZone
            ScrollView {
                LazyVStack(spacing: 10) {
                    dayChips
                    tabContent
                    // Floating-control clearance (roadmap §4.2 hard rule): the last
                    // row must never sit under a floating Agent control / home bar.
                    Color.clear.frame(height: 96)
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
            }
            .claudeTopFade()
            .refreshable {
                await vm.load()
                await controlsVM.loadAll()
            }
        }
        .background(StaffMonitorAurora())
        .overlay(alignment: .top) { toastOverlay }
        .task {
            await vm.load()
            await controlsVM.loadAll()
            await controlsVM.loadOps(ops)
            // Web parity: auto-refresh every 10s while live (staff payload + the
            // emergency live-browser watch state). SwiftUI cancels this task when
            // the screen leaves the hierarchy — no orphan timers (roadmap §4.9).
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                if Task.isCancelled { break }
                guard scenePhase == .active else { continue }
                if vm.isLive {
                    await vm.load(silent: true)
                    await controlsVM.refreshWatch()
                }
            }
        }
        .task {
            // Web parity: health scan refresh every 60s while live + foregrounded.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 60_000_000_000)
                if Task.isCancelled { break }
                guard scenePhase == .active, vm.isLive else { continue }
                await controlsVM.loadHealthScan(ops)
            }
        }
        .sheet(item: $selected) { s in
            StaffMonitorDetailSheet(summary: s, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// Web toast parity: fixed top banner, auto-clears after ~4.5s.
    @ViewBuilder private var toastOverlay: some View {
        if let t = ops.toast {
            HStack(spacing: 6) {
                Text(t.ok ? "✓" : "⚠")
                Text(t.msg).lineLimit(2)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(t.ok ? StaffMonitorPalette.emerald600 : StaffMonitorPalette.red500)
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(
                (t.ok ? StaffMonitorPalette.emerald600 : StaffMonitorPalette.red500).opacity(0.35), lineWidth: 1))
            .padding(.top, 6)
            .transition(.move(edge: .top).combined(with: .opacity))
            .task {
                try? await Task.sleep(nanoseconds: 4_500_000_000)
                withAnimation { ops.toast = nil }
            }
            .onTapGesture { withAnimation { ops.toast = nil } }
        }
    }

    // ── Sticky header zone: status strip + five-tab strip ──

    private var headerZone: some View {
        VStack(alignment: .leading, spacing: 4) {
            statusStrip
            tabStrip
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .padding(.bottom, 4)
    }

    /// Compact status chips: LIVE/archive · Agent · Browser · Heartbeat · alerts.
    /// Each chip is a shortcut into the tab that controls it.
    private var statusStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if vm.isLive { livePulse } else if let d = vm.selectedDate { archiveBadge(d) }
                if let c = controlsVM.controls {
                    statusChip(c.paused ? "🛑 Agent বন্ধ" : "🟢 Agent",
                               c.paused ? StaffMonitorPalette.red500 : StaffMonitorPalette.emerald600) { tab = .agents }
                }
                if let w = controlsVM.watch {
                    statusChip(w.enabled ? "🖥️ ব্রাউজার \(w.onlineCount)" : "🖥️ বন্ধ",
                               w.enabled ? StaffMonitorPalette.emerald600 : .secondary) { tab = .agents }
                }
                if let h = controlsVM.heartbeat {
                    statusChip(h.enabled ? "💓 \(h.wakesToday)" : "💓 বন্ধ",
                               h.enabled ? StaffMonitorPalette.emerald600 : .secondary) { tab = .agents }
                }
                let unacked = vm.data?.unackedMessages.count ?? 0
                if unacked > 0 {
                    statusChip("⚠️ \(unacked)", StaffMonitorPalette.amber600) { tab = .feed }
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func statusChip(_ text: String, _ color: Color, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(text)
                .font(.caption2.weight(.bold))
                .foregroundStyle(color)
                .padding(.horizontal, 9).padding(.vertical, 5)
                .background(color.opacity(0.10), in: Capsule())
                .overlay(Capsule().strokeBorder(color.opacity(0.30), lineWidth: 0.8))
        }
        .buttonStyle(.plain)
    }

    /// Five-tab strip — web MonitorTabs parity: icon + label + count badge +
    /// neon underline on the active tab. Horizontally scrollable on small phones.
    private var tabStrip: some View {
        let unacked = vm.data?.unackedMessages.count ?? 0
        let staffCount = vm.data?.staffSummaries.count ?? 0
        let feedCount = feedRows.count
        let approvals = vm.data?.pendingApprovals.count ?? 0
        let failures = vm.data?.failures.count ?? 0
        let alertCount = unacked + approvals + failures   // web MonitorTabs badge rule
        func badge(for t: StaffMonitorTab) -> Int? {
            switch t {
            case .overview: return alertCount > 0 ? alertCount : nil
            case .staff: return staffCount > 0 ? staffCount : nil
            case .feed: return feedCount > 0 ? feedCount : nil
            default: return nil
            }
        }
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(StaffMonitorTab.allCases, id: \.self) { t in
                    let active = tab == t
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        withAnimation(.easeOut(duration: 0.18)) { tab = t }
                    } label: {
                        VStack(spacing: 4) {
                            HStack(spacing: 4) {
                                Text(t.icon).font(.caption)
                                Text(t.label)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(active ? t.neon : .secondary)
                                if let b = badge(for: t) {
                                    Text("\(b)")
                                        .font(.system(size: 9, weight: .bold).monospacedDigit())
                                        .foregroundStyle(active ? t.neon : .secondary)
                                        .padding(.horizontal, 5).padding(.vertical, 1.5)
                                        .background((active ? t.neon : Color.secondary).opacity(0.14), in: Capsule())
                                }
                            }
                            Capsule()
                                .fill(LinearGradient(colors: [.clear, t.neon, .clear],
                                                     startPoint: .leading, endPoint: .trailing))
                                .frame(height: 2)
                                .opacity(active ? 1 : 0)
                                .shadow(color: active ? t.neon.opacity(0.6) : .clear, radius: 4)
                        }
                        .padding(.horizontal, 9)
                        .padding(.top, 5)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(t.label))
                    .accessibilityAddTraits(active ? .isSelected : [])
                }
            }
        }
    }

    // ── Tab content (lazy — only the active tab renders) ──

    @ViewBuilder private var tabContent: some View {
        if vm.authExpired { authCard }
        if let err = vm.error, vm.data == nil { errorCard(err) }
        if vm.loading && vm.data == nil { loadingRows }
        switch tab {
        case .overview: overviewTab
        case .agents: agentsTab
        case .staff: staffTab
        case .feed: feedTab
        case .system: systemTab
        }
    }

    // ── OVERVIEW: alerts + 6-KPI grid + quick actions + top staff + refresh meta ──

    @ViewBuilder private var overviewTab: some View {
        if let d = vm.data {
            alertPanel(d)
            kpiGrid(d)
            if vm.isLive { quickActionsCard(d) }
            topStaffSection
            Text(metaLine)
                .font(.caption2).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 2)
        }
    }

    /// Web MonitorAlertPanel parity: system warnings + delivery failures +
    /// many-unacked, dismissible (content-keyed), with a dismiss-all row. Empty
    /// state collapses to one compact line (§4.2).
    @ViewBuilder private func alertPanel(_ d: StaffMonitorData) -> some View {
        let alerts = buildAlerts(d).filter { !dismissedAlerts.contains($0.id) }
        if alerts.isEmpty {
            Label("সব ঠিক আছে — কোনো অ্যালার্ট নেই", systemImage: "checkmark.circle")
                .font(.caption).foregroundStyle(StaffMonitorPalette.emerald600)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if alerts.count > 1 {
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        withAnimation { dismissedAlerts.formUnion(alerts.map(\.id)) }
                    } label: {
                        Text("✕ সব বন্ধ করুন (\(alerts.count))")
                            .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
                ForEach(alerts, id: \.id) { a in
                    HStack(alignment: .top, spacing: 8) {
                        Text(a.critical ? "🚨" : "⚠️").font(.caption)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.title).font(.caption.weight(.medium))
                                .foregroundStyle(a.critical ? StaffMonitorPalette.red500 : StaffMonitorPalette.amber600)
                            if let detail = a.detail {
                                Text(detail).font(.system(size: 9)).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 4)
                        Button {
                            UISelectionFeedbackGenerator().selectionChanged()
                            withAnimation { dismissedAlerts.insert(a.id) }
                        } label: {
                            Image(systemName: "xmark").font(.system(size: 9)).foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(10)
                    .background((a.critical ? StaffMonitorPalette.red500 : StaffMonitorPalette.amber600).opacity(0.07),
                                in: RoundedRectangle(cornerRadius: 12))
                }
            }
        }
    }

    private struct MonitorAlert { let id: String; let critical: Bool; let title: String; let detail: String? }

    /// Web MonitorAlertPanel alert-building rules verbatim.
    private func buildAlerts(_ d: StaffMonitorData) -> [MonitorAlert] {
        var out: [MonitorAlert] = []
        for w in d.warnings {
            let detail: String? =
                w.kind == "worker_heartbeat" ? "Fix: SSH to VPS → pm2 restart agent-worker" :
                w.kind == "duty_failed" ? "System ট্যাবে failed duty খুলে retrigger করুন" :
                w.kind == "duty_missed" ? "Duty was not run in its time window" : nil
            out.append(MonitorAlert(id: "warn-\(w.kind)-\(w.message)",
                                    critical: w.severity == "critical", title: w.message, detail: detail))
        }
        if vm.isLive, !d.failures.isEmpty {
            out.append(MonitorAlert(
                id: "delivery-failures", critical: false,
                title: "\(d.failures.count) delivery failure\(d.failures.count > 1 ? "s" : "") detected",
                detail: d.failures.prefix(2).map { "\($0.staffName ?? "—")" }.joined(separator: " · ")))
        }
        if vm.isLive, d.unackedMessages.count > 3 {
            out.append(MonitorAlert(
                id: "many-unacked", critical: false,
                title: "\(d.unackedMessages.count) messages unseen by staff",
                detail: "Consider sending critical NTFY alerts"))
        }
        return out
    }

    /// Web MonitorKPIStrip parity: Agent Duties · Staff Active · Pending Ack ·
    /// Approvals · AI Cost · Failures (3×2 grid).
    private func kpiGrid(_ d: StaffMonitorData) -> some View {
        let totalDuties = d.agentDuties.count
        let doneDuties = d.agentDuties.filter { $0.status == "done" }.count
        let failedDuties = d.agentDuties.filter { $0.status == "failed" || $0.status == "missed" }.count
        let unacked = d.unackedMessages.count
        let approvals = d.pendingApprovals.count
        let cost = ops.brain.map { String(format: "$%.2f", $0.todayCostUsd) } ?? "—"
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3), spacing: 8) {
            kpiCell("AGENT DUTIES", "\(doneDuties)/\(totalDuties)",
                    failedDuties > 0 ? "\(failedDuties) failed" : "on track",
                    failedDuties > 0 ? StaffMonitorPalette.red500 : StaffMonitorPalette.emerald600) { tab = .system }
            kpiCell("STAFF ACTIVE", "\(d.staffSummaries.count)", "tracked today",
                    Color(red: 0.831, green: 0.659, blue: 0.294)) { tab = .staff }
            kpiCell("PENDING ACK", "\(unacked)", "unseen msgs",
                    unacked > 0 ? StaffMonitorPalette.amber600 : StaffMonitorPalette.emerald600) { tab = .feed }
            kpiCell("APPROVALS", "\(approvals)", approvals > 0 ? "waiting" : "all clear",
                    approvals > 0 ? StaffMonitorPalette.amber600 : StaffMonitorPalette.emerald600) { tab = .feed }
            kpiCell("AI COST", cost, "USD today", StaffMonitorPalette.coral) { tab = .agents }
            kpiCell("FAILURES", "\(d.failures.count)", "delivery",
                    d.failures.isEmpty ? StaffMonitorPalette.emerald600 : StaffMonitorPalette.red500) { tab = .feed }
        }
    }

    private func kpiCell(_ label: String, _ value: String, _ sub: String, _ tint: Color,
                         action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.system(size: 8, weight: .bold)).foregroundStyle(.secondary)
                    .lineLimit(1).minimumScaleFactor(0.7)
                Text(value).font(.headline.weight(.black).monospacedDigit()).foregroundStyle(tint)
                    .lineLimit(1).minimumScaleFactor(0.7)
                Text(sub).font(.system(size: 8)).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Web MonitorQuickActions parity: Deploy Worker · Retrigger Duty (searchable
    /// menu) · NTFY All · pending badge · last-deploy line.
    private func quickActionsCard(_ d: StaffMonitorData) -> some View {
        let failedDuties = d.agentDuties.filter { $0.status == "failed" || $0.status == "missed" }
        return VStack(alignment: .leading, spacing: 8) {
            Text("⚡ Quick Actions")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            HStack(spacing: 8) {
                Button {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    Task { await controlsVM.deployWorker(ops) }
                } label: {
                    Text(ops.deploying ? "Deploying…" : "🚀 Deploy Worker")
                        .font(.system(size: 11, weight: .bold))
                        .padding(.horizontal, 11).padding(.vertical, 8)
                        .background(StaffMonitorPalette.teal.opacity(0.13), in: Capsule())
                        .foregroundStyle(StaffMonitorPalette.teal)
                }
                .buttonStyle(.plain)
                .disabled(ops.deploying)
                Menu {
                    // Failed duties first (web badge), then everything else.
                    ForEach(failedDuties) { duty in
                        Button("✗ \(duty.label)") {
                            Task { await controlsVM.retrigger(ops, dutyKey: duty.duty) }
                        }
                    }
                    Divider()
                    ForEach(smDutyToJob.keys.sorted(), id: \.self) { key in
                        Button(key.replacingOccurrences(of: "_", with: " ")) {
                            Task { await controlsVM.retrigger(ops, dutyKey: key) }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(ops.retriggering ? "⏳…" : "⟳ Retrigger")
                            .font(.system(size: 11, weight: .bold))
                        if !failedDuties.isEmpty {
                            Text("\(failedDuties.count)")
                                .font(.system(size: 8, weight: .bold))
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(StaffMonitorPalette.red500.opacity(0.15), in: Capsule())
                                .foregroundStyle(StaffMonitorPalette.red500)
                        }
                    }
                    .padding(.horizontal, 11).padding(.vertical, 8)
                    .background(StaffMonitorPalette.coral.opacity(0.10), in: Capsule())
                    .foregroundStyle(StaffMonitorPalette.coral)
                }
                .disabled(ops.retriggering)
                Spacer()
            }
            HStack(spacing: 8) {
                if !d.unackedMessages.isEmpty {
                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task {
                            for m in d.unackedMessages { await controlsVM.escalate(ops, row: m) }
                        }
                    } label: {
                        Text("🔔 NTFY All (\(d.unackedMessages.count))")
                            .font(.system(size: 11, weight: .bold))
                            .padding(.horizontal, 11).padding(.vertical, 8)
                            .background(StaffMonitorPalette.red500.opacity(0.10), in: Capsule())
                            .foregroundStyle(StaffMonitorPalette.red500)
                    }
                    .buttonStyle(.plain)
                    .disabled(ops.escalatingId != nil)
                }
                if !d.pendingApprovals.isEmpty {
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        tab = .feed
                    } label: {
                        Text("⏳ \(d.pendingApprovals.count) Pending")
                            .font(.system(size: 11, weight: .bold))
                            .padding(.horizontal, 11).padding(.vertical, 8)
                            .background(Color(red: 0.831, green: 0.659, blue: 0.294).opacity(0.10), in: Capsule())
                            .foregroundStyle(Color(red: 0.831, green: 0.659, blue: 0.294))
                    }
                    .buttonStyle(.plain)
                }
                Spacer()
            }
            if let msg = ops.deployMsg {
                Text(msg).font(.system(size: 9))
                    .foregroundStyle(msg.hasPrefix("✓") ? StaffMonitorPalette.emerald600
                                     : msg.hasPrefix("⚠") ? StaffMonitorPalette.amber600
                                     : StaffMonitorPalette.red500)
            }
            if let t = smClock(ops.lastDeploy) {
                Text("Last deploy: \(t)").font(.system(size: 9)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    /// Compact top staff (web MonitorStaffCards on Overview): top 3 by progress,
    /// with a jump into the full Staff tab.
    @ViewBuilder private var topStaffSection: some View {
        if let summaries = vm.data?.staffSummaries, !summaries.isEmpty {
            let top = summaries.sorted { $0.completionPct > $1.completionPct }.prefix(3)
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("👥 টপ স্টাফ")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        tab = .staff
                    } label: {
                        Text("সবাই ›").font(.caption2.weight(.semibold))
                            .foregroundStyle(StaffMonitorPalette.accentText(colorScheme))
                    }
                    .buttonStyle(.plain)
                }
                ForEach(Array(top)) { s in
                    StaffMonitorCard(
                        summary: s,
                        geo: vm.geo(for: s.staffId),
                        alertCount: vm.alerts(for: s.staffId).count,
                        onTap: { selected = s })
                }
            }
        } else if let d = vm.data, d.staffSummaries.isEmpty, !vm.loading {
            emptyState
        }
    }

    // ── AGENTS: owner control panels (live only, web parity) ──

    @ViewBuilder private var agentsTab: some View {
        if !vm.isLive {
            // Web parity string verbatim.
            Text("Agent কন্ট্রোল শুধু লাইভ ভিউতে — \"Today\" চাপুন")
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 20)
                .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        } else if !vm.authExpired {
            StaffMonitorAgentsTab(vm: controlsVM, openWeb: openWeb)
        }
    }

    // ── STAFF: expandable hub rows (caps/geo/alerts/quick actions) + surveillance ──

    @ViewBuilder private var staffTab: some View {
        staffCards
        if vm.isLive { surveillanceCard }
        if let d = vm.data, !vm.loading, d.staffSummaries.isEmpty, vm.error == nil, !vm.authExpired {
            emptyState
        }
    }

    /// Web MonitorStaffHub quick actions — Bangla command deep-linked into the
    /// NATIVE chat composer (prefill, never auto-send: agent + confirm-card flow).
    private func runStaffAction(_ command: String) {
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        AlmaComposerPrefill.set(command)
        NotificationCenter.default.post(name: .almaOpenPath, object: nil, userInfo: ["path": "/agent"])
    }

    /// Per-staff expandable detail (web MonitorStaffHub expanded block).
    @ViewBuilder private func staffExpandedDetail(_ s: StaffMonitorSummary) -> some View {
        let cap = ops.staffCaps.first { $0.staffId == s.staffId }
        let geo = vm.geo(for: s.staffId)
        let alerts = vm.alerts(for: s.staffId)
        VStack(alignment: .leading, spacing: 6) {
            if let cap {
                HStack(spacing: 6) {
                    Text("দক্ষতা \(cap.overallCompletionRate)%").font(.caption2.weight(.bold))
                    if !cap.strongTypes.isEmpty {
                        Text("💪 \(cap.strongTypes.joined(separator: ", "))")
                            .font(.system(size: 9)).foregroundStyle(StaffMonitorPalette.emerald600).lineLimit(1)
                    }
                    if !cap.weakTypes.isEmpty {
                        Text("📈 \(cap.weakTypes.joined(separator: ", "))")
                            .font(.system(size: 9)).foregroundStyle(StaffMonitorPalette.red500).lineLimit(1)
                    }
                }
            }
            if let geo {
                let g = StaffMonitorPalette.geo(geo.status)
                HStack(spacing: 6) {
                    Text("\(g.icon) \(g.text)\(geo.status == "outside" ? (geo.distanceM.map { " (\($0)m)" } ?? "") : "")")
                        .font(.caption2.weight(.medium)).foregroundStyle(g.color)
                    if let link = geo.mapsLink, let url = URL(string: link) {
                        Link("📍 ম্যাপ", destination: url)
                            .font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                }
            }
            ForEach(Array(alerts.enumerated()), id: \.offset) { _, a in
                Text("⚡ \(a.message)").font(.system(size: 10)).foregroundStyle(StaffMonitorPalette.amber600)
            }
            if cap == nil && geo == nil && alerts.isEmpty {
                Text("এই স্টাফের অতিরিক্ত ডেটা এখনও নেই।").font(.caption2).foregroundStyle(.secondary)
            }
            // Web quickActions() — Bangla commands verbatim, chat-prefill flow.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    staffQuickChip("📋 টাস্ক দাও", "\(s.staffName)কে নতুন টাস্ক দাও: ")
                    staffQuickChip("💬 মেসেজ", "\(s.staffName)কে একটা মেসেজ পাঠাও: ")
                    staffQuickChip("✅ প্রুফ যাচাই", "\(s.staffName) আজকে যেসব কাজের প্রুফ দিয়েছে সেগুলো যাচাই করো।")
                    staffQuickChip("📈 পারফরম্যান্স", "\(s.staffName)-এর এই সপ্তাহের পারফরম্যান্স রিভিউ দাও।")
                    staffQuickChip("📍 লোকেশন", "\(s.staffName) এখন কোথায় আছে?")
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        selected = s
                    } label: {
                        Text("👁️ বিস্তারিত")
                            .font(.system(size: 10, weight: .semibold))
                            .padding(.horizontal, 9).padding(.vertical, 6)
                            .background(Color.primary.opacity(0.05), in: Capsule())
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(12)
    }

    private func staffQuickChip(_ label: String, _ command: String) -> some View {
        Button {
            runStaffAction(command)
        } label: {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .padding(.horizontal, 9).padding(.vertical, 6)
                .background(StaffMonitorPalette.coral.opacity(0.10), in: Capsule())
                .foregroundStyle(StaffMonitorPalette.accentText(colorScheme))
                .overlay(Capsule().strokeBorder(StaffMonitorPalette.coral.opacity(0.3), lineWidth: 0.8))
        }
        .buttonStyle(.plain)
    }

    /// Web "Live Surveillance" card: geo-fence toggle + per-staff geo chips +
    /// productivity alerts + staff task controls (GET/PATCH staff-toggles).
    @ViewBuilder private var surveillanceCard: some View {
        if let d = vm.data {
            let tracking = d.geoFenceMonitoringEnabled ?? true
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("📡 Live Surveillance")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        Task {
                            _ = await controlsVM.toggleGeoFence(ops, enabled: !tracking)
                            await vm.load(silent: true)   // server truth refresh (web loadLive parity)
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Circle().fill(tracking ? StaffMonitorPalette.emerald600 : Color.secondary)
                                .frame(width: 7, height: 7)
                            Text(tracking ? "Tracking ON" : "Tracking OFF")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(tracking ? StaffMonitorPalette.emerald600 : .secondary)
                        }
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background((tracking ? StaffMonitorPalette.emerald600 : Color.secondary).opacity(0.08), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .disabled(ops.geoToggling)
                }
                if tracking {
                    if d.geoStatus.isEmpty {
                        Text("কোনো staff location ডেটা নেই।").font(.caption2).foregroundStyle(.secondary)
                    } else {
                        FlowLayoutSM(spacing: 6) {
                            ForEach(d.geoStatus, id: \.staffId) { g in
                                let info = StaffMonitorPalette.geo(g.status)
                                HStack(spacing: 4) {
                                    Text(info.icon).font(.system(size: 10))
                                    Text(g.staffName ?? "—").font(.system(size: 10, weight: .semibold))
                                    if g.status == "outside", let dM = g.distanceM {
                                        Text("(\(dM)m)").font(.system(size: 9))
                                    }
                                }
                                .foregroundStyle(info.color)
                                .padding(.horizontal, 8).padding(.vertical, 5)
                                .background(info.color.opacity(0.08), in: Capsule())
                            }
                        }
                    }
                } else {
                    Text("Office time-এ continuous location tracking বন্ধ। Attendance check-in/out-এ location এখনও বাধ্যতামূলক।")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if !d.productivityAlerts.isEmpty {
                    Divider().opacity(0.4)
                    Text("⚡ Productivity")
                        .font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    ForEach(Array(d.productivityAlerts.enumerated()), id: \.offset) { _, a in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(a.staffName ?? "—").font(.caption2.weight(.bold))
                            Text(a.message).font(.caption2).foregroundStyle(.secondary)
                            Spacer(minLength: 0)
                        }
                    }
                }
                if !ops.toggleDefs.isEmpty {
                    Divider().opacity(0.4)
                    Text("🎛️ Staff Task Controls")
                        .font(.system(size: 10, weight: .bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    ForEach(ops.toggleDefs) { def in
                        let enabled = ops.toggles[def.key] != false
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(def.label).font(.caption.weight(.bold))
                                Text(def.hint).font(.system(size: 9)).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            if ops.staffTaskToggling == def.key { ProgressView().controlSize(.mini) }
                            Toggle("", isOn: Binding(get: { enabled }, set: { on in
                                UISelectionFeedbackGenerator().selectionChanged()
                                Task { await controlsVM.toggleStaffTask(ops, key: def.key, enabled: on) }
                            }))
                            .labelsHidden()
                            .tint(StaffMonitorPalette.emerald600)
                            .disabled(ops.staffTaskToggling != nil)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    // ── FEED: unacked + message feed (escalate/approvals actions land NP-3) ──

    private var feedRows: [StaffMonitorFeedRow] {
        let d = vm.data
        let rows = (d?.feed.isEmpty == false ? d?.feed : d?.historyFeed) ?? []
        return rows
    }

    @ViewBuilder private var feedTab: some View {
        let unacked = vm.data?.unackedMessages ?? []
        if !unacked.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("⏳ Pending Ack (\(unacked.count))")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    // Web "🔔 Notify All" — escalate every unacked message in turn.
                    if vm.isLive {
                        Button {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            Task { for m in unacked { await controlsVM.escalate(ops, row: m) } }
                        } label: {
                            Text("🔔 Notify All")
                                .font(.system(size: 10, weight: .bold))
                                .padding(.horizontal, 9).padding(.vertical, 5)
                                .background(StaffMonitorPalette.red500.opacity(0.10), in: Capsule())
                                .foregroundStyle(StaffMonitorPalette.red500)
                        }
                        .buttonStyle(.plain)
                        .disabled(ops.escalatingId != nil)
                    }
                }
                ForEach(unacked.prefix(10)) { m in
                    StaffMonitorFeedCardRow(m: m, scheme: colorScheme)
                    if vm.isLive {
                        HStack {
                            Spacer()
                            Button {
                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                Task { await controlsVM.escalate(ops, row: m) }
                            } label: {
                                Text(ops.escalatingId == m.id ? "⏳…" : "🔔 Critical NTFY")
                                    .font(.system(size: 9, weight: .bold))
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(StaffMonitorPalette.red500.opacity(0.10), in: Capsule())
                                    .foregroundStyle(StaffMonitorPalette.red500)
                            }
                            .buttonStyle(.plain)
                            .disabled(ops.escalatingId != nil)
                        }
                    }
                    if m.id != unacked.prefix(10).last?.id { Divider().opacity(0.4) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
        approvalsCard
        remindersTodosCard
        VStack(alignment: .leading, spacing: 10) {
            Text("📨 Message Feed")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            if feedRows.isEmpty {
                Text("কোনো মেসেজ লগ নেই").font(.caption).foregroundStyle(.secondary)
            } else {
                let visible = feedExpanded ? feedRows : Array(feedRows.prefix(6))
                ForEach(visible) { m in
                    StaffMonitorFeedCardRow(m: m, scheme: colorScheme)
                    if m.id != visible.last?.id { Divider().opacity(0.4) }
                }
                if feedRows.count > 6 {
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        withAnimation { feedExpanded.toggle() }
                    } label: {
                        Text(feedExpanded ? "▴ কম দেখুন" : "▾ আরও \(feedRows.count - 6)টা")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(StaffMonitorPalette.accentText(colorScheme))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── FEED: pending approvals + reminders/todos (web cards) ──

    @ViewBuilder private var approvalsCard: some View {
        let approvals = vm.data?.pendingApprovals ?? []
        if !approvals.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("⏳ Pending Approvals (48h) · \(approvals.count)")
                    .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                ForEach(approvals) { a in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(a.type.replacingOccurrences(of: "_", with: " "))
                            .font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                        Text(a.summary).font(.caption).lineLimit(3)
                        HStack(spacing: 8) {
                            if let ago = StaffMonitorFormat.timeAgo(a.createdAt) {
                                Text(ago).font(.system(size: 9)).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if ops.approvingId == a.id {
                                ProgressView().controlSize(.mini)
                            } else {
                                Button {
                                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                    Task {
                                        await controlsVM.decideApproval(ops, id: a.id, type: a.type, approve: true)
                                        await vm.load(silent: true)
                                    }
                                } label: {
                                    Text("✓ Approve").font(.system(size: 10, weight: .bold))
                                        .padding(.horizontal, 10).padding(.vertical, 5)
                                        .background(StaffMonitorPalette.emerald600.opacity(0.12), in: Capsule())
                                        .foregroundStyle(StaffMonitorPalette.emerald600)
                                }
                                .buttonStyle(.plain)
                                Button {
                                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                    Task {
                                        await controlsVM.decideApproval(ops, id: a.id, type: a.type, approve: false)
                                        await vm.load(silent: true)
                                    }
                                } label: {
                                    Text("✗ Reject").font(.system(size: 10, weight: .bold))
                                        .padding(.horizontal, 10).padding(.vertical, 5)
                                        .background(StaffMonitorPalette.red500.opacity(0.12), in: Capsule())
                                        .foregroundStyle(StaffMonitorPalette.red500)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .padding(.vertical, 3)
                    if a.id != approvals.last?.id { Divider().opacity(0.4) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    @ViewBuilder private var remindersTodosCard: some View {
        let reminders = vm.data?.activeReminders ?? []
        let todos = vm.data?.activeTodos ?? []
        if !reminders.isEmpty || !todos.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                if !reminders.isEmpty {
                    Text("⏰ Active Reminders (\(reminders.count))")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    ForEach(reminders) { r in
                        HStack(spacing: 6) {
                            Text(r.title).font(.caption).lineLimit(1)
                            Spacer()
                            if let t = StaffMonitorFormat.clock(r.dueAt) {
                                Text(t).font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if !todos.isEmpty {
                    if !reminders.isEmpty { Divider().opacity(0.4) }
                    Text("📝 To-dos (\(todos.count))")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    ForEach(todos) { t in
                        HStack(spacing: 6) {
                            Text(t.title).font(.caption).lineLimit(1)
                            Spacer()
                            if let hint = t.dueHint {
                                Text(hint).font(.system(size: 9)).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    // ── SYSTEM: full owner control room (StaffMonitorSystemSwiftUI.swift) ──

    private var systemTab: some View {
        StaffMonitorSystemTab(
            vm: controlsVM,
            ops: ops,
            duties: vm.data?.agentDuties ?? [],
            salahDuties: vm.data?.salahDuties ?? [],
            services: vm.data?.continuousServices ?? [],
            dutyEnabled: vm.data?.dutyEnabled ?? [:],
            dutyTimeOverrides: vm.data?.dutyTimeOverrides ?? [:],
            isLive: vm.isLive,
            onDutyEnabledEcho: { echo in
                vm.data?.dutyEnabled = echo
            })
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

    // ── Staff cards ──

    @ViewBuilder private var staffCards: some View {
        if let summaries = vm.data?.staffSummaries, !summaries.isEmpty {
            ForEach(summaries) { s in
                VStack(spacing: 0) {
                    StaffMonitorCard(
                        summary: s,
                        geo: vm.geo(for: s.staffId),
                        alertCount: vm.alerts(for: s.staffId).count,
                        onTap: {
                            withAnimation(.easeOut(duration: 0.18)) {
                                expandedStaff = expandedStaff == s.staffId ? nil : s.staffId
                            }
                        })
                    // Web MonitorStaffHub: tap expands caps/geo/alerts + quick actions.
                    if expandedStaff == s.staffId {
                        staffExpandedDetail(s)
                            .staffMonitorGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                            .padding(.top, 2)
                    }
                }
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

}

// MARK: - Feed row (web FeedMessage + AckBadge parity — compact card row)

@available(iOS 17.0, *)
private struct StaffMonitorFeedCardRow: View {
    let m: StaffMonitorFeedRow
    let scheme: ColorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(m.staffName ?? "—").font(.caption.weight(.bold)).lineLimit(1)
                Text(m.typeLabel)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(StaffMonitorPalette.accentText(scheme))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(StaffMonitorPalette.coral.opacity(0.12), in: Capsule())
                if let t = StaffMonitorFormat.clock(m.sentAt ?? m.createdAt) {
                    Text(t).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
                Spacer()
                ackBadge
            }
            Text(m.content)
                .font(.caption)
                .foregroundStyle(.primary.opacity(0.85))
                .lineLimit(3)
        }
        .padding(.vertical, 2)
    }

    /// Web AckBadge parity: ✓ time · ⏳ unseen · sending…
    @ViewBuilder private var ackBadge: some View {
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
/// Shared with the Agents/System control-room sheets (sibling files) so their sheets
/// wear the same aurora as the tabs instead of a flat near-black rootBg (owner
/// feedback 2026-07-17: "kono sub page e black background jeno na thake").
struct StaffMonitorAurora: View {
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
