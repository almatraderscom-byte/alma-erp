//
//  CreditUsageSwiftUI.swift
//  ALMA ERP — the redesigned agent cost dashboard as a native SwiftUI screen (v4).
//
//  Replaces the old AgentCostsScreen ("Monitor") with an Apple-grade two-pane page
//  (owner design 2026-07, market-researched against OpenRouter / Anthropic Console /
//  Vercel AI Gateway, and Apple's iOS 26 Liquid-Glass + spatial-layering HIG):
//
//    MATERIAL DISCIPLINE — glass floats, solid anchors data:
//      • Glass (.ultraThinMaterial + lit edge) → floating CONTROLS: the Usage/Logs
//        segment, the range switch, filter chips, the web-escape button, sheets.
//      • Solid (opaque surface) → dense DATA: the spend hero, the ledger, model
//        breakdown, provider wallet, budget — clean high-contrast, no translucency.
//
//    USAGE — big live spend hero with a 1D/7D/30D/Custom range switch and an
//      INTERACTIVE stacked daily bar chart: tap a bar to drill into that day (the
//      hero number + readout retarget, other bars dim). Provider credit wallet,
//      model breakdown, budget, avg-TTFT stat.
//    LOGS — ALMA ERP's end-to-end cost ledger grouped by Dhaka day; tap a row for
//      token intelligence (input / output / cached / TTFT / latency). 20s live refresh.
//
//  iOS effects: selection haptics (.sensoryFeedback), spring drill-down, numeric
//  count-up (.contentTransition), scroll-in transitions, pressable rows, a breathing
//  "today" endpoint, and animated live-row insertion.
//
//  Data (all live, owner-only, cookie-bridged via AlmaAPI):
//    GET /api/assistant/costs/summary · /balances · /logs.
//  Budget config is NATIVE (owner 2026-07-11: web saveBudget PUT parity). Only CSV
//  export/share + total reconciliation remain web (parity ledger AG-11, phase NP-4).
//  Parallel-session rule: page-owned material/aurora helpers (no cross-page imports).
//

import SwiftUI

// MARK: - Palette (exact web PROVIDER_COLORS)

private enum CUPalette {
    static let coral = Color(red: 0.878, green: 0.478, blue: 0.373)   // #E07A5F
    static let violet = Color(red: 0.655, green: 0.545, blue: 0.980)  // #A78BFA
    static let sage = Color(red: 0.506, green: 0.698, blue: 0.604)    // #81B29A
    static let gold = Color(red: 0.831, green: 0.659, blue: 0.294)    // #D4A84B
    static let goldLt = Color(red: 0.933, green: 0.706, blue: 0.561)  // #EEB48F
    static let emerald = Color(red: 0.239, green: 0.745, blue: 0.545) // #3DBE8B
    static let amber = Color(red: 0.878, green: 0.663, blue: 0.294)   // #E0A94B
    static let red = Color(red: 0.894, green: 0.459, blue: 0.420)     // #E4756B

    static func provider(_ id: String) -> Color {
        switch id {
        case "anthropic": return coral
        case "openai": return sage
        case "openrouter": return violet
        case "gemini": return Color(red: 0.231, green: 0.510, blue: 0.965)
        case "google_tts": return Color(red: 0.545, green: 0.361, blue: 0.965)
        case "twilio": return gold
        case "elevenlabs": return Color(red: 0.925, green: 0.282, blue: 0.600)
        case "veo": return Color(red: 0.055, green: 0.647, blue: 0.914)
        default: return Color(red: 0.580, green: 0.639, blue: 0.722)
        }
    }
    static let modelCycle: [Color] = [
        coral, sage, violet, Color(red: 0.231, green: 0.510, blue: 0.965), gold,
        Color(red: 0.925, green: 0.282, blue: 0.600), Color(red: 0.055, green: 0.647, blue: 0.914),
        Color(red: 0.063, green: 0.725, blue: 0.506), Color(red: 0.961, green: 0.620, blue: 0.043),
        Color(red: 0.388, green: 0.400, blue: 0.945),
    ]
    static func model(_ i: Int) -> Color { modelCycle[i % modelCycle.count] }
    static func accentText(_ s: ColorScheme) -> Color {
        s == .dark ? goldLt : Color(red: 0.706, green: 0.333, blue: 0.184)
    }
    static func balance(_ usd: Double?, free: Bool) -> Color {
        if free { return emerald }
        guard let usd else { return .secondary }
        if usd < 1 { return red }
        if usd < 5 { return amber }
        return emerald
    }
}

private enum CULabel {
    static func provider(_ id: String) -> String {
        switch id {
        case "anthropic": return "Anthropic"; case "openai": return "OpenAI"
        case "openrouter": return "OpenRouter"; case "gemini": return "Gemini"
        case "google_tts": return "Google TTS"; case "twilio": return "Twilio"
        case "elevenlabs": return "ElevenLabs"; case "veo": return "VEO 3"
        case "oxylabs": return "Oxylabs"; default: return id.isEmpty ? "অন্যান্য" : id
        }
    }
    static func icon(kind: String, provider: String) -> String {
        let k = kind.lowercased()
        if k.contains("image") || k.contains("nano") || k.contains("veo") { return "photo" }
        if k.contains("tts") || k.contains("speech_out") { return "speaker.wave.2.fill" }
        if k.contains("stt") || k.contains("whisper") || k.contains("transcri") { return "waveform" }
        if k.contains("call") || provider == "twilio" { return "phone.fill" }
        if k.contains("research") || k.contains("serp") || provider == "oxylabs" { return "magnifyingglass" }
        if k.contains("cs_") || k.contains("customer") { return "bubble.left.and.bubble.right.fill" }
        if k.contains("escalat") || k.contains("opus") { return "bolt.fill" }
        if k.contains("ops") || k.contains("tool") { return "terminal.fill" }
        return "sparkles"
    }
    static func roleTag(kind: String) -> String {
        let k = kind.lowercased()
        if k.contains("cs_") { return "cs" }
        if k.contains("image") { return "image" }
        if k.contains("tts") { return "voice" }
        if k.contains("stt") || k.contains("whisper") { return "voice" }
        if k.contains("call") { return "call" }
        if k.contains("research") { return "research" }
        if k.contains("escalat") { return "escalation" }
        if k.contains("ops") { return "ops" }
        if k.contains("chat") || k.contains("head") { return "head" }
        return kind.isEmpty ? "event" : String(kind.prefix(12))
    }
}

// MARK: - Flexible decode

private enum CUFlex {
    static func double<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
        return nil
    }
    static func int<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

// MARK: - Models

struct CUDay: Decodable, Identifiable, Equatable {
    let date: String
    let total: Double
    let providers: [String: Double]
    var id: String { date }

    private struct DynKey: CodingKey {
        var stringValue: String; var intValue: Int?
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { self.intValue = intValue; self.stringValue = String(intValue) }
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynKey.self)
        var date = ""; var total = 0.0; var prov: [String: Double] = [:]
        for key in c.allKeys {
            switch key.stringValue {
            case "date": date = (try? c.decode(String.self, forKey: key)) ?? ""
            case "total": total = CUFlex.double(c, key) ?? 0
            case "oxylabs": break
            default: if let v = CUFlex.double(c, key), v != 0 { prov[key.stringValue] = v }
            }
        }
        self.date = date; self.total = total; self.providers = prov
    }
    var plottedTotal: Double { providers.values.reduce(0, +) }
    var topProvider: String? { providers.max { $0.value < $1.value }?.key }
}

struct CUModelRow: Decodable, Identifiable, Equatable {
    let modelId: String, label: String, provider: String
    let monthUsd: Double, todayUsd: Double
    var id: String { modelId }
    private enum K: String, CodingKey { case modelId, label, provider, monthUsd, todayUsd }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        modelId = (try? c.decode(String.self, forKey: .modelId)) ?? ""
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? modelId
        provider = (try? c.decodeIfPresent(String.self, forKey: .provider)) ?? ""
        monthUsd = CUFlex.double(c, .monthUsd) ?? 0
        todayUsd = CUFlex.double(c, .todayUsd) ?? 0
    }
}

