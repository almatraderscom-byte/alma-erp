//
//  StaffMonitorAgentsSwiftUI.swift
//  ALMA ERP — NP-2: the LIVE Business Monitor's AGENTS tab, full owner controls.
//
//  Native parity for the web monitor's owner panels (roadmap §4.4):
//    · AgentControlCenter.tsx  → master pause + autonomy mode + capability toggles
//        GET/PATCH /api/assistant/controls  (server echo is the displayed truth)
//    · AutonomySloPanel.tsx    → GET /api/assistant/controls?section=slo
//        zero-invariants grid · breaches · per-class table · outbox line
//    · ModelTogglePanel.tsx    → GET/PATCH /api/assistant/models
//        searchable, provider-grouped rows; PATCH {modelId,enabled} → enabledMap echo
//    · HeartbeatPanel.tsx      → GET /api/assistant/heartbeat?limit=20,
//        POST {action: enable|disable|test_now} (response IS the new feed)
//    · LiveBrowserWatchPanel.tsx → GET /api/assistant/live-browser/watch?limit=30,
//        POST {action: stop|resume}; devices · latest screenshot (zoom/share) ·
//        step feed with status/error/time
//    · MonitorAgentsPanel.tsx  → GET/POST /api/assistant/model-routing
//        Opus dial (enabled/cap/confidence/৳-threshold/critical model) + "আজ কে কী
//        করেছে" daily activity cards
//
//  ONE data coordinator (StaffMonitorControlsVM) owns every fetch + mutation;
//  the screen's 10s loop keeps the status strip fresh, and this tab adds a
//  2.5s watch / 30s panel cadence ONLY while it is visible (roadmap §4.9 —
//  lifecycle-aware, cancellable, no per-card timers).
//
//  Mutations follow §4.8: Bangla confirm for dangerous ops (pause / stop-all),
//  no optimistic owner state (server echo only), per-row spinners, idempotent
//  replays surface as success.
//

import SwiftUI

// MARK: - Flexible decode helpers

private func smFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
    return nil
}
private func smFlexDouble<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
    return nil
}

// MARK: - Models (web panel shapes verbatim)

/// GET/PATCH /api/assistant/controls — web AgentControls defaulting rules mirrored.
struct SMControls: Decodable {
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
    static let autonomyOptions: [(value: String, label: String)] = [
        ("ask", "আগে জিজ্ঞেস"), ("notify", "করে জানাও"), ("auto", "স্বয়ংক্রিয়"),
    ]
    var autonomyLabel: String {
        Self.autonomyOptions.first { $0.value == autonomy }?.label ?? "আগে জিজ্ঞেস"
    }
}

/// PATCH /api/assistant/controls — partial body; synthesized Encodable omits nils.
struct SMControlsPatch: Encodable {
    var paused: Bool? = nil
    var autonomy: String? = nil
    var capabilities: Caps? = nil
    struct Caps: Encodable {
        var webResearch: Bool? = nil
        var socialPosting: Bool? = nil
        var imageVideoGen: Bool? = nil
    }
}

/// GET /api/assistant/live-browser/watch — FULL feed (screenshot included, NP-2).
struct SMWatchDevice: Decodable, Identifiable {
    let id: String
    let name: String
    let online: Bool
    let lastSeenAt: String?
    private enum Keys: String, CodingKey { case id, name, online, lastSeenAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "Chrome"
        online = (try? c.decodeIfPresent(Bool.self, forKey: .online)) ?? false
        lastSeenAt = try? c.decodeIfPresent(String.self, forKey: .lastSeenAt)
    }
}

struct SMWatchStep: Decodable, Identifiable {
    let id: String
    let device: String
    let action: String
    let target: String
    let status: String
    let error: String?
    let at: String?
    private enum Keys: String, CodingKey { case id, device, action, target, status, error, at }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        device = (try? c.decodeIfPresent(String.self, forKey: .device)) ?? ""
        action = (try? c.decodeIfPresent(String.self, forKey: .action)) ?? ""
        target = (try? c.decodeIfPresent(String.self, forKey: .target)) ?? ""
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        at = try? c.decodeIfPresent(String.self, forKey: .at)
    }
}

struct SMWatchFeed: Decodable {
    let enabled: Bool
    let devices: [SMWatchDevice]
    let steps: [SMWatchStep]
    let latestScreenshot: String?
    let latestScreenshotAt: String?

    private enum Keys: String, CodingKey { case enabled, devices, steps, latestScreenshot, latestScreenshotAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        devices = (try? c.decodeIfPresent([SMWatchDevice].self, forKey: .devices)) ?? []
        steps = (try? c.decodeIfPresent([SMWatchStep].self, forKey: .steps)) ?? []
        latestScreenshot = try? c.decodeIfPresent(String.self, forKey: .latestScreenshot)
        latestScreenshotAt = try? c.decodeIfPresent(String.self, forKey: .latestScreenshotAt)
    }

    var onlineCount: Int { devices.filter(\.online).count }
    /// Web LiveBrowserWatchPanel `running` rule verbatim.
    var running: Bool { steps.contains { $0.status == "queued" || $0.status == "delivered" } }

    /// latestScreenshot is a data URL ("data:image/png;base64,…") — decode to UIImage.
    var screenshotImage: UIImage? {
        guard let s = latestScreenshot,
              let comma = s.firstIndex(of: ","),
              let data = Data(base64Encoded: String(s[s.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }
}

/// GET /api/assistant/heartbeat?limit=20 — full feed (web HeartbeatPanel shape).
struct SMHeartbeatEntry: Decodable, Identifiable {
    let id: String
    let at: String?
    let kind: String
    let headWoke: Bool
    let summary: String
    private enum Keys: String, CodingKey { case id, at, kind, headWoke, summary }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        at = try? c.decodeIfPresent(String.self, forKey: .at)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "idle"
        headWoke = (try? c.decodeIfPresent(Bool.self, forKey: .headWoke)) ?? false
        summary = (try? c.decodeIfPresent(String.self, forKey: .summary)) ?? ""
    }

    /// Web KIND_TAG / KIND_LABEL verbatim.
    var tag: String {
        switch kind {
        case "active": return "🤖"
        case "blocked": return "📝"
        case "error": return "⚠️"
        default: return "🫧"
        }
    }
    var label: String {
        switch kind {
        case "active": return "নিজে সামলেছে"
        case "blocked": return "অনুমোদন চেয়েছে"
        case "error": return "সমস্যা"
        default: return "শান্ত"
        }
    }
}

struct SMHeartbeatFeed: Decodable {
    let enabled: Bool
    let autoArm: Bool
    let dailyHeadWakeCap: Int
    let wakesToday: Int
    let entries: [SMHeartbeatEntry]
    let testSummary: String?

    private enum Keys: String, CodingKey { case settings, wakesToday, entries, testResult }
    private enum SettingsKeys: String, CodingKey { case enabled, autoArm, dailyHeadWakeCap }
    private enum TestKeys: String, CodingKey { case summary }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let s = try? c.nestedContainer(keyedBy: SettingsKeys.self, forKey: .settings)
        enabled = (try? s?.decodeIfPresent(Bool.self, forKey: .enabled)) ?? false
        autoArm = (try? s?.decodeIfPresent(Bool.self, forKey: .autoArm)) ?? false
        dailyHeadWakeCap = (s.flatMap { smFlexInt($0, .dailyHeadWakeCap) }) ?? 0
        wakesToday = smFlexInt(c, .wakesToday) ?? 0
        entries = (try? c.decodeIfPresent([SMHeartbeatEntry].self, forKey: .entries)) ?? []
        let t = try? c.nestedContainer(keyedBy: TestKeys.self, forKey: .testResult)
        testSummary = try? t?.decodeIfPresent(String.self, forKey: .summary)
    }
}

/// GET /api/assistant/models — full rows (web ModelTogglePanel shape).
struct SMModelRow: Decodable, Identifiable {
    let id: String
    let label: String
    let provider: String
    var enabled: Bool
    private enum Keys: String, CodingKey { case id, label, provider, enabled }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? id
        provider = (try? c.decodeIfPresent(String.self, forKey: .provider)) ?? ""
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true
    }
}

