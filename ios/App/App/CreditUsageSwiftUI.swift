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
//  Budget config / CSV stay on the web — footer escape opens /agent/costs.
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

/// One ledger event. `latencyMs` / `ttftMs` / `cachedTokens` / `ok` decode when the
/// backend adds them, and stay nil until then (the row hides those bits gracefully).
struct CULogEvent: Decodable, Identifiable, Equatable {
    let id: String
    let occurredAt: String
    let provider: String
    let model: String?
    let kind: String
    let costUsd: Double
    let inputTokens: Int?
    let outputTokens: Int?
    let cachedTokens: Int?
    let latencyMs: Int?
    let ttftMs: Int?
    let ok: Bool?

    private enum K: String, CodingKey {
        case id, occurredAt, provider, model, kind, costUsd, inputTokens, outputTokens
        case cachedTokens, latencyMs, ttftMs, ok
    }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        occurredAt = (try? c.decodeIfPresent(String.self, forKey: .occurredAt)) ?? ""
        provider = (try? c.decodeIfPresent(String.self, forKey: .provider)) ?? ""
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? ""
        costUsd = CUFlex.double(c, .costUsd) ?? 0
        inputTokens = CUFlex.int(c, .inputTokens)
        outputTokens = CUFlex.int(c, .outputTokens)
        cachedTokens = CUFlex.int(c, .cachedTokens)
        latencyMs = CUFlex.int(c, .latencyMs)
        ttftMs = CUFlex.int(c, .ttftMs)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? "\(provider)-\(occurredAt)-\(kind)"
    }
}
private struct CULogsResponse: Decodable { let events: [CULogEvent] }

// MARK: - Range