struct CUProviderRow: Decodable, Identifiable, Equatable {
    let provider: String, totalUsd: Double
    var id: String { provider }
    private enum K: String, CodingKey { case provider, totalUsd }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        provider = (try? c.decode(String.self, forKey: .provider)) ?? ""
        totalUsd = CUFlex.double(c, .totalUsd) ?? 0
    }
}

struct CUBudgets: Decodable, Equatable {
    let dailyUsd: Double?, monthlyUsd: Double?
    private enum K: String, CodingKey { case dailyUsd, monthlyUsd }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        dailyUsd = CUFlex.double(c, .dailyUsd); monthlyUsd = CUFlex.double(c, .monthlyUsd)
    }
    init() { dailyUsd = nil; monthlyUsd = nil }
}

struct CUSummary: Decodable {
    let todayDhakaDate: String?
    let todayUsd: Double, monthUsd: Double, forecastUsd: Double
    let subscriptionAmortMonthUsd: Double?
    let dailyLast30: [CUDay]
    let byProvider: [CUProviderRow]
    let byModel: [CUModelRow]
    let budgets: CUBudgets
    let dailyBudgetPct: Double?, monthlyBudgetPct: Double?

    private enum K: String, CodingKey {
        case todayDhakaDate, todayUsd, monthUsd, forecastUsd, subscriptionAmortMonthUsd
        case dailyLast30, byProvider, byModel, budgets, dailyBudgetPct, monthlyBudgetPct
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        todayDhakaDate = try? c.decodeIfPresent(String.self, forKey: .todayDhakaDate)
        todayUsd = CUFlex.double(c, .todayUsd) ?? 0
        monthUsd = CUFlex.double(c, .monthUsd) ?? 0
        forecastUsd = CUFlex.double(c, .forecastUsd) ?? 0
        subscriptionAmortMonthUsd = CUFlex.double(c, .subscriptionAmortMonthUsd)
        dailyLast30 = (try? c.decodeIfPresent([CUDay].self, forKey: .dailyLast30)) ?? []
        byProvider = (try? c.decodeIfPresent([CUProviderRow].self, forKey: .byProvider)) ?? []
        byModel = (try? c.decodeIfPresent([CUModelRow].self, forKey: .byModel)) ?? []
        budgets = (try? c.decodeIfPresent(CUBudgets.self, forKey: .budgets)) ?? CUBudgets()
        dailyBudgetPct = CUFlex.double(c, .dailyBudgetPct)
        monthlyBudgetPct = CUFlex.double(c, .monthlyBudgetPct)
    }
}

struct CUBalanceRow: Decodable, Identifiable, Equatable {
    let id: String, label: String
    let balanceUsd: Double?, todayUsd: Double?, monthUsd: Double?
    let free: Bool
    private enum K: String, CodingKey { case id, label, balanceUsd, todayUsd, monthUsd, free }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? id
        balanceUsd = CUFlex.double(c, .balanceUsd)
        todayUsd = CUFlex.double(c, .todayUsd)
        monthUsd = CUFlex.double(c, .monthUsd)
        free = (try? c.decodeIfPresent(Bool.self, forKey: .free)) ?? false
    }
}
struct CUBalances: Decodable {
    let providers: [CUBalanceRow]
    private enum K: String, CodingKey { case providers }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        providers = (try? c.decodeIfPresent([CUBalanceRow].self, forKey: .providers)) ?? []
    }
}

/// Loosely-typed JSON for the raw `units` payload — the detail sheet shows every
/// stored DB field verbatim (owner rule: raw truth, never fabricate a field).
enum CUJSON: Decodable, Equatable {
    case string(String), number(Double), bool(Bool), null
    indirect case array([CUJSON])
    indirect case object([String: CUJSON])

    init(from d: Decoder) throws {
        let c = try d.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([CUJSON].self) { self = .array(a) }
        else if let o = try? c.decode([String: CUJSON].self) { self = .object(o) }
        else { self = .null }
    }
    var display: String {
        switch self {
        case .string(let s): return s
        case .number(let n):
            return (n == n.rounded() && abs(n) < 1e15) ? String(Int64(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        case .array(let a): return "[" + a.map(\.display).joined(separator: ", ") + "]"
        case .object(let o):
            return "{" + o.keys.sorted().map { "\($0): \(o[$0]?.display ?? "null")" }.joined(separator: ", ") + "}"
        }
    }
}

/// One usage-log event from /api/assistant/usage-logs — normalized convenience
/// fields + the FULL raw `units` JSON as stored in agent_cost_events.
struct CUUsageEvent: Decodable, Identifiable, Equatable {
    let id: String
    let occurredAt: String
    let provider: String
    let kind: String
    let kindLabel: String?
    let modelId: String?
    let model: String?
    let taskLabel: String?
    let costUsd: Double
    let inputTokens: Int?
    let outputTokens: Int?
    let cacheReadTokens: Int?
    let cacheWriteTokens: Int?
    let ok: Bool?
    let conversationId: String?
    let jobId: String?
    let units: [String: CUJSON]

    private enum K: String, CodingKey {
        case id, occurredAt, provider, kind, kindLabel, modelId, model, taskLabel, costUsd
        case inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, ok
        case conversationId, jobId, units
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        occurredAt = (try? c.decodeIfPresent(String.self, forKey: .occurredAt)) ?? ""
        provider = (try? c.decodeIfPresent(String.self, forKey: .provider)) ?? ""
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
        kindLabel = try? c.decodeIfPresent(String.self, forKey: .kindLabel)
        modelId = try? c.decodeIfPresent(String.self, forKey: .modelId)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        taskLabel = try? c.decodeIfPresent(String.self, forKey: .taskLabel)
        costUsd = CUFlex.double(c, .costUsd) ?? 0
        inputTokens = CUFlex.int(c, .inputTokens)
        outputTokens = CUFlex.int(c, .outputTokens)
        cacheReadTokens = CUFlex.int(c, .cacheReadTokens)
        cacheWriteTokens = CUFlex.int(c, .cacheWriteTokens)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        conversationId = try? c.decodeIfPresent(String.self, forKey: .conversationId)
        jobId = try? c.decodeIfPresent(String.self, forKey: .jobId)
        units = (try? c.decodeIfPresent([String: CUJSON].self, forKey: .units)) ?? [:]
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? "\(provider)-\(occurredAt)-\(kind)"
    }

    /// Short display model: drop any vendor prefix ("deepseek/deepseek-chat" → tail).
    var shortModel: String {
        let raw = modelId ?? model ?? ""
        guard !raw.isEmpty else { return CULabel.provider(provider) }
        if let slash = raw.lastIndex(of: "/"), slash != raw.indices.last { return String(raw[raw.index(after: slash)...]) }
        return raw
    }
}

struct CUUsageBucket: Decodable, Equatable {
    let start: String
    let calls: Int
    let costUsd: Double
    private enum K: String, CodingKey { case start, calls, costUsd }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        start = (try? c.decodeIfPresent(String.self, forKey: .start)) ?? ""
        calls = CUFlex.int(c, .calls) ?? 0
        costUsd = CUFlex.double(c, .costUsd) ?? 0
    }
}

struct CUUsagePage: Decodable {
    let events: [CUUsageEvent]
    let nextCursor: String?
    let buckets: [CUUsageBucket]?
    let totalCalls: Int?
    let totalCostUsd: Double?
    private enum K: String, CodingKey { case events, nextCursor, buckets, totalCalls, totalCostUsd }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        events = (try? c.decodeIfPresent([CUUsageEvent].self, forKey: .events)) ?? []
        nextCursor = try? c.decodeIfPresent(String.self, forKey: .nextCursor)
        buckets = try? c.decodeIfPresent([CUUsageBucket].self, forKey: .buckets)
        totalCalls = CUFlex.int(c, .totalCalls)
        totalCostUsd = CUFlex.double(c, .totalCostUsd)
    }
}