/// GET /api/assistant/controls?section=slo — web AutonomySloPanel shapes.
enum SMSloValue: Decodable {
    case value(Double)
    case insufficient
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let d = try? c.decode(Double.self) { self = .value(d) } else { self = .insufficient }
    }
    /// Web pct(): "যথেষ্ট ডেটা নেই" for insufficient_data, else percentage.
    var text: String {
        switch self {
        case .insufficient: return "যথেষ্ট ডেটা নেই"
        case .value(let v): return String(format: "%.1f%%", v * 100)
        }
    }
    func color(target: Double) -> Color {
        switch self {
        case .insufficient: return .secondary
        case .value(let v):
            return v >= target ? Color(red: 0.020, green: 0.588, blue: 0.412)
                               : Color(red: 0.937, green: 0.267, blue: 0.267)
        }
    }
}

struct SMSloClass: Decodable, Identifiable {
    let taskClass: String
    let labelBn: String
    let tier: String
    let stage: String
    let samples: Int
    let successRate: SMSloValue
    let verifiedCompletionRate: SMSloValue
    let compensationSuccessRate: SMSloValue
    let totalCostUsd: Double
    var id: String { taskClass }
    private enum Keys: String, CodingKey {
        case taskClass, labelBn, tier, stage, samples
        case successRate, verifiedCompletionRate, compensationSuccessRate, totalCostUsd
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        taskClass = (try? c.decodeIfPresent(String.self, forKey: .taskClass)) ?? UUID().uuidString
        labelBn = (try? c.decodeIfPresent(String.self, forKey: .labelBn)) ?? taskClass
        tier = (try? c.decodeIfPresent(String.self, forKey: .tier)) ?? ""
        stage = (try? c.decodeIfPresent(String.self, forKey: .stage)) ?? "off"
        samples = smFlexInt(c, .samples) ?? 0
        successRate = (try? c.decodeIfPresent(SMSloValue.self, forKey: .successRate)) ?? .insufficient
        verifiedCompletionRate = (try? c.decodeIfPresent(SMSloValue.self, forKey: .verifiedCompletionRate)) ?? .insufficient
        compensationSuccessRate = (try? c.decodeIfPresent(SMSloValue.self, forKey: .compensationSuccessRate)) ?? .insufficient
        totalCostUsd = smFlexDouble(c, .totalCostUsd) ?? 0
    }
}

struct SMSloView: Decodable {
    let windowHours: Double
    let classes: [SMSloClass]
    let duplicateExternalEffects: Int
    let unapprovedHighImpactEffects: Int
    let unknownEffects: Int
    let guardCoverage: Double
    let breaches: [String]         // detailBn strings
    let outboxDue: Int
    let outboxLeased: Int
    let hasSlo: Bool

    private enum Keys: String, CodingKey { case effects }
    private enum EffectsKeys: String, CodingKey { case outbox, slo, breaches }
    private enum OutboxKeys: String, CodingKey { case due, leased }
    private enum SloKeys: String, CodingKey { case windowHours, classes, global }
    private enum GlobalKeys: String, CodingKey {
        case duplicateExternalEffects, unapprovedHighImpactEffects, unknownEffects, guardCoverage
    }
    private struct Breach: Decodable { let detailBn: String? }

    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let e = try? root.nestedContainer(keyedBy: EffectsKeys.self, forKey: .effects)
        let o = try? e?.nestedContainer(keyedBy: OutboxKeys.self, forKey: .outbox)
        outboxDue = (o.flatMap { smFlexInt($0, .due) }) ?? 0
        outboxLeased = (o.flatMap { smFlexInt($0, .leased) }) ?? 0
        let s = try? e?.nestedContainer(keyedBy: SloKeys.self, forKey: .slo)
        hasSlo = s != nil
        windowHours = (s.flatMap { smFlexDouble($0, .windowHours) }) ?? 0
        classes = (try? s?.decodeIfPresent([SMSloClass].self, forKey: .classes)) ?? []
        let g = try? s?.nestedContainer(keyedBy: GlobalKeys.self, forKey: .global)
        duplicateExternalEffects = (g.flatMap { smFlexInt($0, .duplicateExternalEffects) }) ?? 0
        unapprovedHighImpactEffects = (g.flatMap { smFlexInt($0, .unapprovedHighImpactEffects) }) ?? 0
        unknownEffects = (g.flatMap { smFlexInt($0, .unknownEffects) }) ?? 0
        guardCoverage = (g.flatMap { smFlexDouble($0, .guardCoverage) }) ?? 0
        let raw = (try? e?.decodeIfPresent([Breach].self, forKey: .breaches)) ?? []
        breaches = raw.compactMap(\.detailBn)
    }
}

/// GET/POST /api/assistant/model-routing — web MonitorAgentsPanel shapes.
struct SMRoutingConfig: Decodable, Equatable {
    var opusEnabled: Bool
    var opusDailyCap: Int
    var opusConfidenceThreshold: Double
    var opusCriticalTaka: Int
    var criticalModelId: String
    private enum Keys: String, CodingKey {
        case opusEnabled, opusDailyCap, opusConfidenceThreshold, opusCriticalTaka, criticalModelId
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        opusEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .opusEnabled)) ?? false
        opusDailyCap = smFlexInt(c, .opusDailyCap) ?? 0
        opusConfidenceThreshold = smFlexDouble(c, .opusConfidenceThreshold) ?? 0.7
        opusCriticalTaka = smFlexInt(c, .opusCriticalTaka) ?? 10000
        criticalModelId = (try? c.decodeIfPresent(String.self, forKey: .criticalModelId)) ?? ""
    }
}

extension SMRoutingConfig: Encodable {
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: EncKeys.self)
        try c.encode(opusEnabled, forKey: .opusEnabled)
        try c.encode(opusDailyCap, forKey: .opusDailyCap)
        try c.encode(opusConfidenceThreshold, forKey: .opusConfidenceThreshold)
        try c.encode(opusCriticalTaka, forKey: .opusCriticalTaka)
        try c.encode(criticalModelId, forKey: .criticalModelId)
    }
    private enum EncKeys: String, CodingKey {
        case opusEnabled, opusDailyCap, opusConfidenceThreshold, opusCriticalTaka, criticalModelId
    }
}

struct SMModelOption: Decodable, Identifiable {
    let id: String
    let label: String
    let inPerM: Double
    let outPerM: Double
    private enum Keys: String, CodingKey { case id, label, inPerM, outPerM }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? UUID().uuidString
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? id
        inPerM = smFlexDouble(c, .inPerM) ?? 0
        outPerM = smFlexDouble(c, .outPerM) ?? 0
    }
}

struct SMAgentToday: Decodable, Identifiable {
    let provider: String
    let emoji: String
    let label: String
    let role: String
    let calls: Int
    let costUsd: Double
    var id: String { provider }
    private enum Keys: String, CodingKey { case provider, emoji, label, role, calls, costUsd }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        provider = (try? c.decodeIfPresent(String.self, forKey: .provider)) ?? UUID().uuidString
        emoji = (try? c.decodeIfPresent(String.self, forKey: .emoji)) ?? "🤖"
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? provider
        role = (try? c.decodeIfPresent(String.self, forKey: .role)) ?? ""
        calls = smFlexInt(c, .calls) ?? 0
        costUsd = smFlexDouble(c, .costUsd) ?? 0
    }
}

struct SMSpecialistToday: Decodable, Identifiable {
    let role: String
    let modelLabel: String
    let displayName: String
    let icon: String
    let calls: Int
    let costUsd: Double
    var id: String { role }
    private enum Keys: String, CodingKey { case role, modelLabel, displayName, icon, calls, costUsd }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        role = (try? c.decodeIfPresent(String.self, forKey: .role)) ?? UUID().uuidString
        modelLabel = (try? c.decodeIfPresent(String.self, forKey: .modelLabel)) ?? ""
        displayName = (try? c.decodeIfPresent(String.self, forKey: .displayName)) ?? role
        icon = (try? c.decodeIfPresent(String.self, forKey: .icon)) ?? "🤖"
        calls = smFlexInt(c, .calls) ?? 0
        costUsd = smFlexDouble(c, .costUsd) ?? 0
    }
}