enum CURange: String, CaseIterable, Identifiable {
    case d1 = "1D", d7 = "7D", d30 = "30D", custom = "Custom"
    var id: String { rawValue }
    var unitIsHour: Bool { self == .d1 }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class CreditUsageVM {
    var summary: CUSummary? = nil
    var balances: CUBalances? = nil
    var events: [CULogEvent] = []
    var loading = false
    var error: String? = nil
    var authExpired = false

    var range: CURange = .d30
    var customFrom = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date()
    var customTo = Date()
    var logFilter: String = "সব"

    func load() async {
        loading = true; error = nil; defer { loading = false }
        do {
            summary = try await AlmaAPI.shared.get("/api/assistant/costs/summary")
            authExpired = false
            if let b: CUBalances = try? await AlmaAPI.shared.get("/api/assistant/costs/balances") { balances = b }
            await loadLogs()
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }
            self.error = error.localizedDescription
        }
    }
    func loadLogs() async {
        if let r: CULogsResponse = try? await AlmaAPI.shared.get("/api/assistant/costs/logs", query: ["limit": "120"]) {
            events = r.events
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

    var filteredEvents: [CULogEvent] {
        guard logFilter != "সব" else { return events }
        return events.filter { e in
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
    var groupedEvents: [(day: String, subtotal: Double, items: [CULogEvent])] {
        let groups = Dictionary(grouping: filteredEvents) { CUFormat.dayKey($0.occurredAt) }
        return groups.map { (day: $0.key, subtotal: $0.value.reduce(0) { $0 + $1.costUsd }, items: $0.value) }
            .sorted { ($0.items.first?.occurredAt ?? "") > ($1.items.first?.occurredAt ?? "") }
    }
    var avgTtft: Int? {
        let vals = events.compactMap { $0.ttftMs }
        guard !vals.isEmpty else { return nil }
        return vals.reduce(0, +) / vals.count
    }
    var failedCount: Int { events.filter { $0.ok == false }.count }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct CreditUsageScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm = CreditUsageVM()
    @State private var pane = 0
    @State private var selectedBar: Int? = nil
    @State private var expanded: Set<String> = []
    @State private var showCustomSheet = false
    let openWeb: (_ path: String, _ title: String) -> Void

    private let liveTimer = Timer.publish(every: 20, on: .main, in: .common).autoconnect()

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
            guard pane == 1, !vm.loading else { return }
            Task { await vm.loadLogs() }
        }
        .sheet(isPresented: $showCustomSheet) { customSheet }
        .sensoryFeedback(.selection, trigger: pane)
        .sensoryFeedback(.selection, trigger: vm.range)
        .sensoryFeedback(.impact(weight: .light), trigger: selectedBar)
        .sensoryFeedback(.selection, trigger: vm.logFilter)
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
            statPill("মোট রিকোয়েস্ট", "\(vm.events.count)")
            statPill("আজ খরচ", CUFormat.usd(s.todayUsd))
            statPill("গড় TTFT", vm.avgTtft.map { CUFormat.ms($0) } ?? "—")
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
        guard hasDaily || hasMonthly else { return nil }
        return AnyView(
            VStack(alignment: .leading, spacing: 10) {
                Text("রিমেইনিং বাজেট").font(.system(size: 10, weight: .bold)).textCase(.uppercase).kerning(0.5).foregroundStyle(.secondary)
                if hasMonthly, let pct = s.monthlyBudgetPct, let cap = s.budgets.monthlyUsd { budgetRow(spent: s.monthUsd, cap: cap, pct: pct, label: "এই মাস") }
                if hasDaily, let pct = s.dailyBudgetPct, let cap = s.budgets.dailyUsd { budgetRow(spent: s.todayUsd, cap: cap, pct: pct, label: "আজ") }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(16).cuSolid(scheme, corner: 18))
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
            filterChips.cuAppear(0)
            logStatTrio.cuAppear(1)
            Text("ALMA ERP-এর প্রতিটি খরচ — chat · voice · image · call · research — end to end। row-তে ট্যাপ করে input/output/cached/TTFT বিস্তারিত।")
                .font(.system(size: 11)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 3)
            if vm.groupedEvents.isEmpty && !vm.loading {
                Text("এখনো কোনো ইভেন্ট নেই").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 30)
            }
            ForEach(Array(vm.groupedEvents.enumerated()), id: \.element.day) { gi, group in
                HStack(alignment: .firstTextBaseline) {
                    Text(group.day).font(.system(size: 11.5, weight: .bold)); Spacer()
                    Text(CUFormat.usd(group.subtotal)).font(.system(size: 12, weight: .bold, design: .rounded).monospacedDigit())
                        .foregroundStyle(CUPalette.accentText(scheme))
                }.padding(.horizontal, 4).padding(.top, 4)
                VStack(spacing: 0) {
                    ForEach(group.items) { e in logRow(e) }
                }
                .cuSolid(scheme, corner: 18).cuAppear(gi + 2)
            }
        }
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
    private var logStatTrio: some View {
        let today = vm.groupedEvents.first
        return HStack(spacing: 9) {
            statPill("আজকের ইভেন্ট", "\(today?.items.count ?? 0)")
            statPill("আজ খরচ", CUFormat.usd(today?.subtotal ?? 0))
            statPill("ব্যর্থ", "\(vm.failedCount)")
        }
    }

    private func logRow(_ e: CULogEvent) -> some View {
        let tint = CUPalette.provider(e.provider)
        let isOpen = expanded.contains(e.id)
        return VStack(spacing: 0) {
            Button {
                withAnimation(.spring(duration: 0.3)) {
                    if isOpen { expanded.remove(e.id) } else { expanded.insert(e.id) }
                }
            } label: {
                HStack(spacing: 11) {
                    Image(systemName: CULabel.icon(kind: e.kind, provider: e.provider))
                        .font(.system(size: 14)).foregroundStyle(tint).frame(width: 33, height: 33)
                        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(e.model ?? CULabel.provider(e.provider)).font(.system(size: 12.5, weight: .bold)).lineLimit(1)
                            Text(CULabel.roleTag(kind: e.kind)).font(.system(size: 8.5, weight: .semibold))
                                .padding(.horizontal, 6).padding(.vertical, 1).background(Color.primary.opacity(0.08), in: Capsule()).foregroundStyle(.secondary)
                        }
                        HStack(spacing: 9) {
                            Text(CUFormat.time(e.occurredAt))
                            if let i = e.inputTokens, let o = e.outputTokens {
                                HStack(spacing: 5) {
                                    Text("↓\(CUFormat.tok(i))").foregroundStyle(CUPalette.sage)
                                    Text("↑\(CUFormat.tok(o))").foregroundStyle(CUPalette.violet)
                                    if let ca = e.cachedTokens, ca > 0 { Text("⚡\(CUFormat.tok(ca))").foregroundStyle(.tertiary) }
                                }
                            }
                            if let ms = e.latencyMs { Text("⏱ \(CUFormat.ms(ms))") }
                        }
                        .font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(CUFormat.usd(e.costUsd)).font(.system(size: 13.5, weight: .bold, design: .rounded).monospacedDigit())
                        if let ok = e.ok {
                            Label(ok ? "সফল" : "ব্যর্থ", systemImage: "circle.fill").font(.system(size: 8.5, weight: .semibold))
                                .foregroundStyle(ok ? CUPalette.emerald : CUPalette.red)
                        }
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 11).contentShape(Rectangle())
            }
            .buttonStyle(CUPressRow())
            if isOpen { logDetail(e).transition(.opacity.combined(with: .move(edge: .top))) }
            Divider().opacity(0.4).padding(.leading, 14)
        }
    }

    private func logDetail(_ e: CULogEvent) -> some View {
        let cols = Array(repeating: GridItem(.flexible(), alignment: .leading), count: 3)
        return LazyVGrid(columns: cols, alignment: .leading, spacing: 10) {
            detailCell("Input", e.inputTokens.map { "\(CUFormat.tok($0))" } ?? "—")
            detailCell("Output", e.outputTokens.map { "\(CUFormat.tok($0))" } ?? "—")
            detailCell("Cached", e.cachedTokens.map { "\(CUFormat.tok($0))" } ?? "—")
            detailCell("TTFT", e.ttftMs.map { CUFormat.ms($0) } ?? "—")
            detailCell("Latency", e.latencyMs.map { CUFormat.ms($0) } ?? "—")
            detailCell("Cost", CUFormat.usd(e.costUsd))
        }
        .padding(14).padding(.top, 2)
    }
    private func detailCell(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.system(size: 8.5, weight: .semibold)).textCase(.uppercase).kerning(0.4).foregroundStyle(.tertiary)
            Text(v).font(.system(size: 12, weight: .bold).monospacedDigit())
        }
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
    private var webEscape: some View {
        Button { openWeb("/agent/costs", "Costs") } label: {
            Label("বাজেট কনফিগ / CSV — ওয়েবে খুলুন", systemImage: "safari").font(.footnote).frame(maxWidth: .infinity).padding(.vertical, 12)
        }
        .buttonStyle(CUPress()).foregroundStyle(.secondary).cuGlass(scheme, corner: 14).padding(.top, 2)
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
                        .fill(b.color)
                        .frame(width: b.size, height: b.size)
                        .position(x: geo.size.width * b.x + (drift ? b.dx : -b.dx),
                                  y: geo.size.height * b.y + (drift ? b.dy : -b.dy))
                        .blur(radius: 70)
                }
            }
            .onAppear { updateDrift() }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
                .receive(on: DispatchQueue.main)) { _ in updateDrift() }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    /// Battery guard: drift only when the owner allows motion — Reduce Motion and
    /// Low Power Mode both freeze the aurora to a static wash (blobs at rest).
    private func updateDrift() {
        if reduceMotion || ProcessInfo.processInfo.isLowPowerModeEnabled {
            var tx = Transaction(); tx.disablesAnimations = true
            withTransaction(tx) { drift = false }
        } else if !drift {
            withAnimation(.easeInOut(duration: 26).repeatForever(autoreverses: true)) { drift = true }
        }
    }
}

@available(iOS 17.0, *)
private extension View {
    /// SOLID: opaque content surface for dense data (no translucency — 2026 HIG).
    func cuSolid(_ s: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background((s == .dark ? Color(red: 0.078, green: 0.071, blue: 0.114) : .white),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(s == .dark ? 0.055 : 0.6), lineWidth: 1))
            .shadow(color: .black.opacity(s == .dark ? 0.4 : 0.08), radius: 14, y: 8)
    }
    /// RAISED: a step above solid — the hero. Gentle gradient + deeper shadow.
    func cuRaised(_ s: ColorScheme, corner: CGFloat = 22) -> some View {
        self
            .background(
                (s == .dark
                 ? LinearGradient(colors: [Color(red: 0.106, green: 0.094, blue: 0.149), Color(red: 0.078, green: 0.063, blue: 0.098)], startPoint: .top, endPoint: .bottom)
                 : LinearGradient(colors: [.white, .white], startPoint: .top, endPoint: .bottom)),
                in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(s == .dark ? 0.07 : 0.7), lineWidth: 1))
            .shadow(color: .black.opacity(s == .dark ? 0.5 : 0.12), radius: 22, y: 12)
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