// MARK: - Range

enum CURange: String, CaseIterable, Identifiable {
    case d1 = "1D", d7 = "7D", d30 = "30D", custom = "Custom"
    var id: String { rawValue }
    var unitIsHour: Bool { self == .d1 }
}

/// OpenRouter-spirit time ranges for the Logs explorer. Presets slide with "now";
/// shortcuts anchor on the Dhaka calendar (same convention as the web cost APIs).
enum CULogRange: String, CaseIterable, Identifiable, Equatable {
    case m15, m30, h1, h3, d1, d2, w1, mo1
    case today, yesterday, thisWeek, thisMonth
    case custom

    var id: String { rawValue }
    static let presets: [CULogRange] = [.m15, .m30, .h1, .h3, .d1, .d2, .w1, .mo1]
    static let shortcuts: [CULogRange] = [.today, .yesterday, .thisWeek, .thisMonth]

    var label: String {
        switch self {
        case .m15: return "Past 15m"
        case .m30: return "Past 30m"
        case .h1: return "Past 1h"
        case .h3: return "Past 3h"
        case .d1: return "Past 1d"
        case .d2: return "Past 2d"
        case .w1: return "Past 1w"
        case .mo1: return "Past 1mo"
        case .today: return "Today"
        case .yesterday: return "Yesterday"
        case .thisWeek: return "This Week"
        case .thisMonth: return "This Month"
        case .custom: return "Custom"
        }
    }

    /// Resolve to a concrete [from, to] window at call time.
    func window(customFrom: Date, customTo: Date) -> (from: Date, to: Date) {
        let now = Date()
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        switch self {
        case .m15: return (now.addingTimeInterval(-15 * 60), now)
        case .m30: return (now.addingTimeInterval(-30 * 60), now)
        case .h1: return (now.addingTimeInterval(-3600), now)
        case .h3: return (now.addingTimeInterval(-3 * 3600), now)
        case .d1: return (now.addingTimeInterval(-86_400), now)
        case .d2: return (now.addingTimeInterval(-2 * 86_400), now)
        case .w1: return (now.addingTimeInterval(-7 * 86_400), now)
        case .mo1: return (cal.date(byAdding: .month, value: -1, to: now) ?? now.addingTimeInterval(-30 * 86_400), now)
        case .today: return (cal.startOfDay(for: now), now)
        case .yesterday:
            let sod = cal.startOfDay(for: now)
            return (cal.date(byAdding: .day, value: -1, to: sod) ?? sod.addingTimeInterval(-86_400), sod)
        case .thisWeek:
            return (cal.dateInterval(of: .weekOfYear, for: now)?.start ?? cal.startOfDay(for: now), now)
        case .thisMonth:
            return (cal.dateInterval(of: .month, for: now)?.start ?? cal.startOfDay(for: now), now)
        case .custom:
            let lo = min(customFrom, customTo), hi = max(customFrom, customTo)
            return (lo, hi)
        }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class CreditUsageVM {
    var summary: CUSummary? = nil
    var balances: CUBalances? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    var range: CURange = .d30
    var customFrom = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date()
    var customTo = Date()

    // ── Logs explorer (OpenRouter-style) ──
    var logRange: CULogRange = .h1   // owner default: open on Past 1 hour, never huge
    var logCustomFrom = Calendar.current.date(byAdding: .day, value: -1, to: Date()) ?? Date()
    var logCustomTo = Date()
    var live = false
    var logFilter: String = "সব"
    var usageEvents: [CUUsageEvent] = []
    var buckets: [CUUsageBucket] = []
    var totalCalls: Int? = nil
    var totalCostUsd: Double? = nil
    var nextCursor: String? = nil
    var logsLoading = false
    var loadingMore = false
    var logsError: String? = nil
    var windowFrom = Date().addingTimeInterval(-3600)
    var windowTo = Date()

    func load() async {
        loading = true; error = nil; defer { loading = false }
        do {
            summary = try await AlmaAPI.shared.get("/api/assistant/costs/summary")
            authExpired = false
            if let b: CUBalances = try? await AlmaAPI.shared.get("/api/assistant/costs/balances") { balances = b }
            await loadUsageLogs()
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }
            self.error = error.localizedDescription
        }
    }

    /// Native budget config (owner 2026-07-11) — web saveBudget: PUT
    /// /api/assistant/costs/budget {dailyUsd, monthlyUsd} (null clears).
    func saveBudget(daily: Double?, monthly: Double?) async {
        struct Body: Encodable { let dailyUsd: Double?, monthlyUsd: Double? }
        struct Resp: Decodable { let ok: Bool? }
        do {
            let _: Resp = try await AlmaAPI.shared.send(
                "PUT", "/api/assistant/costs/budget",
                body: Body(dailyUsd: daily, monthlyUsd: monthly))
            await load()
        } catch {
            self.error = "বাজেট সংরক্ষণ ব্যর্থ"
        }
    }

    /// Web's manual "refresh balances" — POST forces the provider fetch, returns the
    /// fresh cache (the 20s auto-poll only reads the cache). S8 audit fix.
    var balancesRefreshing = false
    func refreshBalances() async {
        guard !balancesRefreshing else { return }
        balancesRefreshing = true; defer { balancesRefreshing = false }
        if let b: CUBalances = try? await AlmaAPI.shared.send("POST", "/api/assistant/costs/balances") {
            balances = b
        }
    }

    /// First page (reset) or next page (reset: false) of the range-filtered log.
    /// Load-more keeps the SAME window the first page resolved, so keyset
    /// pagination stays consistent while "Past X" ranges slide with the clock.
    func loadUsageLogs(reset: Bool = true) async {
        if reset { logsLoading = true } else {
            guard nextCursor != nil, !loadingMore else { return }
            loadingMore = true
        }
        logsError = nil
        defer { logsLoading = false; loadingMore = false }
        if reset {
            let w = logRange.window(customFrom: logCustomFrom, customTo: logCustomTo)
            windowFrom = w.from; windowTo = w.to
        }
        var q: [String: String?] = [
            "from": CUFormat.isoString(windowFrom),
            "to": CUFormat.isoString(windowTo),
            "limit": "100",
        ]
        if !reset { q["cursor"] = nextCursor }
        do {
            let page: CUUsagePage = try await AlmaAPI.shared.get("/api/assistant/usage-logs", query: q)
            if reset {
                usageEvents = page.events
                buckets = page.buckets ?? []
                totalCalls = page.totalCalls
                totalCostUsd = page.totalCostUsd
            } else {
                let known = Set(usageEvents.map(\.id))
                usageEvents += page.events.filter { !known.contains($0.id) }
            }
            nextCursor = page.nextCursor
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch AlmaAPIError.http(let status, _) where status == 404 {
            // The usage-logs route isn't on the production deploy yet (it ships with
            // the web-side merge). Show a calm Bangla notice, never the raw HTML body.
            logsError = "লগ ফিড এখনো সার্ভারে লাইভ হয়নি — ওয়েব আপডেট ডিপ্লয় হলে এখানে দেখা যাবে।"
        } catch {
            if Self.isCancellation(error) { return }
            logsError = error.localizedDescription
        }
    }
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    var visibleDays: [CUDay] {
        guard let all = summary?.dailyLast30, !all.isEmpty else { return [] }
        switch range {
        case .d1: return Array(all.suffix(1))
        case .d7: return Array(all.suffix(7))
        case .d30: return all
        case .custom:
            let f = CUFormat.ymd(customFrom), t = CUFormat.ymd(customTo)
            let lo = min(f, t), hi = max(f, t)
            return all.filter { $0.date >= lo && $0.date <= hi }
        }
    }
    var rangeTotal: Double { visibleDays.reduce(0) { $0 + $1.plottedTotal } }
    var avgPerDay: Double { rangeTotal / Double(max(visibleDays.count, 1)) }
    var rangeByProvider: [(String, Double)] {
        var acc: [String: Double] = [:]
        for d in visibleDays { for (k, v) in d.providers { acc[k, default: 0] += v } }
        return acc.sorted { $0.value > $1.value }
    }
    var stackOrder: [String] { rangeByProvider.map(\.0) }

    var filteredUsageEvents: [CUUsageEvent] {
        guard logFilter != "সব" else { return usageEvents }
        return usageEvents.filter { e in
            switch logFilter {
            case "Gemini": return e.provider == "gemini"
            case "Anthropic": return e.provider == "anthropic"
            case "OpenRouter": return e.provider == "openrouter"
            case "Voice": return e.provider == "google_tts" || ["tts", "stt", "whisper"].contains { e.kind.lowercased().contains($0) }
            case "Image": return e.kind.lowercased().contains("image")
            case "ব্যর্থ": return e.ok == false
            default: return true
            }
        }
    }
    /// > 1 day window → log rows show the date next to HH:mm:ss.
    var windowSpansDays: Bool { windowTo.timeIntervalSince(windowFrom) > 86_460 }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct CreditUsageScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm = CreditUsageVM()
    @State private var pane = 0
    @State private var selectedBar: Int? = nil
    @State private var showCustomSheet = false
    @State private var showLogCustomSheet = false
    @State private var detailEvent: CUUsageEvent? = nil
    @State private var editingBudget = false
    @State private var budgetDailyDraft = ""
    @State private var budgetMonthlyDraft = ""
    @State private var csvExporting = false   // NP-4 (AG-11) native CSV export
    let openWeb: (_ path: String, _ title: String) -> Void

    /// Live mode: ~10s auto-refresh of the first log page while ON (green dot pulses).
    private let liveTimer = Timer.publish(every: 10, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                paneSwitch
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.summary == nil { loadingRows }
                if pane == 0 { usagePane } else { logsPane }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14).padding(.top, 6)
        }
        .background(CUAurora())
        .claudeTopFade()
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .onReceive(liveTimer) { _ in
            guard pane == 1, vm.live, !vm.logsLoading, !vm.loadingMore else { return }
            Task { await vm.loadUsageLogs() }
        }
        .sheet(isPresented: $showCustomSheet) { customSheet }
        .sheet(isPresented: $showLogCustomSheet) { logCustomSheet }
        .sheet(item: $detailEvent) { e in logDetailSheet(e) }
        .sensoryFeedback(.selection, trigger: pane)
        .sensoryFeedback(.selection, trigger: vm.range)
        .sensoryFeedback(.impact(weight: .light), trigger: selectedBar)
        .sensoryFeedback(.selection, trigger: vm.logFilter)
        .sensoryFeedback(.selection, trigger: vm.logRange)
        .sensoryFeedback(.selection, trigger: vm.live)
    }