struct SMRoutingResponse: Decodable {
    let config: SMRoutingConfig
    let criticalModelOptions: [SMModelOption]
    let headModelLabel: String
    let headInPerM: Double
    let headOutPerM: Double
    let opusUsedToday: Int
    let agentsToday: [SMAgentToday]
    let specialistsToday: [SMSpecialistToday]
    let todayDhakaDate: String

    private enum Keys: String, CodingKey {
        case config, criticalModelOptions, headModel, opusUsedToday, agentsToday, specialistsToday, todayDhakaDate
    }
    private enum HeadKeys: String, CodingKey { case label, inPerM, outPerM }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        config = try c.decode(SMRoutingConfig.self, forKey: .config)
        criticalModelOptions = (try? c.decodeIfPresent([SMModelOption].self, forKey: .criticalModelOptions)) ?? []
        let h = try? c.nestedContainer(keyedBy: HeadKeys.self, forKey: .headModel)
        headModelLabel = (try? h?.decodeIfPresent(String.self, forKey: .label)) ?? "—"
        headInPerM = (h.flatMap { smFlexDouble($0, .inPerM) }) ?? 0
        headOutPerM = (h.flatMap { smFlexDouble($0, .outPerM) }) ?? 0
        opusUsedToday = smFlexInt(c, .opusUsedToday) ?? 0
        agentsToday = (try? c.decodeIfPresent([SMAgentToday].self, forKey: .agentsToday)) ?? []
        specialistsToday = (try? c.decodeIfPresent([SMSpecialistToday].self, forKey: .specialistsToday)) ?? []
        todayDhakaDate = (try? c.decodeIfPresent(String.self, forKey: .todayDhakaDate)) ?? ""
    }
}

// MARK: - Bangla action labels (web ACTION_BN verbatim)

func smActionBN(_ action: String) -> String {
    switch action {
    case "navigate": return "🌐 পেজ খুলছে"
    case "read_text": return "📖 পড়ছে"
    case "read_dom": return "👀 দেখছে"
    case "click": return "🖱️ ক্লিক"
    case "type": return "⌨️ লিখছে"
    case "press": return "⏎ কী চাপছে"
    case "select_option": return "🔽 অপশন বাছছে"
    case "hover": return "🫳 হোভার"
    case "scroll": return "↕️ স্ক্রল"
    case "scroll_to": return "🎯 স্ক্রল"
    case "wait": return "⏳ অপেক্ষা"
    case "screenshot": return "📸 স্ক্রিনশট"
    case "go_back": return "↩️ পিছনে"
    case "switch_tab": return "🗂️ ট্যাব বদল"
    case "close_tab": return "❌ ট্যাব বন্ধ"
    case "ping": return "📡 পিং"
    default: return action
    }
}

/// Web STATUS_BADGE verbatim.
func smStepBadge(_ status: String) -> (label: String, color: Color) {
    switch status {
    case "delivered": return ("চলছে…", Color(red: 0.851, green: 0.467, blue: 0.024))
    case "done": return ("হয়েছে", Color(red: 0.020, green: 0.588, blue: 0.412))
    case "failed": return ("ব্যর্থ", Color(red: 0.937, green: 0.267, blue: 0.267))
    default: return ("অপেক্ষায়", Color(red: 0.055, green: 0.647, blue: 0.914))
    }
}

// MARK: - Data coordinator (screen-owned; ALL agents-tab fetches + mutations)

@available(iOS 17.0, *)
@Observable
@MainActor
final class StaffMonitorControlsVM {
    var controls: SMControls? = nil
    var watch: SMWatchFeed? = nil
    var heartbeat: SMHeartbeatFeed? = nil
    var models: [SMModelRow]? = nil
    var slo: SMSloView? = nil
    var routing: SMRoutingResponse? = nil
    var routingDraft: SMRoutingConfig? = nil

    var busy = false                 // controls/watch mutations (confirm-dialog ops)
    var heartbeatBusy = false
    var modelSavingId: String? = nil
    var routingSaving = false
    var actionError: String? = nil
    var heartbeatToast: String? = nil

    /// Each GET fails independently — a 403 (non-owner), AGENT_ENABLED gate, or
    /// cold start just hides that panel; the rest of the screen never blanks.
    func loadAll() async {
        if let c: SMControls = try? await AlmaAPI.shared.get("/api/assistant/controls") {
            controls = c
        }
        await refreshWatch()
        await refreshHeartbeat()
        await refreshModels()
        await refreshSlo()
        await refreshRouting()
    }

    func refreshWatch() async {
        if let w: SMWatchFeed =
            try? await AlmaAPI.shared.get("/api/assistant/live-browser/watch", query: ["limit": "30"]) {
            watch = w
        }
    }

    func refreshHeartbeat() async {
        if let h: SMHeartbeatFeed =
            try? await AlmaAPI.shared.get("/api/assistant/heartbeat", query: ["limit": "20"]) {
            heartbeat = h
        }
    }

    func refreshModels() async {
        struct Resp: Decodable { let models: [SMModelRow]? }
        if let r: Resp = try? await AlmaAPI.shared.get("/api/assistant/models") {
            if let rows = r.models { models = rows }
        }
    }

    func refreshSlo() async {
        if let v: SMSloView =
            try? await AlmaAPI.shared.get("/api/assistant/controls", query: ["section": "slo"]) {
            slo = v
        }
    }

    func refreshRouting() async {
        if let r: SMRoutingResponse = try? await AlmaAPI.shared.get("/api/assistant/model-routing") {
            routing = r
            if routingDraft == nil { routingDraft = r.config }
        }
    }

    // ── Mutations (server echo is the displayed truth — §4.8) ──

    /// PATCH /api/assistant/controls — exactly the web AgentControlCenter payload.
    func patchControls(_ body: SMControlsPatch) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let updated: SMControls = try await AlmaAPI.shared.send("PATCH", "/api/assistant/controls", body: body)
            controls = updated
            actionError = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            actionError = "পরিবর্তন ব্যর্থ: \(error.localizedDescription)"
        }
    }

    func setPaused(_ paused: Bool) async { await patchControls(SMControlsPatch(paused: paused)) }

    /// POST /api/assistant/live-browser/watch {action} — web payload verbatim.
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

    /// POST /api/assistant/heartbeat {action} — the response IS the fresh feed.
    func heartbeatAction(_ action: String) async {
        guard !heartbeatBusy else { return }
        heartbeatBusy = true
        defer { heartbeatBusy = false }
        struct Body: Encodable { let action: String }
        do {
            let feed: SMHeartbeatFeed =
                try await AlmaAPI.shared.send("POST", "/api/assistant/heartbeat", body: Body(action: action))
            heartbeat = feed
            actionError = nil
            if action == "test_now" {
                heartbeatToast = feed.testSummary.map { "টেস্ট: \(String($0.prefix(80)))" } ?? "হার্টবিট টেস্ট হলো"
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            actionError = "ব্যর্থ: \(error.localizedDescription)"
        }
    }

    /// PATCH /api/assistant/models {modelId, enabled} — apply the enabledMap echo.
    func toggleModel(_ modelId: String, enabled: Bool) async {
        guard modelSavingId == nil else { return }
        modelSavingId = modelId
        defer { modelSavingId = nil }
        struct Body: Encodable { let modelId: String; let enabled: Bool }
        struct Resp: Decodable { let ok: Bool?; let enabledMap: [String: Bool]?; let error: String? }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/models", body: Body(modelId: modelId, enabled: enabled))
            guard r.ok == true else {
                actionError = r.error ?? "ব্যর্থ — আবার চেষ্টা করুন"
                return
            }
            if let map = r.enabledMap, var rows = models {
                for i in rows.indices { rows[i].enabled = map[rows[i].id] != false }
                models = rows
            } else {
                await refreshModels()
            }
            actionError = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            actionError = "ব্যর্থ: \(error.localizedDescription)"
        }
    }

    /// POST /api/assistant/model-routing — full draft; server echoes {config}.
    func saveRouting() async {
        guard let draft = routingDraft, !routingSaving else { return }
        routingSaving = true
        defer { routingSaving = false }
        struct Resp: Decodable { let config: SMRoutingConfig }
        do {
            let r: Resp = try await AlmaAPI.shared.send("POST", "/api/assistant/model-routing", body: draft)
            routingDraft = r.config
            if routing != nil { await refreshRouting() }
            actionError = nil
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            actionError = "সেভ ব্যর্থ: \(error.localizedDescription)"
        }
    }

    var routingDirty: Bool {
        guard let r = routing, let d = routingDraft else { return false }
        return r.config != d
    }
}