    private var paneSwitch: some View {
        CUSegment(items: ["Usage", "Logs"], selection: $pane, scheme: scheme)
            .padding(.bottom, 2)
    }

    // ═══════════════ USAGE ═══════════════

    @ViewBuilder private var usagePane: some View {
        if let s = vm.summary {
            spendHero(s).cuAppear(0)
            if let b = vm.balances, !b.providers.isEmpty { walletRow(b).cuAppear(1) }
            statTrio(s).cuAppear(2)
            if !s.byModel.isEmpty { modelBreakdown(s).cuAppear(3) }
            if let bud = budgetCard(s) { bud.cuAppear(4) }
        }
    }

    private func spendHero(_ s: CUSummary) -> some View {
        let sel = selectedBar.flatMap { i in vm.visibleDays.indices.contains(i) ? vm.visibleDays[i] : nil }
        let shown = sel?.plottedTotal ?? (vm.range == .d1 ? s.todayUsd : vm.rangeTotal)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                Text("এই সময়ের খরচ · CREDIT USAGE")
                    .font(.system(size: 10, weight: .bold)).textCase(.uppercase).kerning(0.6).foregroundStyle(.secondary)
                Spacer()
                rangePicker
            }
            Text(CUFormat.usd(shown))
                .font(.system(size: 44, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(CUPalette.accentText(scheme))
                .lineLimit(1).minimumScaleFactor(0.5)
                .padding(.top, 10).padding(.bottom, 4)
                .contentTransition(.numericText())
                .animation(.spring(duration: 0.4), value: shown)
            if let sel {
                HStack(spacing: 7) {
                    Circle().fill(CUPalette.provider(sel.topProvider ?? "")).frame(width: 6, height: 6)
                    Text("\(CUFormat.dayLabel(sel.date)) · \(CULabel.provider(sel.topProvider ?? "")) শীর্ষে")
                }
                .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(CUPalette.accentText(scheme))
                .transition(.opacity)
            } else {
                Text(deltaLine(s)).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
            }
            if vm.range == .custom {
                Button { showCustomSheet = true } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "calendar").foregroundStyle(CUPalette.coral)
                        Text("\(CUFormat.pretty(vm.customFrom)) – \(CUFormat.pretty(vm.customTo))").font(.system(size: 12, weight: .semibold))
                        Image(systemName: "chevron.down").font(.system(size: 9)).foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 13).padding(.vertical, 9).cuGlass(scheme, corner: AlmaSwiftTheme.rControl)
                }
                .buttonStyle(CUPress()).padding(.top, 12)
            }
            chart(s)
            legend
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18).cuRaised(scheme, corner: AlmaSwiftTheme.rCard)
    }

    private func deltaLine(_ s: CUSummary) -> String {
        switch vm.range {
        case .d1: return "আজকের খরচ · একটি bar-এ ট্যাপ করুন →"
        case .custom: return "\(vm.visibleDays.count) দিন · গড় \(CUFormat.usd(vm.avgPerDay))/দিন"
        default: return "পূর্বাভাস ~\(CUFormat.usd(s.forecastUsd)) · গড় \(CUFormat.usd(vm.avgPerDay))/দিন · ট্যাপ →"
        }
    }

    private var rangePicker: some View {
        HStack(spacing: 1) {
            ForEach(CURange.allCases) { r in
                Button {
                    withAnimation(.spring(duration: 0.35)) { vm.range = r; selectedBar = nil }
                    if r == .custom { showCustomSheet = true }
                } label: {
                    Text(r.rawValue).font(.system(size: 11, weight: .bold))
                        .foregroundStyle(vm.range == r ? Color.primary : .secondary)
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background {
                            if vm.range == r {
                                RoundedRectangle(cornerRadius: 7).fill(.ultraThinMaterial)
                                    .overlay(RoundedRectangle(cornerRadius: 7).fill(.white.opacity(scheme == .dark ? 0.12 : 0.5)))
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2).cuGlass(scheme, corner: 10)
    }

    // Interactive stacked daily chart with tap-to-drill.
    private func chart(_ s: CUSummary) -> some View {
        let days = vm.visibleDays
        let maxT = max(days.map(\.plottedTotal).max() ?? 0, 0.0001)
        let order = vm.stackOrder
        return VStack(spacing: 8) {
            ZStack(alignment: .bottom) {
                VStack(spacing: 0) { ForEach(0..<4, id: \.self) { _ in
                    Rectangle().fill(Color.primary.opacity(0.05)).frame(height: 1); Spacer() } }
                    .frame(height: 118)
                HStack(alignment: .bottom, spacing: days.count > 20 ? 2 : 3) {
                    if days.isEmpty {
                        Text("এখনো কোনো খরচ নেই").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                    } else {
                        ForEach(Array(days.enumerated()), id: \.element.id) { idx, d in
                            column(d, order: order, maxT: maxT, idx: idx, isLast: idx == days.count - 1)
                        }
                    }
                }
                .frame(height: 118)
            }
            .frame(height: 118)
            if let first = days.first, let last = days.last {
                HStack {
                    Text(CUFormat.axis(first.date)); Spacer(); Text(vm.range == .d1 ? "এখন" : CUFormat.axis(last.date))
                }
                .font(.system(size: 9)).foregroundStyle(.tertiary)
            }
        }
        .padding(.top, 18)
    }

    private func column(_ d: CUDay, order: [String], maxT: Double, idx: Int, isLast: Bool) -> some View {
        let h = max(CGFloat(d.plottedTotal / maxT) * 118, d.plottedTotal > 0 ? 3 : 1)
        let dimmed = selectedBar != nil && selectedBar != idx
        return VStack(spacing: 1.5) {
            ForEach(order.reversed(), id: \.self) { p in
                let v = d.providers[p] ?? 0
                if v > 0 {
                    Rectangle().fill(CUPalette.provider(p))
                        .frame(height: max(h * CGFloat(v / max(d.plottedTotal, 0.0001)), 1.5))
                        .brightness(selectedBar == idx ? 0.12 : 0)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: h, alignment: .bottom)
        .clipShape(RoundedRectangle(cornerRadius: 2.5))
        .opacity(dimmed ? 0.32 : 1)
        .overlay(alignment: .top) {
            if isLast && selectedBar == nil {
                Circle().fill(CUPalette.goldLt).frame(width: 5, height: 5)
                    .offset(y: -9).modifier(CUPulse())
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.spring(duration: 0.3)) { selectedBar = (selectedBar == idx ? nil : idx) }
        }
        .animation(.easeOut(duration: 0.2), value: dimmed)
    }

    private var legend: some View {
        let grand = max(vm.rangeTotal, 0.0001)
        return CUFlow(spacing: 14, lineSpacing: 8) {
            ForEach(Array(vm.rangeByProvider.prefix(6)), id: \.0) { p, v in
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2).fill(CUPalette.provider(p)).frame(width: 8, height: 8)
                    Text(CULabel.provider(p)).font(.system(size: 11, weight: .semibold))
                    Text(CUFormat.usd(v * vm.rangeTotal / grand))
                        .font(.system(size: 11, weight: .bold).monospacedDigit()).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.top, 14).overlay(alignment: .top) { Divider().opacity(0.5) }
    }

    private func walletRow(_ b: CUBalances) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Provider ক্রেডিট").font(.system(size: 13, weight: .bold)); Spacer()
                Button {
                    Task { await vm.refreshBalances() }
                } label: {
                    if vm.balancesRefreshing {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain).disabled(vm.balancesRefreshing)
                Text("← swipe").font(.system(size: 10.5)).foregroundStyle(.tertiary)
            }.padding(.horizontal, 3)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 11) { ForEach(b.providers) { walletCard($0) } }.padding(.horizontal, 1)
            }
        }
    }
    private func walletCard(_ row: CUBalanceRow) -> some View {
        let tint = CUPalette.provider(row.id)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(String(row.label.prefix(1))).font(.system(size: 12, weight: .bold, design: .rounded))
                    .frame(width: 24, height: 24).background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: 7)).foregroundStyle(tint)
                Text(row.label).font(.system(size: 12.5, weight: .bold)).lineLimit(1)
                Spacer(minLength: 4)
                Text(row.free ? "FREE" : "LIVE").font(.system(size: 8, weight: .heavy)).kerning(0.5)
                    .padding(.horizontal, 6).padding(.vertical, 2).background(Color.primary.opacity(0.08), in: Capsule()).foregroundStyle(.secondary)
            }
            Text(row.free ? "Free" : (row.balanceUsd.map { CUFormat.usd($0) } ?? "—"))
                .font(.system(size: 22, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(CUPalette.balance(row.balanceUsd, free: row.free)).padding(.top, 13)
            Text("আজ \(CUFormat.usd(row.todayUsd ?? 0)) · মাস \(CUFormat.usd(row.monthUsd ?? 0))")
                .font(.system(size: 9.5).monospacedDigit()).foregroundStyle(.secondary).padding(.top, 3)
        }
        .padding(14).frame(width: 158, alignment: .leading).cuSolid(scheme, corner: 17)
        .overlay(alignment: .top) { RoundedRectangle(cornerRadius: 2).fill(tint).frame(height: 2.5).padding(.horizontal, 14) }
    }

    private func statTrio(_ s: CUSummary) -> some View {
        HStack(spacing: 9) {
            statPill("আজ খরচ", CUFormat.usd(s.todayUsd))
            statPill("এই মাস", CUFormat.usd(s.monthUsd))
            statPill("পূর্বাভাস", CUFormat.usd(s.forecastUsd))
        }
    }
    private func statPill(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(k).font(.system(size: 9)).foregroundStyle(.secondary)
            Text(v).font(.system(size: 17, weight: .bold, design: .rounded).monospacedDigit()).lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(12).cuSolid(scheme, corner: 15)
    }

    private func modelBreakdown(_ s: CUSummary) -> some View {
        let maxMonth = max(s.byModel.map(\.monthUsd).max() ?? 0, 0.0001)
        return VStack(alignment: .leading, spacing: 10) {
            HStack { Text("মডেল অনুযায়ী খরচ").font(.system(size: 13, weight: .bold)); Spacer()
                Text("এই মাস").font(.system(size: 11)).foregroundStyle(.secondary) }
            ForEach(Array(s.byModel.prefix(8).enumerated()), id: \.element.id) { idx, m in
                let tint = CUPalette.model(idx)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 7) {
                        Circle().fill(tint).frame(width: 8, height: 8)
                        Text(m.label).font(.system(size: 12.5, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.8)
                        Spacer()
                        Text(CUFormat.usd(m.monthUsd)).font(.system(size: 12.5, weight: .bold, design: .rounded).monospacedDigit())
                        Text("আজ \(CUFormat.usd(m.todayUsd))").font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.primary.opacity(0.06))
                            Capsule().fill(tint).frame(width: max(geo.size.width * m.monthUsd / maxMonth, m.monthUsd > 0 ? 4 : 0))
                        }
                    }.frame(height: 6)
                }
                .padding(.vertical, 3)
                if idx < min(s.byModel.count, 8) - 1 { Divider().opacity(0.4) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(16).cuSolid(scheme, corner: 18)
    }

    private func budgetCard(_ s: CUSummary) -> AnyView? {
        let hasDaily = s.dailyBudgetPct != nil && s.budgets.dailyUsd != nil
        let hasMonthly = s.monthlyBudgetPct != nil && s.budgets.monthlyUsd != nil
        return AnyView(
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("রিমেইনিং বাজেট").font(.system(size: 10, weight: .bold)).textCase(.uppercase).kerning(0.5).foregroundStyle(.secondary)
                    Spacer()
                    // Native budget config (owner 2026-07-11) — web saveBudget PUT parity.
                    Button {
                        budgetDailyDraft = s.budgets.dailyUsd.map { String(format: "%.2f", $0) } ?? ""
                        budgetMonthlyDraft = s.budgets.monthlyUsd.map { String(format: "%.2f", $0) } ?? ""
                        editingBudget = true
                    } label: {
                        Image(systemName: "slider.horizontal.3").font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
                if hasMonthly, let pct = s.monthlyBudgetPct, let cap = s.budgets.monthlyUsd { budgetRow(spent: s.monthUsd, cap: cap, pct: pct, label: "এই মাস") }
                if hasDaily, let pct = s.dailyBudgetPct, let cap = s.budgets.dailyUsd { budgetRow(spent: s.todayUsd, cap: cap, pct: pct, label: "আজ") }
                if !hasDaily && !hasMonthly {
                    Text("বাজেট সেট করা নেই — উপরের বোতামে সেট করুন")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(16).cuSolid(scheme, corner: 18)
            .alert("Budget (USD)", isPresented: $editingBudget) {
                TextField("Daily USD (খালি = নেই)", text: $budgetDailyDraft)
                    .keyboardType(.decimalPad)
                TextField("Monthly USD (খালি = নেই)", text: $budgetMonthlyDraft)
                    .keyboardType(.decimalPad)
                Button("Save") {
                    Task {
                        await vm.saveBudget(
                            daily: Double(budgetDailyDraft),
                            monthly: Double(budgetMonthlyDraft))
                    }
                }
                Button("বাতিল", role: .cancel) {}
            })
    }
    private func budgetRow(spent: Double, cap: Double, pct: Double, label: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(label) · \(CUFormat.usd(max(cap - spent, 0))) বাকি").font(.system(size: 12, weight: .semibold)); Spacer()
                Text("\(Int(pct.rounded()))%").font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundStyle(pct >= 100 ? CUPalette.red : pct >= 80 ? CUPalette.amber : CUPalette.accentText(scheme))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.07))
                    Capsule().fill(LinearGradient(colors: [CUPalette.coral, CUPalette.gold], startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(geo.size.width * min(pct, 100) / 100, 4))
                }
            }.frame(height: 8).animation(.spring(duration: 0.5), value: pct)
        }
    }

    // ═══════════════ LOGS ═══════════════

    private var logsPane: some View {
        VStack(spacing: 12) {
            logRangeBar.cuAppear(0)
            activityCard.cuAppear(1)
            filterChips.cuAppear(2)
            if let err = vm.logsError { errorCard(err) }
            if vm.logsLoading && vm.usageEvents.isEmpty {
                loadingRows
            } else if vm.filteredUsageEvents.isEmpty {
                Text("এই রেঞ্জে কোনো ইভেন্ট নেই").font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 30)
            } else {
                VStack(spacing: 0) {
                    ForEach(vm.filteredUsageEvents) { e in usageRow(e) }
                }
                .cuSolid(scheme, corner: 18).cuAppear(3)
            }
            if vm.nextCursor != nil && !vm.logsLoading { loadMoreButton }
        }
    }

    // ── Range picker (OpenRouter-style) + Live ──

    private var logRangeBar: some View {
        HStack(spacing: 8) {
            Menu {
                Section("Past") {
                    ForEach(CULogRange.presets) { r in rangeMenuButton(r) }
                }
                Section {
                    ForEach(CULogRange.shortcuts) { r in rangeMenuButton(r) }
                }
                Divider()
                Button { showLogCustomSheet = true } label: {
                    Label("Custom range…", systemImage: "calendar")
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "clock").font(.system(size: 11, weight: .semibold)).foregroundStyle(CUPalette.coral)
                    Text(rangeChipLabel).font(.system(size: 12, weight: .bold)).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 13).padding(.vertical, 9).cuGlass(scheme, corner: AlmaSwiftTheme.rControl)
            }
            .buttonStyle(CUPress())
            Spacer(minLength: 8)
            liveChip
        }
    }

    private func rangeMenuButton(_ r: CULogRange) -> some View {
        Button {
            vm.logRange = r
            Task { await vm.loadUsageLogs() }
        } label: {
            if vm.logRange == r { Label(r.label, systemImage: "checkmark") } else { Text(r.label) }
        }
    }

    private var rangeChipLabel: String {
        vm.logRange == .custom
            ? "\(CUFormat.prettyDT(vm.logCustomFrom)) – \(CUFormat.prettyDT(vm.logCustomTo))"
            : vm.logRange.label
    }

    private var liveChip: some View {
        Button {
            withAnimation(.easeOut(duration: 0.2)) { vm.live.toggle() }
            if vm.live { Task { await vm.loadUsageLogs() } }
        } label: {
            HStack(spacing: 6) {
                CULiveDot(on: vm.live)
                Text("Live").font(.system(size: 12, weight: .bold))
                    .foregroundStyle(vm.live ? CUPalette.emerald : .secondary)
            }
            .padding(.horizontal, 13).padding(.vertical, 9)
            .cuGlass(scheme, corner: AlmaSwiftTheme.rControl)
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(vm.live ? CUPalette.emerald.opacity(0.55) : Color.clear, lineWidth: 1))
        }
        .buttonStyle(CUPress())
    }

    // ── Activity mini-chart (calls per bucket over the selected range) ──

    private var activityCard: some View {
        let maxCalls = max(vm.buckets.map(\.calls).max() ?? 0, 1)
        let spansDays = vm.windowSpansDays
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(vm.totalCalls ?? vm.usageEvents.count)")
                    .font(.system(size: 20, weight: .bold, design: .rounded).monospacedDigit())
                    .contentTransition(.numericText())
                Text("কল · এই রেঞ্জে").font(.system(size: 10.5)).foregroundStyle(.secondary)
                Spacer()
                Text(CUFormat.usd(vm.totalCostUsd ?? 0))
                    .font(.system(size: 15, weight: .bold, design: .rounded).monospacedDigit())
                    .foregroundStyle(CUPalette.accentText(scheme))
                    .contentTransition(.numericText())
            }
            .animation(.spring(duration: 0.4), value: vm.totalCalls)
            if vm.buckets.isEmpty {
                Text(vm.logsLoading ? "লোড হচ্ছে…" : "এই রেঞ্জে কোনো কল নেই")
                    .font(.system(size: 10.5)).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, minHeight: 44)
            } else {
                HStack(alignment: .bottom, spacing: vm.buckets.count > 40 ? 1.5 : 2.5) {
                    ForEach(Array(vm.buckets.enumerated()), id: \.offset) { _, b in
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(b.calls > 0
                                  ? AnyShapeStyle(LinearGradient(colors: [CUPalette.coral, CUPalette.gold], startPoint: .bottom, endPoint: .top))
                                  : AnyShapeStyle(Color.primary.opacity(0.06)))
                            .frame(height: b.calls > 0 ? max(CGFloat(b.calls) / CGFloat(maxCalls) * 44, 3) : 2)
                            .frame(maxWidth: .infinity)
                    }
                }
                .frame(height: 44, alignment: .bottom)
            }
            HStack {
                Text(CUFormat.windowAxis(vm.windowFrom, spansDays: spansDays))
                Spacer()
                Text(CUFormat.windowAxis(vm.windowTo, spansDays: spansDays))
            }
            .font(.system(size: 9).monospacedDigit()).foregroundStyle(.tertiary)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading).cuSolid(scheme, corner: 18)
    }

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(["সব", "Gemini", "Anthropic", "OpenRouter", "Voice", "Image", "ব্যর্থ"], id: \.self) { f in
                    let on = vm.logFilter == f
                    Button { withAnimation(.easeOut(duration: 0.2)) { vm.logFilter = f } } label: {
                        Text(f).font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(on ? CUPalette.accentText(scheme) : .secondary)
                            .padding(.horizontal, 13).padding(.vertical, 7)
                            .background(on ? AnyShapeStyle(CUPalette.coral.opacity(0.16)) : AnyShapeStyle(Color.primary.opacity(0.05)), in: Capsule())
                            .overlay(Capsule().strokeBorder(on ? CUPalette.coral.opacity(0.4) : Color.clear, lineWidth: 1))
                    }
                    .buttonStyle(CUPress())
                }
            }.padding(.horizontal, 1)
        }
    }
    // ── Log rows ──

    private func usageRow(_ e: CUUsageEvent) -> some View {
        let tint = CUPalette.provider(e.provider)
        return VStack(spacing: 0) {
            Button { detailEvent = e } label: {
                HStack(spacing: 11) {
                    Image(systemName: CULabel.icon(kind: e.kind, provider: e.provider))
                        .font(.system(size: 13)).foregroundStyle(tint).frame(width: 31, height: 31)
                        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 9))
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(e.shortModel).font(.system(size: 12.5, weight: .bold)).lineLimit(1)
                            Text(e.taskLabel ?? CULabel.roleTag(kind: e.kind)).font(.system(size: 8.5, weight: .semibold))
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Color.primary.opacity(0.08), in: Capsule()).foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        HStack(spacing: 8) {
                            Text(CUFormat.logTime(e.occurredAt, withDate: vm.windowSpansDays))
                            if let i = e.inputTokens { Text("↓\(CUFormat.tok(i))").foregroundStyle(CUPalette.sage) }
                            if let o = e.outputTokens { Text("↑\(CUFormat.tok(o))").foregroundStyle(CUPalette.violet) }
                            if let ca = e.cacheReadTokens, ca > 0 { Text("⚡\(CUFormat.tok(ca))").foregroundStyle(.tertiary) }
                        }
                        .font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(CUFormat.usd(e.costUsd)).font(.system(size: 13, weight: .bold, design: .rounded).monospacedDigit())
                        if let ok = e.ok {
                            Label(ok ? "সফল" : "ব্যর্থ", systemImage: "circle.fill").font(.system(size: 8.5, weight: .semibold))
                                .foregroundStyle(ok ? CUPalette.emerald : CUPalette.red)
                        }
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10).contentShape(Rectangle())
            }
            .buttonStyle(CUPressRow())
            Divider().opacity(0.4).padding(.leading, 14)
        }
    }

    private var loadMoreButton: some View {
        Button { Task { await vm.loadUsageLogs(reset: false) } } label: {
            HStack(spacing: 8) {
                if vm.loadingMore { ProgressView().controlSize(.small) }
                Text(vm.loadingMore ? "লোড হচ্ছে…" : "আরো দেখুন").font(.system(size: 12.5, weight: .bold))
            }
            .frame(maxWidth: .infinity).padding(.vertical, 12)
        }
        .buttonStyle(CUPress()).foregroundStyle(CUPalette.accentText(scheme))
        .cuGlass(scheme, corner: 14)
        .disabled(vm.loadingMore)
    }

    // ── Detail sheet: EVERY stored DB field, raw truth ──

    private func logDetailSheet(_ e: CUUsageEvent) -> some View {
        NavigationStack {
            List {
                Section("ইভেন্ট") {
                    detailRow("সময়", CUFormat.fullDT(e.occurredAt))
                    detailRow("Provider", CULabel.provider(e.provider))
                    detailRow("Kind", e.kindLabel.map { "\(e.kind) · \($0)" } ?? e.kind)
                    if let m = e.modelId { detailRow("Model", m) }
                    if let ml = e.model, ml != e.modelId { detailRow("Model label", ml) }
                    detailRow("Cost (USD)", CUFormat.usdFull(e.costUsd))
                }
                Section("টোকেন") {
                    detailRow("Input", e.inputTokens.map { "\($0)" } ?? "—")
                    detailRow("Output", e.outputTokens.map { "\($0)" } ?? "—")
                    detailRow("Cache read", e.cacheReadTokens.map { "\($0)" } ?? "—")
                    detailRow("Cache write", e.cacheWriteTokens.map { "\($0)" } ?? "—")
                }
                Section("Raw — units (DB)") {
                    if e.units.isEmpty {
                        Text("খালি").font(.system(size: 12)).foregroundStyle(.secondary)
                    } else {
                        ForEach(e.units.keys.sorted(), id: \.self) { k in
                            detailRow(k, e.units[k]?.display ?? "null")
                        }
                    }
                }
                Section("রেফারেন্স") {
                    detailRow("Event ID", e.id)
                    if let cid = e.conversationId { detailRow("Conversation", cid) }
                    if let jid = e.jobId { detailRow("Message/Job", jid) }
                }
            }
            .navigationTitle("লগ বিস্তারিত").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("বন্ধ") { detailEvent = nil } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func detailRow(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.system(size: 9, weight: .semibold)).textCase(.uppercase).kerning(0.4).foregroundStyle(.tertiary)
            Text(v).font(.system(size: 12.5, weight: .semibold).monospacedDigit()).textSelection(.enabled)
        }
        .padding(.vertical, 1)
    }

    // ── Custom log-range sheet (date + time, OpenRouter "Custom range…") ──

    private var logCustomSheet: some View {
        NavigationStack {
            Form {
                DatePicker("শুরু", selection: $vm.logCustomFrom, in: ...Date(), displayedComponents: [.date, .hourAndMinute])
                DatePicker("শেষ", selection: $vm.logCustomTo, in: ...Date(), displayedComponents: [.date, .hourAndMinute])
            }
            .navigationTitle("কাস্টম রেঞ্জ").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button("প্রয়োগ") {
                    vm.logRange = .custom
                    showLogCustomSheet = false
                    Task { await vm.loadUsageLogs() }
                } } }
        }
        .presentationDetents([.height(280)])
    }

    // ── Custom date sheet ──
    private var customSheet: some View {
        NavigationStack {
            Form {
                DatePicker("শুরু", selection: $vm.customFrom, in: earliest...Date(), displayedComponents: .date)
                DatePicker("শেষ", selection: $vm.customTo, in: earliest...Date(), displayedComponents: .date)
            }
            .navigationTitle("কাস্টম রেঞ্জ").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) {
                Button("প্রয়োগ") { withAnimation(.spring) { vm.range = .custom; selectedBar = nil }; showCustomSheet = false } } }
        }
        .presentationDetents([.height(240)])
    }
    private var earliest: Date { Calendar.current.date(byAdding: .day, value: -29, to: Date()) ?? Date() }

    // ── Shared ──
    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }.frame(maxWidth: .infinity).padding(20).cuSolid(scheme, corner: 16)
    }
    private func errorCard(_ msg: String) -> some View {
        Label(msg, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(CUPalette.red)
            .frame(maxWidth: .infinity, alignment: .leading).padding(12).cuSolid(scheme, corner: AlmaSwiftTheme.rControl)
    }
    private var loadingRows: some View {
        ForEach(0..<3, id: \.self) { _ in Color.clear.frame(height: 120).cuSolid(scheme, corner: 18).cuShimmer() }
    }
    // NP-4 (AG-11): native CSV export — the web page's GET /api/assistant/costs/export
    // fetched raw, written to a temp .csv and handed to the system share sheet.
    // Budget config went native 2026-07-11, so no web escape remains on this page.
    private var webEscape: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            Task { await exportCSV() }
        } label: {
            Label(csvExporting ? "CSV তৈরি হচ্ছে…" : "CSV এক্সপোর্ট / শেয়ার",
                  systemImage: "square.and.arrow.up")
                .font(.footnote).frame(maxWidth: .infinity).padding(.vertical, 12)
        }
        .buttonStyle(CUPress()).foregroundStyle(.secondary).cuGlass(scheme, corner: 14).padding(.top, 2)
        .disabled(csvExporting)
    }

    @MainActor private func exportCSV() async {
        guard !csvExporting else { return }
        csvExporting = true
        defer { csvExporting = false }
        do {
            let data = try await AlmaAPI.shared.getRaw("/api/assistant/costs/export")
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("alma-ai-costs-export.csv")
            try data.write(to: url, options: .atomic)
            let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            var top = UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController
            while let presented = top?.presentedViewController { top = presented }
            top?.present(av, animated: true)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

// MARK: - Custom glass segmented control

@available(iOS 17.0, *)
private struct CUSegment: View {
    let items: [String]
    @Binding var selection: Int
    let scheme: ColorScheme
    @Namespace private var ns
    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, t in
                Button { withAnimation(.spring(duration: 0.3)) { selection = i } } label: {
                    Text(t).font(.system(size: 13, weight: .bold)).foregroundStyle(selection == i ? Color.primary : .secondary)
                        .frame(maxWidth: .infinity).padding(.vertical, 9)
                        .background {
                            if selection == i {
                                RoundedRectangle(cornerRadius: 11).fill(.ultraThinMaterial)
                                    .overlay(RoundedRectangle(cornerRadius: 11).fill(.white.opacity(scheme == .dark ? 0.14 : 0.7)))
                                    .matchedGeometryEffect(id: "seg", in: ns)
                            }
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3).cuGlass(scheme, corner: 14)
    }
}

// MARK: - Button styles (press effects)

@available(iOS 17.0, *)
private struct CUPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed ? 0.96 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(duration: 0.25), value: configuration.isPressed)
    }
}
@available(iOS 17.0, *)
private struct CUPressRow: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(Color.primary.opacity(configuration.isPressed ? 0.05 : 0))
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

// MARK: - Formatting

private enum CUFormat {
    static func usd(_ n: Double) -> String {
        let digits = (n < 0.01 && n > 0) ? 4 : 2
        return "$" + String(format: "%.\(digits)f", n)
    }
    static func tok(_ n: Int) -> String { n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)" }
    static func ms(_ ms: Int) -> String { ms >= 1000 ? String(format: "%.1fs", Double(ms) / 1000) : "\(ms)ms" }
    static func ymd(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "Asia/Dhaka"); return f.string(from: d)
    }
    static func pretty(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "d MMM"; f.locale = Locale(identifier: "bn_BD"); f.timeZone = TimeZone(identifier: "Asia/Dhaka"); return f.string(from: d)
    }
    static func axis(_ ymd: String) -> String { ymd.count > 5 ? String(ymd.dropFirst(5)) : ymd }
    /// "2026-07-05" → Bangla "৫ জুলাই" for the drill-down readout.
    static func dayLabel(_ ymd: String) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "Asia/Dhaka")
        guard let d = f.date(from: ymd) else { return axis(ymd) }
        let o = DateFormatter(); o.dateFormat = "d MMM"; o.locale = Locale(identifier: "bn_BD"); o.timeZone = f.timeZone
        return o.string(from: d)
    }
    private static let iso: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    private static let isoPlain: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f }()
    private static func parse(_ s: String) -> Date? { iso.date(from: s) ?? isoPlain.date(from: s) }
    static func time(_ iso: String) -> String {
        guard let d = parse(iso) else { return "" }
        let f = DateFormatter(); f.dateFormat = "h:mm a"; f.locale = Locale(identifier: "bn_BD"); f.timeZone = TimeZone(identifier: "Asia/Dhaka"); return f.string(from: d)
    }
    static func dayKey(_ iso: String) -> String {
        guard let d = parse(iso) else { return "—" }
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "Asia/Dhaka")!
        if cal.isDateInToday(d) { return "আজ" }
        if cal.isDateInYesterday(d) { return "গতকাল" }
        let f = DateFormatter(); f.dateFormat = "d MMM"; f.locale = Locale(identifier: "bn_BD"); f.timeZone = cal.timeZone; return f.string(from: d)
    }

    // ── Logs explorer formatting ──

    /// Full-precision USD for the detail sheet — cost_usd is Decimal(10,6) in the DB.
    static func usdFull(_ n: Double) -> String { "$" + String(format: "%.6f", n) }

    private static let isoOut: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
    static func isoString(_ d: Date) -> String { isoOut.string(from: d) }

    private static func dhakaFormatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.dateFormat = format
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka")
        return f
    }
    /// Log-row time: HH:mm:ss, with the date prefixed when the window spans > 1 day.
    static func logTime(_ iso: String, withDate: Bool) -> String {
        guard let d = parse(iso) else { return "" }
        return dhakaFormatter(withDate ? "d MMM · HH:mm:ss" : "HH:mm:ss").string(from: d)
    }
    /// Mini-chart axis endpoint label.
    static func windowAxis(_ d: Date, spansDays: Bool) -> String {
        dhakaFormatter(spansDays ? "d MMM HH:mm" : "HH:mm").string(from: d)
    }
    /// Compact date-time for the custom-range chip.
    static func prettyDT(_ d: Date) -> String { dhakaFormatter("d MMM HH:mm").string(from: d) }
    /// Full timestamp for the detail sheet.
    static func fullDT(_ iso: String) -> String {
        guard let d = parse(iso) else { return iso }
        return dhakaFormatter("d MMM yyyy · HH:mm:ss").string(from: d)
    }
}