// MARK: - Confirm-dialog actions (Bangla copy — dangerous ops only, §4.8)

enum StaffMonitorControlAction {
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

// MARK: - Agents tab (rendered by StaffMonitorScreen)

@available(iOS 17.0, *)
struct StaffMonitorAgentsTab: View {
    let vm: StaffMonitorControlsVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var pending: StaffMonitorControlAction? = nil
    @State private var modelSearch = ""
    @State private var modelsCollapsed = false
    @State private var showScreenshotViewer = false

    private let emerald = Color(red: 0.020, green: 0.588, blue: 0.412)
    private let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)
    private let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)
    private let coral = Color(red: 0.878, green: 0.478, blue: 0.373)

    /// Owner feedback 2026-07-17: the six stacked cards read like the cluttered web
    /// page. iOS composition instead — a COMPACT control-room list (icon + live
    /// status + chevron, More-menu language); each row drills into a focused sheet.
    enum AgentSheet: String, Identifiable {
        case control, models, heartbeat, browser, routing, slo
        var id: String { rawValue }
    }
    @State private var sheet: AgentSheet? = nil

    var body: some View {
        VStack(spacing: 10) {
            VStack(spacing: 0) {
                controlRoomRow("🎛️", "কন্ট্রোল সেন্টার",
                               vm.controls.map { $0.paused ? "Agent বন্ধ আছে" : "চালু · অটোনমি: \($0.autonomyLabel)" } ?? "লোড হচ্ছে…",
                               tint: vm.controls?.paused == true ? red500 : emerald,
                               sheet: .control) {
                    // Quick master toggle stays one tap away (never optimistic).
                    if let c = vm.controls {
                        Toggle("", isOn: Binding(
                            get: { !c.paused },
                            set: { on in pending = on ? .resumeAgent : .pauseAgent }))
                            .labelsHidden()
                            .tint(emerald)
                            .disabled(vm.busy)
                    }
                }
                Divider().opacity(0.25).padding(.leading, 56)
                controlRoomRow("🧠", "AI মডেল",
                               vm.models.map { "\($0.filter(\.enabled).count)/\($0.count) চালু" } ?? "লোড হচ্ছে…",
                               tint: emerald, sheet: .models)
                Divider().opacity(0.25).padding(.leading, 56)
                controlRoomRow("💓", "হার্টবিট",
                               vm.heartbeat.map { $0.enabled ? "চালু · আজ \($0.wakesToday)/\($0.dailyHeadWakeCap) বার" : "বন্ধ" } ?? "লোড হচ্ছে…",
                               tint: vm.heartbeat?.enabled == true ? emerald : .secondary,
                               sheet: .heartbeat)
                Divider().opacity(0.25).padding(.leading, 56)
                controlRoomRow("🖥️", "লাইভ ব্রাউজার",
                               vm.watch.map { w in
                                   w.enabled ? "চালু · অনলাইন \(w.onlineCount)\(w.running ? " · কাজ চলছে" : "")" : "বন্ধ"
                               } ?? "লোড হচ্ছে…",
                               tint: vm.watch?.enabled == true ? emerald : .secondary,
                               sheet: .browser)
                Divider().opacity(0.25).padding(.leading, 56)
                controlRoomRow("🎚️", "Opus রাউটিং",
                               vm.routing.map { "Opus \($0.config.opusEnabled ? "চালু" : "বন্ধ") · আজ \($0.opusUsedToday) কল" } ?? "লোড হচ্ছে…",
                               tint: vm.routing?.config.opusEnabled == true ? coral : .secondary,
                               sheet: .routing)
                Divider().opacity(0.25).padding(.leading, 56)
                controlRoomRow("📏", "SLO — স্বয়ংক্রিয়তার মান",
                               vm.slo.map { $0.breaches.isEmpty ? "সব invariant ঠিক ✓" : "\($0.breaches.count)টা লঙ্ঘন" } ?? "লোড হচ্ছে…",
                               tint: (vm.slo?.breaches.isEmpty ?? true) ? emerald : red500,
                               sheet: .slo)
            }
            .smGlass(scheme)
            if let err = vm.actionError {
                Text(err).font(.caption2).foregroundStyle(red500)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .sheet(item: $sheet) { which in
            NavigationStack {
                ScrollView {
                    VStack(spacing: 10) {
                        switch which {
                        case .control: controlCenterCard
                        case .models: modelsCard
                        case .heartbeat: heartbeatCard
                        case .browser: liveBrowserCard
                        case .routing: routingCard
                        case .slo: sloCard
                        }
                    }
                    .padding(14)
                }
                .scrollContentBackground(.hidden)
                .navigationTitle(sheetTitle(which))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("বন্ধ") { sheet = nil }
                    }
                }
            }
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
            // Aurora, not flat near-black — same look as the tab (owner feedback 2026-07-17).
            .presentationBackground { StaffMonitorAurora() }
        }
        // Tab-visible fast cadence (§4.9): 2.5s watch (web parity) + 30s panels,
        // ONLY while this tab is on screen and the app is foregrounded. The
        // screen's own 10s loop keeps the status strip fresh on other tabs.
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                if Task.isCancelled { break }
                guard scenePhase == .active else { continue }
                await vm.refreshWatch()
            }
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                if Task.isCancelled { break }
                guard scenePhase == .active else { continue }
                await vm.refreshHeartbeat()
                await vm.refreshModels()
                await vm.refreshSlo()
                await vm.refreshRouting()
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
        .sheet(isPresented: $showScreenshotViewer) {
            if let img = vm.watch?.screenshotImage {
                SMScreenshotViewer(image: img, at: vm.watch?.latestScreenshotAt)
            }
        }
        .alert("হার্টবিট", isPresented: Binding(
            get: { vm.heartbeatToast != nil },
            set: { if !$0 { vm.heartbeatToast = nil } })) {
            Button("ঠিক আছে") { vm.heartbeatToast = nil }
        } message: {
            Text(vm.heartbeatToast ?? "")
        }
    }

    private func sheetTitle(_ s: AgentSheet) -> String {
        switch s {
        case .control: return "কন্ট্রোল সেন্টার"
        case .models: return "AI মডেল"
        case .heartbeat: return "হার্টবিট"
        case .browser: return "লাইভ ব্রাউজার"
        case .routing: return "Opus রাউটিং"
        case .slo: return "SLO"
        }
    }

    /// One iOS-style control-room row: icon square · title · live subtitle ·
    /// optional inline accessory (master toggle) · chevron → sheet.
    private func controlRoomRow(_ icon: String, _ title: String, _ subtitle: String,
                                tint: Color, sheet target: AgentSheet,
                                @ViewBuilder accessory: () -> some View = { EmptyView() }) -> some View {
        HStack(spacing: 12) {
            Button {
                UISelectionFeedbackGenerator().selectionChanged()
                sheet = target
            } label: {
                HStack(spacing: 12) {
                    Text(icon)
                        .font(.system(size: 17))
                        .frame(width: 38, height: 38)
                        .background(tint.opacity(0.13),
                                    in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                        Text(subtitle).font(.caption2).foregroundStyle(tint).lineLimit(1)
                    }
                    Spacer(minLength: 8)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            accessory()
            Button {
                UISelectionFeedbackGenerator().selectionChanged()
                sheet = target
            } label: {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("\(title) — \(subtitle)"))
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

    // ── 🎛️ Control Center: pause + autonomy + capabilities (AG-02, full parity) ──

    @ViewBuilder private var controlCenterCard: some View {
        if let c = vm.controls {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Text("🎛️ কন্ট্রোল সেন্টার")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    Text("মালিক নিয়ন্ত্রণ").font(.system(size: 9)).foregroundStyle(.secondary)
                    if vm.busy { ProgressView().controlSize(.mini) }
                }
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.paused ? "🛑 Agent বন্ধ আছে" : "🟢 Agent চালু আছে")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(c.paused ? red500 : emerald)
                        Text(c.paused
                             ? "এখন কোনো উত্তর বা কাজ করবে না (ওয়েব + টেলিগ্রাম)।"
                             : "সব কিছু বন্ধ করতে চাইলে সুইচ দিয়ে সাথে সাথে থামান।")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    // Never optimistic: the toggle only raises the confirm dialog;
                    // it moves when the server echo lands.
                    Toggle("", isOn: Binding(
                        get: { !c.paused },
                        set: { on in pending = on ? .resumeAgent : .pauseAgent }))
                        .labelsHidden()
                        .tint(emerald)
                        .disabled(vm.busy)
                }
                Divider().opacity(0.4)

                // Autonomy — web AUTONOMY_OPTIONS segmented control.
                VStack(alignment: .leading, spacing: 6) {
                    Text("অটোনমি — নিজে কতটা কাজ করবে")
                        .font(.caption.weight(.semibold))
                    Text("টাকা খরচ ও পাবলিক পোস্ট সবসময় আগে অনুমতি নেবে — যেকোনো মোডেই।")
                        .font(.caption2).foregroundStyle(.secondary)
                    HStack(spacing: 4) {
                        ForEach(SMControls.autonomyOptions, id: \.value) { opt in
                            let active = c.autonomy == opt.value
                            Button {
                                UISelectionFeedbackGenerator().selectionChanged()
                                Task { await vm.patchControls(SMControlsPatch(autonomy: opt.value)) }
                            } label: {
                                Text(opt.label)
                                    .font(.caption.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 7)
                                    .background(active ? coral : Color.primary.opacity(0.04), in: Capsule())
                                    .foregroundStyle(active ? .white : .secondary)
                            }
                            .buttonStyle(.plain)
                            .disabled(vm.busy)
                        }
                    }
                }
                Divider().opacity(0.4)

                // Capability switches — web CapabilityRow parity.
                VStack(alignment: .leading, spacing: 2) {
                    Text("ফিচার চালু/বন্ধ").font(.caption.weight(.semibold))
                    Text("বন্ধ করলে Agent ঐ কাজ করবে না — চাইলে আপনাকে চালু করতে বলবে।")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                capabilityRow("🔎", "ওয়েব রিসার্চ", "Oxylabs পেইড রিসার্চ", c.webResearch) { on in
                    SMControlsPatch(capabilities: .init(webResearch: on))
                }
                capabilityRow("📣", "সোশ্যাল/ফেসবুক পোস্ট ও অ্যাড", "পোস্ট ও ক্যাম্পেইন", c.socialPosting) { on in
                    SMControlsPatch(capabilities: .init(socialPosting: on))
                }
                capabilityRow("🎨", "ছবি ও ভিডিও জেনারেশন", "Nano Banana / VEO", c.imageVideoGen) { on in
                    SMControlsPatch(capabilities: .init(imageVideoGen: on))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .smGlass(scheme)
        }
    }

    private func capabilityRow(_ icon: String, _ label: String, _ hint: String,
                               _ on: Bool, patch: @escaping (Bool) -> SMControlsPatch) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text("\(icon) \(label)").font(.caption.weight(.medium))
                Text(hint).font(.system(size: 10)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Toggle("", isOn: Binding(get: { on }, set: { newOn in
                UISelectionFeedbackGenerator().selectionChanged()
                Task { await vm.patchControls(patch(newOn)) }
            }))
            .labelsHidden()
            .tint(Color(red: 0.506, green: 0.698, blue: 0.604))
            .disabled(vm.busy)
        }
        .padding(.vertical, 2)
    }

    // ── 📏 Autonomy SLO (AG-03) ──

    @ViewBuilder private var sloCard: some View {
        if let s = vm.slo {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("📏 স্বয়ংক্রিয়তার মান (SLO)")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    if s.hasSlo {
                        Text("গত \(Int((s.windowHours / 24).rounded())) দিন")
                            .font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                }
                if s.hasSlo {
                    // Global zero-invariants (web Invariant grid).
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)],
                              spacing: 6) {
                        invariantCell("ডুপ্লিকেট effect", "\(s.duplicateExternalEffects)",
                                      good: s.duplicateExternalEffects == 0)
                        invariantCell("অনুমোদনহীন বড় কাজ", "\(s.unapprovedHighImpactEffects)",
                                      good: s.unapprovedHighImpactEffects == 0)
                        invariantCell("অজানা অবস্থার effect", "\(s.unknownEffects)", good: true)
                        invariantCell("গার্ড কাভারেজ", String(format: "%.0f%%", s.guardCoverage * 100),
                                      good: s.guardCoverage == 1)
                    }
                    if !s.breaches.isEmpty {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(Array(s.breaches.enumerated()), id: \.offset) { _, b in
                                Text("🛑 \(b)").font(.caption2).foregroundStyle(red500)
                            }
                            Text("লঙ্ঘন হলে শ্রেণিটা নিজে থেকেই এক ধাপ নেমে যায়।")
                                .font(.system(size: 9)).foregroundStyle(.secondary)
                        }
                        .padding(8)
                        .background(red500.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    }
                    // Per-class rows (web table → compact rows).
                    let visible = s.classes.filter { $0.samples > 0 || $0.stage != "off" }
                    if visible.isEmpty {
                        Text("এখনো কোনো effect রেকর্ড হয়নি — engine চালু হলে এখানে শ্রেণি-ধরে মান দেখা যাবে।")
                            .font(.caption2).foregroundStyle(.secondary)
                    } else {
                        ForEach(visible) { cls in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text("\(cls.labelBn)").font(.caption.weight(.semibold))
                                    Text("(\(cls.tier))").font(.system(size: 9)).foregroundStyle(.secondary)
                                    Spacer()
                                    Text("ধাপ: \(cls.stage) · নমুনা \(cls.samples)")
                                        .font(.system(size: 9)).foregroundStyle(.secondary)
                                }
                                HStack(spacing: 10) {
                                    sloStat("নির্ভরযোগ্যতা", cls.successRate)
                                    sloStat("প্রমাণসহ", cls.verifiedCompletionRate)
                                    sloStat("undo", cls.compensationSuccessRate)
                                    Spacer()
                                    Text(String(format: "$%.2f", cls.totalCostUsd))
                                        .font(.system(size: 9, weight: .semibold).monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 3)
                            if cls.id != visible.last?.id { Divider().opacity(0.3) }
                        }
                    }
                    Text("Outbox: due \(s.outboxDue) · চলমান \(s.outboxLeased) · জরুরি থামাতে: AGENT_ENABLED=false")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                } else {
                    Text("SLO ডেটা নেই (engine বন্ধ থাকতে পারে)।")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .smGlass(scheme)
        }
    }

    private func invariantCell(_ label: String, _ value: String, good: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 9)).foregroundStyle(.secondary)
            Text(value).font(.subheadline.weight(.bold)).foregroundStyle(good ? emerald : red500)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background((good ? emerald : red500).opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10)
            .strokeBorder((good ? emerald : red500).opacity(0.25), lineWidth: 0.8))
    }

    private func sloStat(_ label: String, _ v: SMSloValue) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 8)).foregroundStyle(.secondary)
            Text(v.text).font(.system(size: 10, weight: .bold)).foregroundStyle(v.color(target: 0.99))
        }
    }

    // ── 🧠 Model toggles (AG-04): search + provider groups + PATCH echo ──

    @ViewBuilder private var modelsCard: some View {
        if let rows = vm.models {
            let filtered = modelSearch.isEmpty ? rows : rows.filter {
                $0.label.localizedCaseInsensitiveContains(modelSearch)
                    || $0.id.localizedCaseInsensitiveContains(modelSearch)
                    || $0.provider.localizedCaseInsensitiveContains(modelSearch)
            }
            let providers = Dictionary(grouping: filtered, by: \.provider)
                .sorted { $0.key < $1.key }
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("🧠 AI Model on/off")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    Text("\(rows.filter(\.enabled).count)/\(rows.count) চালু")
                        .font(.system(size: 9, weight: .bold)).foregroundStyle(emerald)
                    Button {
                        UISelectionFeedbackGenerator().selectionChanged()
                        withAnimation { modelsCollapsed.toggle() }
                    } label: {
                        Image(systemName: modelsCollapsed ? "chevron.down" : "chevron.up")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                if !modelsCollapsed {
                    Text("OFF করলে সেই model পুরো সিস্টেমে বন্ধ — pinned chat-ও অটো fallback-এ চলে যাবে।")
                        .font(.caption2).foregroundStyle(.secondary)
                    if rows.count > 6 {
                        TextField("মডেল খুঁজুন…", text: $modelSearch)
                            .font(.caption)
                            .textFieldStyle(.roundedBorder)
                    }
                    ForEach(providers, id: \.key) { provider, group in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(provider.uppercased())
                                .font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                            ForEach(group) { m in
                                HStack(spacing: 8) {
                                    Text(m.label).font(.caption.weight(.medium)).lineLimit(1)
                                    Spacer(minLength: 8)
                                    if vm.modelSavingId == m.id { ProgressView().controlSize(.mini) }
                                    Toggle("", isOn: Binding(get: { m.enabled }, set: { on in
                                        UISelectionFeedbackGenerator().selectionChanged()
                                        Task { await vm.toggleModel(m.id, enabled: on) }
                                    }))
                                    .labelsHidden()
                                    .tint(Color(red: 0.506, green: 0.698, blue: 0.604))
                                    .disabled(vm.modelSavingId != nil)
                                }
                                .padding(.vertical, 1)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .smGlass(scheme)
        }
    }

    // ── 💓 Heartbeat (AG-05): enable/pause + test-now + full timeline ──

    @ViewBuilder private var heartbeatCard: some View {
        if let h = vm.heartbeat {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Text("💓 হার্টবিট")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    if !h.enabled && h.autoArm {
                        smPill("🤖 নিজে চালু হবে", Color(red: 0.055, green: 0.647, blue: 0.914))
                    }
                    smPill(h.enabled ? "🟢 চালু" : "🔴 বন্ধ", h.enabled ? emerald : .secondary)
                }
                Text("এজেন্ট নিজে থেকে মাঝে মাঝে জেগে ব্যবসার অবস্থা দেখে — দরকার হলে নিজে ব্যবস্থা নেয় বা আপনাকে জানায়।")
                    .font(.caption2).foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task { await vm.heartbeatAction(h.enabled ? "disable" : "enable") }
                    } label: {
                        Text(h.enabled ? "⏸️ বন্ধ করো" : "▶️ চালু করো")
                            .font(.caption.weight(.bold))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background((h.enabled ? red500 : emerald).opacity(0.14), in: Capsule())
                            .foregroundStyle(h.enabled ? red500 : emerald)
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.heartbeatBusy)
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        Task { await vm.heartbeatAction("test_now") }
                    } label: {
                        Text("🧪 এখন টেস্ট করো")
                            .font(.caption.weight(.bold))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .background(Color.primary.opacity(0.05), in: Capsule())
                            .foregroundStyle(.primary)
                    }
                    .buttonStyle(.plain)
                    .disabled(vm.heartbeatBusy)
                    Spacer()
                    if vm.heartbeatBusy { ProgressView().controlSize(.mini) }
                    Text("আজ \(h.wakesToday)/\(h.dailyHeadWakeCap) বার")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                }
                Divider().opacity(0.4)
                if h.entries.isEmpty {
                    Text("এখনো কোনো হার্টবিট টিক নেই।").font(.caption2).foregroundStyle(.secondary)
                } else {
                    ForEach(h.entries) { e in
                        HStack(alignment: .top, spacing: 8) {
                            Text(e.tag).font(.caption)
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(e.label).font(.caption.weight(.semibold))
                                    if let t = smClock(e.at) {
                                        Text(t).font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                                    }
                                    if e.headWoke {
                                        Text("head")
                                            .font(.system(size: 8, weight: .bold))
                                            .foregroundStyle(amber600)
                                            .padding(.horizontal, 4).padding(.vertical, 1)
                                            .background(amber600.opacity(0.12), in: Capsule())
                                    }
                                }
                                Text(e.summary).font(.caption2).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 2)
                        if e.id != h.entries.last?.id { Divider().opacity(0.3) }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .smGlass(scheme)
        }
    }

    // ── 🖥️ Live browser (AG-06 + AG-08): devices · screenshot · steps · stop ──

    @ViewBuilder private var liveBrowserCard: some View {
        if let w = vm.watch {
            let tint = w.enabled ? red500 : emerald
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Text("🖥️ লাইভ ব্রাউজার")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    if w.running { smPill("🤖 কাজ চলছে", amber600) }
                    smPill(w.enabled ? "🟢 চালু · অনলাইন \(w.onlineCount)" : "🔴 বন্ধ",
                           w.enabled ? emerald : .secondary)
                }
                Text("এজেন্ট আপনার Chrome-এ কী করছে — প্রতিটা ধাপ আর সর্বশেষ স্ক্রিনশট এখানে লাইভ। লাল বোতামে সব সাথে সাথে থামে।")
                    .font(.caption2).foregroundStyle(.secondary)

                // Devices (web: "🟢 name · ⚪️ name").
                if !w.devices.isEmpty {
                    Text(w.devices.map { "\($0.online ? "🟢" : "⚪️") \($0.name)" }.joined(separator: " · "))
                        .font(.caption2).foregroundStyle(.secondary)
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

                // Latest screenshot — tap to zoom (share/save in the viewer).
                if let img = w.screenshotImage {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(spacing: 6) {
                            Text("📸 সর্বশেষ স্ক্রিনশট").font(.caption2.weight(.semibold))
                            if let t = smClock(w.latestScreenshotAt) {
                                Text(t).font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                        Button {
                            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                            showScreenshotViewer = true
                        } label: {
                            Image(uiImage: img)
                                .resizable()
                                .scaledToFit()
                                .frame(maxHeight: 220)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.2), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text("এজেন্ট এখন যে পেজ দেখছে — বড় করতে চাপুন"))
                    }
                }

                // Step feed (web rows: action BN · target · badge · error · time).
                Divider().opacity(0.4)
                if w.steps.isEmpty {
                    Text("এখনো কোনো ধাপ নেই। এজেন্টকে ব্রাউজারের কাজ দিলে এখানে লাইভ দেখা যাবে।")
                        .font(.caption2).foregroundStyle(.secondary)
                } else {
                    ForEach(w.steps) { s in
                        let badge = smStepBadge(s.status)
                        HStack(alignment: .top, spacing: 8) {
                            Text(smActionBN(s.action))
                                .font(.system(size: 10, weight: .semibold))
                                .frame(width: 92, alignment: .leading)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(s.target.isEmpty ? "—" : s.target)
                                    .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                                if let err = s.error, !err.isEmpty {
                                    Text(String(err.prefix(120)))
                                        .font(.system(size: 9)).foregroundStyle(red500).lineLimit(2)
                                }
                            }
                            Spacer(minLength: 4)
                            Text(badge.label)
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(badge.color)
                                .padding(.horizontal, 5).padding(.vertical, 2)
                                .background(badge.color.opacity(0.10), in: Capsule())
                            if let t = smClock(s.at) {
                                Text(t).font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 2)
                        if s.id != w.steps.last?.id { Divider().opacity(0.3) }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .smGlass(scheme)
        }
    }

    // ── 🎛️ Model routing dial + daily activity (web MonitorAgentsPanel) ──

    @ViewBuilder private var routingCard: some View {
        if let r = vm.routing, let d = vm.routingDraft {
            let capPct = r.config.opusDailyCap > 0
                ? min(1, Double(r.opusUsedToday) / Double(r.config.opusDailyCap)) : 0
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("🎛️ Model Control")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    Text("আপনি নিয়ন্ত্রণ করেন").font(.system(size: 9)).foregroundStyle(coral)
                }
                // Opus master toggle
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Opus এজেন্ট (Claude Opus 4.8)").font(.caption.weight(.bold))
                        Text("বন্ধ থাকলে সব কাজ সস্তা মডেলে হবে — সবচেয়ে কম খরচ")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Toggle("", isOn: Binding(
                        get: { d.opusEnabled },
                        set: { on in vm.routingDraft?.opusEnabled = on }))
                        .labelsHidden().tint(coral)
                }
                Group {
                    // Premium model selector
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text("কোন প্রিমিয়াম মডেল").font(.caption.weight(.semibold))
                            Spacer()
                            Text("$ প্রতি 1M টোকেন (in/out)").font(.system(size: 9)).foregroundStyle(.secondary)
                        }
                        ForEach(r.criticalModelOptions) { m in
                            let active = d.criticalModelId == m.id
                            Button {
                                UISelectionFeedbackGenerator().selectionChanged()
                                vm.routingDraft?.criticalModelId = m.id
                            } label: {
                                HStack {
                                    Text("\(active ? "●" : "○") \(m.label)")
                                        .font(.caption.weight(.bold))
                                        .foregroundStyle(active ? coral : .primary)
                                    Spacer()
                                    Text(String(format: "$%g/$%g", m.inPerM, m.outPerM))
                                        .font(.system(size: 10, weight: .semibold).monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                                .padding(.horizontal, 10).padding(.vertical, 8)
                                .background(active ? coral.opacity(0.10) : Color.primary.opacity(0.03),
                                            in: RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10)
                                    .strokeBorder(active ? coral.opacity(0.4) : Color.primary.opacity(0.08),
                                                  lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                        }
                        Text("হেড: \(r.headModelLabel) (\(String(format: "$%g/$%g", r.headInPerM, r.headOutPerM))) — সস্তা, ৯০% কাজ এতেই")
                            .font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                    // Daily cap stepper + usage bar
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text("দৈনিক Opus সীমা").font(.caption.weight(.semibold))
                            Spacer()
                            Text("আজ ব্যবহার: \(r.opusUsedToday)")
                                .font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                        }
                        HStack(spacing: 10) {
                            Stepper("\(d.opusDailyCap) কল/দিন", value: Binding(
                                get: { d.opusDailyCap },
                                set: { vm.routingDraft?.opusDailyCap = max(0, min(100, $0)) }),
                                in: 0...100)
                                .font(.caption.weight(.bold))
                        }
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.primary.opacity(0.07))
                                Capsule().fill(coral)
                                    .frame(width: max(0, geo.size.width * capPct))
                            }
                        }
                        .frame(height: 5)
                    }
                    // Confidence slider
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("কখন Opus ডাকবে (confidence)").font(.caption.weight(.semibold))
                            Spacer()
                            Text("\(Int((d.opusConfidenceThreshold * 100).rounded()))%")
                                .font(.caption.weight(.bold).monospacedDigit()).foregroundStyle(coral)
                        }
                        Slider(value: Binding(
                            get: { d.opusConfidenceThreshold },
                            set: { vm.routingDraft?.opusConfidenceThreshold = ($0 * 20).rounded() / 20 }),
                            in: 0.5...0.95)
                            .tint(coral)
                        Text("হেডের আত্মবিশ্বাস এর নিচে নামলে তবেই Opus হাত দেয়")
                            .font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                    // Critical taka chips
                    VStack(alignment: .leading, spacing: 5) {
                        Text("বড় টাকার সিদ্ধান্ত — সীমা").font(.caption.weight(.semibold))
                        HStack(spacing: 6) {
                            ForEach([5000, 10000, 20000, 50000], id: \.self) { amt in
                                let active = d.opusCriticalTaka == amt
                                Button {
                                    UISelectionFeedbackGenerator().selectionChanged()
                                    vm.routingDraft?.opusCriticalTaka = amt
                                } label: {
                                    Text("৳\(amt)")
                                        .font(.system(size: 10, weight: .bold).monospacedDigit())
                                        .padding(.horizontal, 9).padding(.vertical, 6)
                                        .background(active ? coral.opacity(0.12) : Color.primary.opacity(0.03),
                                                    in: RoundedRectangle(cornerRadius: 8))
                                        .foregroundStyle(active ? coral : .secondary)
                                        .overlay(RoundedRectangle(cornerRadius: 8)
                                            .strokeBorder(active ? coral.opacity(0.4) : Color.primary.opacity(0.08),
                                                          lineWidth: 1))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        Text("এর সমান বা বেশি টাকার সিদ্ধান্তে সবসময় প্রিমিয়াম মডেল")
                            .font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                }
                .opacity(d.opusEnabled ? 1 : 0.4)
                .disabled(!d.opusEnabled)

                // Save bar (web: dirty → সেভ করুন / বাতিল)
                HStack(spacing: 8) {
                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task { await vm.saveRouting() }
                    } label: {
                        Text(vm.routingSaving ? "সেভ হচ্ছে…" : (vm.routingDirty ? "💾 সেভ করুন" : "✓ সেভ করা আছে"))
                            .font(.caption.weight(.bold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 9)
                            .background(vm.routingDirty && !vm.routingSaving ? coral : Color.primary.opacity(0.06),
                                        in: Capsule())
                            .foregroundStyle(vm.routingDirty && !vm.routingSaving ? .white : .secondary)
                    }
                    .buttonStyle(.plain)
                    .disabled(!vm.routingDirty || vm.routingSaving)
                    if vm.routingDirty && !vm.routingSaving {
                        Button {
                            UISelectionFeedbackGenerator().selectionChanged()
                            vm.routingDraft = r.config
                        } label: {
                            Text("বাতিল").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                .padding(.horizontal, 12).padding(.vertical, 9)
                        }
                        .buttonStyle(.plain)
                    }
                }

                // 🎥 আজ কে কী করেছে — daily activity (agents + specialists)
                Divider().opacity(0.4)
                HStack {
                    Text("🎥 আজ কে কী করেছে")
                        .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                    Spacer()
                    Text(r.todayDhakaDate).font(.system(size: 9)).foregroundStyle(.secondary)
                }
                if r.agentsToday.isEmpty {
                    Text("আজ এখনও কোনো এজেন্ট কাজ শুরু করেনি").font(.caption2).foregroundStyle(.secondary)
                } else {
                    ForEach(r.agentsToday) { a in
                        HStack(spacing: 8) {
                            Text(a.emoji).font(.caption)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(a.label).font(.caption.weight(.bold))
                                Text(a.role).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Text("\(a.calls) কল · \(smUsd(a.costUsd))")
                                .font(.system(size: 10, weight: .semibold).monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
                if !r.specialistsToday.isEmpty {
                    Divider().opacity(0.3)
                    ForEach(r.specialistsToday) { s in
                        HStack(spacing: 8) {
                            Text(s.icon).font(.caption)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(s.displayName).font(.caption.weight(.semibold))
                                Text(s.modelLabel).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Text("\(s.calls) কল · \(smUsd(s.costUsd))")
                                .font(.system(size: 10, weight: .semibold).monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .smGlass(scheme)
        }
    }

    // ── Shared bits ──

    private func smPill(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(color.opacity(0.10), in: Capsule())
            .overlay(Capsule().strokeBorder(color.opacity(0.30), lineWidth: 0.8))
    }
}

/// Web fmtUsd parity.
private func smUsd(_ n: Double) -> String {
    if n == 0 { return "$0" }
    if n < 0.01 { return "<$0.01" }
    return String(format: "$%.2f", n)
}

/// HH:mm:ss in Asia/Dhaka (web fmtTime with seconds for steps; falls back to HH:mm).
func smClock(_ iso: String?) -> String? {
    guard let iso else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let date = fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    guard let date else { return nil }
    let f = DateFormatter()
    f.dateFormat = "HH:mm"
    f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
    return f.string(from: date)
}

// MARK: - Screenshot zoom viewer (pinch-zoom + share/save via system sheet)

@available(iOS 17.0, *)
struct SMScreenshotViewer: View {
    let image: UIImage
    let at: String?
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                ScrollView([.horizontal, .vertical], showsIndicators: false) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: geo.size.width * scale)
                        .gesture(
                            MagnificationGesture()
                                .onChanged { v in scale = max(1, min(5, lastScale * v)) }
                                .onEnded { _ in lastScale = scale }
                        )
                }
            }
            .background(Color.black)
            .navigationTitle(smClock(at).map { "📸 \($0)" } ?? "📸 স্ক্রিনশট")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("বন্ধ") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if let data = image.pngData() {
                        ShareLink(item: SMScreenshotFile(data: data),
                                  preview: SharePreview("এজেন্ট স্ক্রিনশট", image: Image(uiImage: image))) {
                            Image(systemName: "square.and.arrow.up")
                        }
                    }
                }
            }
        }
    }
}

/// Transferable PNG wrapper so ShareLink offers Save Image / share targets.
struct SMScreenshotFile: Transferable {
    let data: Data
    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .png) { $0.data }
    }
}