/// Live-mode indicator: solid green dot with a pulsing halo while ON.
@available(iOS 17.0, *)
private struct CULiveDot: View {
    let on: Bool
    var body: some View {
        ZStack {
            if on {
                Circle().fill(CUPalette.emerald).frame(width: 7, height: 7).modifier(CUPulse())
            }
            Circle().fill(on ? CUPalette.emerald : Color.secondary.opacity(0.45)).frame(width: 7, height: 7)
        }
        .frame(width: 9, height: 9)
    }
}

// MARK: - Aurora + materials (page-owned)

@available(iOS 17.0, *)
private struct CUAurora: View {
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
    /// SOLID: opaque content surface for dense data (no translucency — 2026 HIG).
    func cuSolid(_ s: ColorScheme, corner: CGFloat = 16) -> some View {
        // Translucent glass (was opaque near-black) so the page aurora shows through —
        // provider cards / stat tiles / model card were the last black offenders
        // (owner feedback 2026-07-17).
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(s == .dark ? 0.05 : 0.5),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(s == .dark ? 0.09 : 0.6), lineWidth: 1))
            .shadow(color: .black.opacity(s == .dark ? 0.26 : 0.07), radius: 14, y: 8)
    }
    /// RAISED: a step above solid — the hero. Gentle gradient + deeper shadow.
    func cuRaised(_ s: ColorScheme, corner: CGFloat = 22) -> some View {
        // Translucent glass (was opaque near-black) so the page aurora shows through —
        // theme-consistent with the other agent screens (owner feedback 2026-07-17).
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(s == .dark ? 0.05 : 0.55),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(s == .dark ? 0.09 : 0.7), lineWidth: 1))
            .shadow(color: .black.opacity(s == .dark ? 0.30 : 0.10), radius: 20, y: 11)
    }
    /// GLASS: translucent floating control (liquid-glass) — nav/segment/chip/sheet.
    func cuGlass(_ s: ColorScheme, corner: CGFloat = 14) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(s == .dark ? 0.06 : 0.35), in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(LinearGradient(colors: [.white.opacity(s == .dark ? 0.3 : 0.85), .white.opacity(s == .dark ? 0.06 : 0.3)], startPoint: .top, endPoint: .bottom), lineWidth: 1))
    }
    func cuShimmer() -> some View { modifier(CUShimmer()) }
    /// Subtle scroll-in appear (staggered by index).
    func cuAppear(_ i: Int) -> some View { modifier(CUAppear(index: i)) }
}

@available(iOS 17.0, *)
private struct CUShimmer: ViewModifier {
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        content.overlay(LinearGradient(colors: [.clear, .white.opacity(0.14), .clear], startPoint: .leading, endPoint: .trailing).offset(x: phase * 320).clipped())
            .onAppear { withAnimation(.linear(duration: 1.15).repeatForever(autoreverses: false)) { phase = 1.5 } }
    }
}
@available(iOS 17.0, *)
private struct CUPulse: ViewModifier {
    @State private var on = false
    func body(content: Content) -> some View {
        content.scaleEffect(on ? 1.5 : 1).opacity(on ? 0.4 : 1)
            .onAppear { withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) { on = true } }
    }
}
@available(iOS 17.0, *)
private struct CUAppear: ViewModifier {
    let index: Int
    @State private var shown = false
    func body(content: Content) -> some View {
        content.opacity(shown ? 1 : 0).offset(y: shown ? 0 : 14)
            .onAppear {
                withAnimation(.spring(duration: 0.5).delay(Double(min(index, 6)) * 0.05)) { shown = true }
            }
    }
}

/// Minimal wrapping layout for the legend.
private struct CUFlow: Layout {
    var spacing: CGFloat = 10; var lineSpacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > maxW { x = 0; y += rowH + lineSpacing; rowH = 0 }
            x += s.width + spacing; rowH = max(rowH, s.height)
        }
        return CGSize(width: maxW == .infinity ? x : maxW, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let maxW = bounds.width
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x - bounds.minX + s.width > maxW { x = bounds.minX; y += rowH + lineSpacing; rowH = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing; rowH = max(rowH, s.height)
        }
    }
}

// MARK: - Preview

@available(iOS 17.0, *)
#Preview("Credit Usage — Dark") {
    CreditUsageScreen(openWeb: { _, _ in }).preferredColorScheme(.dark)
}