// MARK: - Glass card (file-owned copy per parallel-session rule)

@available(iOS 17.0, *)
private extension View {
    func smGlass(_ scheme: ColorScheme) -> some View {
        self
            .background(.ultraThinMaterial,
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

// MARK: - Dedicated Live Watch screen (owner feedback 2026-07-17: NOT a Monitor copy)

/// /agent/live-watch now opens THIS focused screen — the live browser feed as the
/// hero (big screenshot, devices, stop switch, step stream). The Monitor's Agents
/// tab keeps a compact row that opens the same panel; both read one VM/data source.
@available(iOS 17.0, *)
struct LiveWatchScreen: View {
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var vm = StaffMonitorControlsVM()
    @State private var pending: StaffMonitorControlAction? = nil
    @State private var showViewer = false

    private let emerald = Color(red: 0.020, green: 0.588, blue: 0.412)
    private let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)
    private let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                if let w = vm.watch {
                    // ── Hero: what the agent sees RIGHT NOW ──
                    if let img = w.screenshotImage {
                        Button {
                            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                            showViewer = true
                        } label: {
                            Image(uiImage: img)
                                .resizable()
                                .scaledToFit()
                                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
                                .overlay(alignment: .topLeading) {
                                    HStack(spacing: 5) {
                                        Circle().fill(w.running ? amber600 : emerald)
                                            .frame(width: 7, height: 7)
                                        Text(w.running ? "কাজ চলছে" : "LIVE")
                                            .font(.system(size: 10, weight: .heavy))
                                    }
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 9).padding(.vertical, 5)
                                    .background(.black.opacity(0.55), in: Capsule())
                                    .padding(10)
                                }
                                .overlay(alignment: .topTrailing) {
                                    if let t = smClock(w.latestScreenshotAt) {
                                        Text(t)
                                            .font(.system(size: 10, weight: .bold).monospacedDigit())
                                            .foregroundStyle(.white)
                                            .padding(.horizontal, 8).padding(.vertical, 5)
                                            .background(.black.opacity(0.55), in: Capsule())
                                            .padding(10)
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text("এজেন্ট এখন যে পেজ দেখছে — বড় করতে চাপুন"))
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "display")
                                .font(.largeTitle).foregroundStyle(.secondary)
                            Text(w.enabled ? "এখনো কোনো স্ক্রিনশট নেই — এজেন্ট ব্রাউজারে কাজ শুরু করলে এখানে লাইভ দেখা যাবে।"
                                           : "লাইভ ব্রাউজার বন্ধ আছে।")
                                .font(.caption).foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 44)
                        .smGlass(scheme)
                    }

                    // ── Status + devices + kill switch ──
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 8) {
                            Circle().fill(w.enabled ? emerald : red500).frame(width: 9, height: 9)
                            Text(w.enabled ? "চালু · অনলাইন \(w.onlineCount) ডিভাইস" : "বন্ধ")
                                .font(.subheadline.weight(.bold))
                            Spacer()
                            if vm.busy { ProgressView().controlSize(.small) }
                        }
                        if !w.devices.isEmpty {
                            Text(w.devices.map { "\($0.online ? "🟢" : "⚪️") \($0.name)" }.joined(separator: "  ·  "))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Button {
                            UISelectionFeedbackGenerator().selectionChanged()
                            pending = w.enabled ? .stopBrowser : .resumeBrowser
                        } label: {
                            Text(w.enabled ? "⏹ সব থামাও" : "▶️ আবার চালু করো")
                                .font(.subheadline.weight(.bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background((w.enabled ? red500 : emerald).opacity(0.14), in: Capsule())
                                .foregroundStyle(w.enabled ? red500 : emerald)
                                .overlay(Capsule().strokeBorder(
                                    (w.enabled ? red500 : emerald).opacity(0.35), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .disabled(vm.busy)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .smGlass(scheme)

                    // ── Step stream ──
                    VStack(alignment: .leading, spacing: 8) {
                        Text("লাইভ স্টেপ")
                            .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
                        if w.steps.isEmpty {
                            Text("এখনো কোনো ধাপ নেই।").font(.caption2).foregroundStyle(.secondary)
                        } else {
                            ForEach(w.steps) { s in
                                let badge = smStepBadge(s.status)
                                HStack(alignment: .top, spacing: 8) {
                                    Text(smActionBN(s.action))
                                        .font(.system(size: 11, weight: .semibold))
                                        .frame(width: 96, alignment: .leading)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(s.target.isEmpty ? "—" : s.target)
                                            .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                                        if let err = s.error, !err.isEmpty {
                                            Text(String(err.prefix(120)))
                                                .font(.system(size: 9)).foregroundStyle(red500).lineLimit(2)
                                        }
                                    }
                                    Spacer(minLength: 4)
                                    Text(badge.label)
                                        .font(.system(size: 8, weight: .bold))
                                        .foregroundStyle(badge.color)
                                        .padding(.horizontal, 5).padding(.vertical, 2)
                                        .background(badge.color.opacity(0.10), in: Capsule())
                                    if let t = smClock(s.at) {
                                        Text(t).font(.system(size: 9).monospacedDigit()).foregroundStyle(.secondary)
                                    }
                                }
                                .padding(.vertical, 2)
                                if s.id != w.steps.last?.id { Divider().opacity(0.3) }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .smGlass(scheme)
                } else {
                    ProgressView("লোড হচ্ছে…")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 60)
                }
                Color.clear.frame(height: 40)
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)
        }
        .background(AlmaSwiftTheme.rootBg(scheme))
        .refreshable { await vm.refreshWatch() }
        .task {
            await vm.refreshWatch()
            // Web parity cadence: 2.5s while visible + foregrounded.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                if Task.isCancelled { break }
                guard scenePhase == .active else { continue }
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
                Task {
                    switch action {
                    case .stopBrowser: await vm.liveBrowser(stop: true)
                    case .resumeBrowser: await vm.liveBrowser(stop: false)
                    default: break
                    }
                }
            }
            Button("বাতিল", role: .cancel) {}
        } message: { action in
            Text(action.message)
        }
        .sheet(isPresented: $showViewer) {
            if let img = vm.watch?.screenshotImage {
                SMScreenshotViewer(image: img, at: vm.watch?.latestScreenshotAt)
            }
        }
    }
}
