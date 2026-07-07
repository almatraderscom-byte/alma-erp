//
//  CreditUsageSwiftUI.swift
//  ALMA ERP — the redesigned agent cost dashboard as a native SwiftUI screen.
//
//  Replaces the old AgentCostsScreen ("Monitor") with a professional, Apple-grade
//  two-pane page (owner design, 2026-07-07):
//    • USAGE — big live spend hero with a 1D/7D/30D/Custom range switch, a
//      Screen-Time-style stacked daily bar chart (real per-provider daily data),
//      a swipe wallet of provider credit/balance cards, model breakdown, budget bar.
//    • LOGS — ALMA ERP's end-to-end cost ledger: every chat/voice/image/call/research
//      event grouped by Dhaka day, filter chips, tap-to-expand single-event detail.
//
//  Data (all live, owner-only, cookie-bridged via AlmaAPI):
//    GET /api/assistant/costs/summary   → today/month/forecast USD, byModel, byProvider,
//                                         dailyLast30 (per-provider daily), budgets.
//    GET /api/assistant/costs/balances  → per-provider live balances + spend.
//    GET /api/assistant/costs/logs      → recent per-event ledger (model, tokens, cost).
//  Budget CONFIG / CSV stay on the web — the footer escape hatch opens /agent/costs.
//  Read-only by design (no writes from this screen).
//
//  Parallel-session rule: this file owns its aurora + glass helpers (no cross-page
//  imports), so the shared Aura look is duplicated from the Orders/Assistant spec.
//

import SwiftUI

// MARK: - Palette (exact web PROVIDER_COLORS / globals.css tokens)

private enum CUPalette {
    static let coral = Color(red: 0.878, green: 0.478, blue: 0.373)   // #E07A5F
    static let violet = Color(red: 0.655, green: 0.545, blue: 0.980)  // #A78BFA
    static let sage = Color(red: 0.506, green: 0.698, blue: 0.604)    // #81B29A
    static let gold = Color(red: 0.831, green: 0.659, blue: 0.294)    // #D4A84B
    static let goldLt = Color(red: 0.933, green: 0.706, blue: 0.561)  // #EEB48F
    static let emerald = Color(red: 0.239, green: 0.745, blue: 0.545) // #3DBE8B
    static let amber = Color(red: 0.878, green: 0.663, blue: 0.294)   // #E0A94B
    static let red = Color(red: 0.894, green: 0.459, blue: 0.420)     // #E4756B

    /// Web PROVIDER_COLORS (same hexes used by the recharts dashboard).
    static func provider(_ id: String) -> Color {
        switch id {
        case "anthropic": return coral                                       // #E07A5F
        case "openai": return sage                                           // #81B29A
        case "openrouter": return violet                                     // #A78BFA
        case "gemini": return Color(red: 0.231, green: 0.510, blue: 0.965)   // #3B82F6
        case "google_tts": return Color(red: 0.545, green: 0.361, blue: 0.965) // #8B5CF6
        case "twilio": return gold                                           // #D4A84B
        case "elevenlabs": return Color(red: 0.925, green: 0.282, blue: 0.600) // #EC4899
        case "veo": return Color(red: 0.055, green: 0.647, blue: 0.914)      // #0EA5E9
        default: return Color(red: 0.580, green: 0.639, blue: 0.722)         // #94a3b8
        }
    }
    /// Deterministic colour cycle for model bars (web MODEL_CHART_COLORS order).
    static let modelCycle: [Color] = [
        coral, sage, violet,
        Color(red: 0.231, green: 0.510, blue: 0.965), gold,
        Color(red: 0.925, green: 0.282, blue: 0.600),
        Color(red: 0.055, green: 0.647, blue: 0.914),
        Color(red: 0.063, green: 0.725, blue: 0.506),
        Color(red: 0.961, green: 0.620, blue: 0.043),
        Color(red: 0.388, green: 0.400, blue: 0.945),
    ]
    static func model(_ i: Int) -> Color { modelCycle[i % modelCycle.count] }

    static func accentText(_ s: ColorScheme) -> Color {
        s == .dark ? goldLt : Color(red: 0.706, green: 0.333, blue: 0.184)   // #B4552F on cream
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
        case "anthropic": return "Anthropic"
        case "openai": return "OpenAI"
        case "openrouter": return "OpenRouter"
        case "gemini": return "Gemini"
        case "google_tts": return "Google TTS"
        case "twilio": return "Twilio"
        case "elevenlabs": return "ElevenLabs"
        case "veo": return "VEO 3"
        case "oxylabs": return "Oxylabs"
        default: return id.isEmpty ? "অন্যান্য" : id
        }
    }
    /// SF Symbol for a cost-event kind — makes the ledger read at a glance.
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
    /// Short role/kind tag shown next to the model name.
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

// MARK: - Flexible decode (costs are USD decimals; API mixes number/string shapes)

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

/// One day of dailyLast30 — the API row is `{date, <provider>: usd, …, total}`.
/// We keep the per-provider split (minus non-USD oxylabs credits) for the stack.
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
            case "oxylabs": break // prepaid credits, not USD — excluded from the $ chart
            default:
                if let v = CUFlex.double(c, key), v != 0 { prov[key.stringValue] = v }
            }
        }
        self.date = date; self.total = total; self.providers = prov
    }
    /// USD sum of the plotted providers (oxylabs already excluded above).
    var plottedTotal: Double { providers.values.reduce(0, +) }
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

/// One ledger event. `latencyMs`/`ok` are decoded when the backend adds them, and
/// simply stay nil until then (the row hides those bits gracefully).
struct CULogEvent: Decodable, Identifiable, Equatable {
    let id: String
    let occurredAt: String
    let provider: String
    let model: String?
    let kind: String
    let costUsd: Double
    let inputTokens: Int?
    let outputTokens: Int?
    let latencyMs: Int?
    let ok: Bool?

    private enum K: String, CodingKey {
        case id, occurredAt, provider, model, kind, costUsd, inputTokens, outputTokens, latencyMs, ok
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
        latencyMs = CUFlex.int(c, .latencyMs)
        ok = try? c.decodeIfPresent(Bool.self, forKey: .ok)
        id = (try? c.decodeIfPresent(String.self, forKey: .id)) ?? "\(provider)-\(occurredAt)-\(kind)"
    }
}
private struct CULogsResponse: Decodable { let events: [CULogEvent] }

// MARK: - Range

enum CURange: String, CaseIterable, Identifiable {
    case d1 = "1D", d7 = "7D", d30 = "30D", custom = "Custom"
    var id: String { rawValue }
    var days: Int { self == .d1 ? 1 : self == .d7 ? 7 : 30 }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class CreditUsageVM {
    var summary: CUSummary? = nil
    var balances: CUBalances? = nil
    var events: [CULogEvent] = []
    var loading = false
    var refreshingLogs = false
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
            if let b: CUBalances = try? await AlmaAPI.shared.get("/api/assistant/costs/balances") {
                balances = b
            }
            await loadLogs()
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }
            self.error = error.localizedDescription
        }
    }

    func loadLogs(silent: Bool = false) async {
        if silent { refreshingLogs = true }
        defer { refreshingLogs = false }
        if let r: CULogsResponse = try? await AlmaAPI.shared.get(
            "/api/assistant/costs/logs", query: ["limit": "120"]) {
            events = r.events
        }
    }

    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    // ── Derived: the days visible for the current range ──
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
    /// Per-provider USD summed across the visible window (for the legend), high→low.
    var rangeByProvider: [(String, Double)] {
        var acc: [String: Double] = [:]
        for d in visibleDays { for (k, v) in d.providers { acc[k, default: 0] += v } }
        return acc.sorted { $0.value > $1.value }
    }
    /// Canonical stack order so colours are stable day-to-day.
    var stackOrder: [String] { rangeByProvider.map(\.0) }

    var filteredEvents: [CULogEvent] {
        guard logFilter != "সব" else { return events }
        return events.filter { e in
            switch logFilter {
            case "Gemini": return e.provider == "gemini"
            case "Anthropic": return e.provider == "anthropic"
            case "OpenRouter": return e.provider == "openrouter"
            case "Voice": return e.provider == "google_tts" || e.kind.lowercased().contains("tts")
                || e.kind.lowercased().contains("stt") || e.kind.lowercased().contains("whisper")
            case "Image": return e.kind.lowercased().contains("image")
            case "ব্যর্থ": return e.ok == false
            default: return true
            }
        }
    }
    /// Ledger grouped by Dhaka day (newest day first), each with its USD subtotal.
    var groupedEvents: [(day: String, subtotal: Double, items: [CULogEvent])] {
        let groups = Dictionary(grouping: filteredEvents) { CUFormat.dayKey($0.occurredAt) }
        return groups.map { (day: $0.key, subtotal: $0.value.reduce(0) { $0 + $1.costUsd }, items: $0.value) }
            .sorted { ($0.items.first?.occurredAt ?? "") > ($1.items.first?.occurredAt ?? "") }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct CreditUsageScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm = CreditUsageVM()
    @State private var pane = 0            // 0 = Usage, 1 = Logs
    @State private var showCustomSheet = false
    @State private var expanded: Set<String> = []
    let openWeb: (_ path: String, _ title: String) -> Void

    // A quiet heartbeat so the ledger feels live while the owner watches it.
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
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .onReceive(liveTimer) { _ in
            guard pane == 1, !vm.loading else { return }
            Task { await vm.loadLogs(silent: true) }
        }
        .sheet(isPresented: $showCustomSheet) { customSheet }
    }

    // ── Usage / Logs segmented switch ──
    private var paneSwitch: some View {
        Picker("", selection: $pane) {
            Text("Usage").tag(0); Text("Logs").tag(1)
        }
        .pickerStyle(.segmented)
        .padding(.bottom, 2)
    }

    // ═══════════════ USAGE PANE ═══════════════

    @ViewBuilder private var usagePane: some View {
        if let s = vm.summary {
            spendHero(s)
            if let b = vm.balances, !b.providers.isEmpty { walletRow(b) }
            statTrio(s)
            if !s.byModel.isEmpty { modelBreakdown(s) }
            if let bud = budgetCard(s) { bud }
        }
    }

    private func spendHero(_ s: CUSummary) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                Text("এই সময়ের খরচ · CREDIT USAGE")
                    .font(.system(size: 10, weight: .bold)).textCase(.uppercase)
                    .kerning(0.6).foregroundStyle(.secondary)
                Spacer()
                rangePicker
            }
            Text(CUFormat.usd(vm.range == .d1 ? s.todayUsd : vm.rangeTotal))
                .font(.system(size: 44, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(CUPalette.accentText(scheme))
                .lineLimit(1).minimumScaleFactor(0.5)
                .padding(.top, 9).padding(.bottom, 3)
                .contentTransition(.numericText())
                .animation(.snappy, value: vm.rangeTotal)
            heroDelta(s).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
            if vm.range == .custom {
                Button { showCustomSheet = true } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "calendar").foregroundStyle(CUPalette.coral)
                        Text("\(CUFormat.pretty(vm.customFrom)) – \(CUFormat.pretty(vm.customTo))")
                            .font(.system(size: 12, weight: .semibold))
                        Image(systemName: "chevron.down").font(.system(size: 9)).foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 13).padding(.vertical, 9)
                    .background(.ultraThinMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(.white.opacity(scheme == .dark ? 0.1 : 0.4), lineWidth: 1))
                }
                .buttonStyle(.plain).padding(.top, 12)
            }
            stackedChart
            legend
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .cuGlass(scheme, corner: 20)
    }

    @ViewBuilder private func heroDelta(_ s: CUSummary) -> some View {
        switch vm.range {
        case .d1:
            Label("গতকালের তুলনায় আজকের খরচ", systemImage: "arrow.up.right")
                .labelStyle(.titleAndIcon).foregroundStyle(CUPalette.emerald)
        case .custom:
            Text("\(vm.visibleDays.count) দিন · গড় \(CUFormat.usd(avgPerDay))/দিন")
        default:
            Text("পূর্বাভাস ~\(CUFormat.usd(s.forecastUsd)) · গড় \(CUFormat.usd(avgPerDay))/দিন")
        }
    }
    private var avgPerDay: Double {
        let n = max(vm.visibleDays.count, 1); return vm.rangeTotal / Double(n)
    }

    private var rangePicker: some View {
        HStack(spacing: 1) {
            ForEach(CURange.allCases) { r in
                Button {
                    vm.range = r
                    if r == .custom { showCustomSheet = true }
                } label: {
                    Text(r.rawValue)
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(vm.range == r ? Color.primary : .secondary)
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background(vm.range == r ? AnyShapeStyle(.ultraThinMaterial) : AnyShapeStyle(Color.clear),
                                    in: RoundedRectangle(cornerRadius: 7))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 9))
    }

    // Screen-Time-style stacked daily bars from real per-provider data.
    private var stackedChart: some View {
        let days = vm.visibleDays
        let maxT = max(days.map(\.plottedTotal).max() ?? 0, 0.0001)
        let order = vm.stackOrder
        return VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: days.count > 20 ? 2 : 3) {
                if days.isEmpty {
                    Text("এখনো কোনো খরচ নেই").font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).frame(height: 106)
                } else {
                    ForEach(Array(days.enumerated()), id: \.element.id) { idx, d in
                        stackColumn(d, order: order, maxT: maxT, isLast: idx == days.count - 1)
                    }
                }
            }
            .frame(height: 106)
            if let first = days.first, let last = days.last {
                HStack {
                    Text(CUFormat.axis(first.date)).font(.system(size: 9)).foregroundStyle(.tertiary)
                    Spacer()
                    Text(CUFormat.axis(last.date)).font(.system(size: 9)).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.top, 16)
    }

    private func stackColumn(_ d: CUDay, order: [String], maxT: Double, isLast: Bool) -> some View {
        let h = max(CGFloat(d.plottedTotal / maxT) * 106, d.plottedTotal > 0 ? 3 : 1)
        return VStack(spacing: 1.5) {
            ForEach(order.reversed(), id: \.self) { p in
                let v = d.providers[p] ?? 0
                if v > 0 {
                    let segH = max(h * CGFloat(v / max(d.plottedTotal, 0.0001)), 1.5)
                    Rectangle().fill(CUPalette.provider(p)).frame(height: segH)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: h, alignment: .bottom)
        .frame(maxHeight: 106, alignment: .bottom)
        .clipShape(RoundedRectangle(cornerRadius: 2.5))
        .overlay(alignment: .bottom) {
            if isLast { // live "today" bar breathes gently
                RoundedRectangle(cornerRadius: 2.5).fill(Color.white.opacity(0.001))
                    .frame(height: h)
                    .modifier(CUPulse())
            }
        }
    }

    private var legend: some View {
        let items = vm.rangeByProvider.prefix(6)
        let grand = max(vm.rangeTotal, 0.0001)
        return FlowRow(spacing: 14, lineSpacing: 8) {
            ForEach(Array(items), id: \.0) { p, v in
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2).fill(CUPalette.provider(p)).frame(width: 8, height: 8)
                    Text(CULabel.provider(p)).font(.system(size: 11, weight: .semibold))
                    Text(CUFormat.usd(v * vm.rangeTotal / grand))
                        .font(.system(size: 11, weight: .bold).monospacedDigit()).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.top, 14)
        .overlay(alignment: .top) { Divider().opacity(0.5) }
    }

    // Provider credit/balance wallet — refined frosted cards, brand accent line.
    private func walletRow(_ b: CUBalances) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Provider ক্রেডিট").font(.system(size: 13, weight: .bold))
                Spacer()
                Text("← swipe").font(.system(size: 10.5)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 3)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 11) {
                    ForEach(b.providers) { row in walletCard(row) }
                }
                .padding(.horizontal, 1)
            }
        }
    }
    private func walletCard(_ row: CUBalanceRow) -> some View {
        let tint = CUPalette.provider(row.id)
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(String(row.label.prefix(1)))
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .frame(width: 24, height: 24)
                    .background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: 7))
                    .foregroundStyle(tint)
                Text(row.label).font(.system(size: 12.5, weight: .bold)).lineLimit(1)
                Spacer(minLength: 4)
                Text(row.free ? "FREE" : "LIVE")
                    .font(.system(size: 8, weight: .heavy)).kerning(0.5)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.primary.opacity(0.08), in: Capsule())
                    .foregroundStyle(.secondary)
            }
            Text(row.free ? "Free" : (row.balanceUsd.map { CUFormat.usd($0) } ?? "—"))
                .font(.system(size: 22, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(CUPalette.balance(row.balanceUsd, free: row.free))
                .padding(.top, 13)
            Text("আজ \(CUFormat.usd(row.todayUsd ?? 0)) · মাস \(CUFormat.usd(row.monthUsd ?? 0))")
                .font(.system(size: 9.5).monospacedDigit()).foregroundStyle(.secondary).padding(.top, 3)
        }
        .padding(14)
        .frame(width: 158, alignment: .leading)
        .cuGlass(scheme, corner: 17)
        .overlay(alignment: .top) {
            RoundedRectangle(cornerRadius: 2).fill(tint).frame(height: 2.5)
                .padding(.horizontal, 14).padding(.top, 0)
        }
    }

    private func statTrio(_ s: CUSummary) -> some View {
        HStack(spacing: 9) {
            statPill("এই মাস", CUFormat.usd(s.monthUsd))
            statPill("আজ", CUFormat.usd(s.todayUsd))
            statPill("পূর্বাভাস", CUFormat.usd(s.forecastUsd))
        }
    }
    private func statPill(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(k).font(.system(size: 9)).foregroundStyle(.secondary)
            Text(v).font(.system(size: 17, weight: .bold, design: .rounded).monospacedDigit())
                .lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12).cuGlass(scheme, corner: 15)
    }

    private func modelBreakdown(_ s: CUSummary) -> some View {
        let maxMonth = max(s.byModel.map(\.monthUsd).max() ?? 0, 0.0001)
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("মডেল অনুযায়ী খরচ").font(.system(size: 13, weight: .bold))
                Spacer(); Text("এই মাস").font(.system(size: 11)).foregroundStyle(.secondary)
            }
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
        .frame(maxWidth: .infinity, alignment: .leading).padding(16).cuGlass(scheme, corner: 18)
    }

    private func budgetCard(_ s: CUSummary) -> AnyView? {
        let hasDaily = s.dailyBudgetPct != nil && s.budgets.dailyUsd != nil
        let hasMonthly = s.monthlyBudgetPct != nil && s.budgets.monthlyUsd != nil
        guard hasDaily || hasMonthly else { return nil }
        return AnyView(
            VStack(alignment: .leading, spacing: 10) {
                Text("রিমেইনিং বাজেট").font(.system(size: 10, weight: .bold)).textCase(.uppercase)
                    .kerning(0.5).foregroundStyle(.secondary)
                if hasMonthly, let pct = s.monthlyBudgetPct, let cap = s.budgets.monthlyUsd {
                    budgetRow(spent: s.monthUsd, cap: cap, pct: pct, label: "এই মাস")
                }
                if hasDaily, let pct = s.dailyBudgetPct, let cap = s.budgets.dailyUsd {
                    budgetRow(spent: s.todayUsd, cap: cap, pct: pct, label: "আজ")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(16).cuGlass(scheme, corner: 18)
        )
    }
    private func budgetRow(spent: Double, cap: Double, pct: Double, label: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(label) · \(CUFormat.usd(cap - spent)) বাকি").font(.system(size: 12, weight: .semibold))
                Spacer()
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

    // ═══════════════ LOGS PANE ═══════════════

    private var logsPane: some View {
        VStack(spacing: 12) {
            filterChips
            logStatTrio
            Text("ALMA ERP-এর প্রতিটি খরচ — chat · voice · image · call · research — end to end। row-তে ট্যাপ করে single-event বিস্তারিত।")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 3)
            if vm.groupedEvents.isEmpty && !vm.loading {
                Text("এখনো কোনো ইভেন্ট নেই").font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 30)
            }
            ForEach(vm.groupedEvents, id: \.day) { group in
                HStack(alignment: .firstTextBaseline) {
                    Text(group.day).font(.system(size: 11.5, weight: .bold))
                    Spacer()
                    Text(CUFormat.usd(group.subtotal))
                        .font(.system(size: 12, weight: .bold, design: .rounded).monospacedDigit())
                        .foregroundStyle(CUPalette.accentText(scheme))
                }
                .padding(.horizontal, 4).padding(.top, 4)
                VStack(spacing: 0) {
                    ForEach(group.items) { e in logRow(e) }
                }
                .padding(.horizontal, 14).padding(.vertical, 2)
                .cuGlass(scheme, corner: 18)
            }
        }
    }

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                ForEach(["সব", "Gemini", "Anthropic", "OpenRouter", "Voice", "Image", "ব্যর্থ"], id: \.self) { f in
                    let on = vm.logFilter == f
                    Button { vm.logFilter = f } label: {
                        Text(f).font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(on ? CUPalette.accentText(scheme) : .secondary)
                            .padding(.horizontal, 13).padding(.vertical, 7)
                            .background(on ? CUPalette.coral.opacity(0.16) : Color.primary.opacity(0.05), in: Capsule())
                            .overlay(Capsule().strokeBorder(on ? CUPalette.coral.opacity(0.4) : Color.clear, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 1)
        }
    }

    private var logStatTrio: some View {
        let today = vm.groupedEvents.first
        let failed = vm.events.filter { $0.ok == false }.count
        return HStack(spacing: 9) {
            statPill("আজকের ইভেন্ট", "\(today?.items.count ?? 0)")
            statPill("আজ খরচ", CUFormat.usd(today?.subtotal ?? 0))
            statPill("ব্যর্থ", "\(failed)")
        }
    }

    private func logRow(_ e: CULogEvent) -> some View {
        let tint = CUPalette.provider(e.provider)
        let isOpen = expanded.contains(e.id)
        return VStack(spacing: 0) {
            Button {
                if isOpen { expanded.remove(e.id) } else { expanded.insert(e.id) }
            } label: {
                HStack(spacing: 11) {
                    Image(systemName: CULabel.icon(kind: e.kind, provider: e.provider))
                        .font(.system(size: 14)).foregroundStyle(tint)
                        .frame(width: 33, height: 33)
                        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(e.model ?? CULabel.provider(e.provider))
                                .font(.system(size: 12.5, weight: .bold)).lineLimit(1)
                            Text(CULabel.roleTag(kind: e.kind))
                                .font(.system(size: 8.5, weight: .semibold))
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Color.primary.opacity(0.08), in: Capsule())
                                .foregroundStyle(.secondary)
                        }
                        HStack(spacing: 9) {
                            Text(CUFormat.time(e.occurredAt))
                            if let i = e.inputTokens, let o = e.outputTokens {
                                Text("↓\(CUFormat.tok(i)) ↑\(CUFormat.tok(o))")
                            }
                            if let ms = e.latencyMs { Text("⏱ \(CUFormat.ms(ms))") }
                        }
                        .font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(CUFormat.usd(e.costUsd))
                            .font(.system(size: 13.5, weight: .bold, design: .rounded).monospacedDigit())
                        if let ok = e.ok {
                            Label(ok ? "সফল" : "ব্যর্থ", systemImage: "circle.fill")
                                .font(.system(size: 8.5, weight: .semibold))
                                .foregroundStyle(ok ? CUPalette.emerald : CUPalette.red)
                        }
                    }
                }
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if isOpen { logDetail(e) }
            Divider().opacity(0.4)
        }
    }

    private func logDetail(_ e: CULogEvent) -> some View {
        let cols = [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)]
        return LazyVGrid(columns: cols, alignment: .leading, spacing: 9) {
            detailCell("Provider", CULabel.provider(e.provider))
            detailCell("Kind", e.kind.isEmpty ? "—" : e.kind)
            if let i = e.inputTokens { detailCell("Input", "\(i.formatted()) tok") }
            if let o = e.outputTokens { detailCell("Output", "\(o.formatted()) tok") }
            if let ms = e.latencyMs { detailCell("Latency", CUFormat.ms(ms)) }
            detailCell("Cost", CUFormat.usd(e.costUsd))
        }
        .padding(12)
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 13))
        .padding(.bottom, 8)
    }
    private func detailCell(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(k).font(.system(size: 9, weight: .semibold)).textCase(.uppercase).kerning(0.4).foregroundStyle(.tertiary)
            Text(v).font(.system(size: 12, weight: .semibold).monospacedDigit())
        }
    }

    // ── Custom date sheet ──
    private var customSheet: some View {
        NavigationStack {
            Form {
                DatePicker("শুরু", selection: $vm.customFrom, in: earliest...Date(), displayedComponents: .date)
                DatePicker("শেষ", selection: $vm.customTo, in: earliest...Date(), displayedComponents: .date)
            }
            .navigationTitle("কাস্টম রেঞ্জ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("প্রয়োগ") { vm.range = .custom; showCustomSheet = false }
                }
            }
        }
        .presentationDetents([.height(240)])
    }
    private var earliest: Date {
        Calendar.current.date(byAdding: .day, value: -29, to: Date()) ?? Date()
    }

    // ── Shared ──
    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }.frame(maxWidth: .infinity).padding(20).cuGlass(scheme, corner: 16)
    }
    private func errorCard(_ msg: String) -> some View {
        Label(msg, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(CUPalette.red)
            .frame(maxWidth: .infinity, alignment: .leading).padding(12).cuGlass(scheme, corner: 12)
    }
    private var loadingRows: some View {
        ForEach(0..<3, id: \.self) { _ in
            Color.clear.frame(height: 120).cuGlass(scheme, corner: 18).cuShimmer()
        }
    }
    private var webEscape: some View {
        Button { openWeb("/agent/costs", "Costs") } label: {
            Label("বাজেট কনফিগ / CSV — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote).frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain).foregroundStyle(.secondary).padding(.vertical, 6)
    }
}

// MARK: - Formatting

private enum CUFormat {
    static func usd(_ n: Double) -> String {
        let digits = (n < 0.01 && n > 0) ? 4 : 2
        return "$" + String(format: "%.\(digits)f", n)
    }
    static func tok(_ n: Int) -> String {
        if n >= 1000 { return String(format: "%.1fk", Double(n) / 1000) }
        return "\(n)"
    }
    static func ms(_ ms: Int) -> String {
        ms >= 1000 ? String(format: "%.1fs", Double(ms) / 1000) : "\(ms)ms"
    }
    static func ymd(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "Asia/Dhaka"); return f.string(from: d)
    }
    static func pretty(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "d MMM"; f.locale = Locale(identifier: "bn_BD")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka"); return f.string(from: d)
    }
    /// "2026-07-05" → "07-05"
    static func axis(_ ymd: String) -> String { ymd.count > 5 ? String(ymd.dropFirst(5)) : ymd }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
    private static func parse(_ s: String) -> Date? { iso.date(from: s) ?? isoPlain.date(from: s) }

    static func time(_ iso: String) -> String {
        guard let d = parse(iso) else { return "" }
        let f = DateFormatter(); f.dateFormat = "h:mm a"; f.locale = Locale(identifier: "bn_BD")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka"); return f.string(from: d)
    }
    /// Dhaka-day header key: আজ / গতকাল / "d MMM".
    static func dayKey(_ iso: String) -> String {
        guard let d = parse(iso) else { return "—" }
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "Asia/Dhaka")!
        if cal.isDateInToday(d) { return "আজ" }
        if cal.isDateInYesterday(d) { return "গতকাল" }
        let f = DateFormatter(); f.dateFormat = "d MMM"; f.locale = Locale(identifier: "bn_BD")
        f.timeZone = cal.timeZone; return f.string(from: d)
    }
}

// MARK: - Aurora + glass + helpers (page-owned copies — parallel-session rule)

@available(iOS 17.0, *)
private struct CUAurora: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ZStack {
            if scheme == .dark {
                LinearGradient(stops: [
                    .init(color: Color(red: 0.067, green: 0.067, blue: 0.169), location: 0.0),
                    .init(color: Color(red: 0.141, green: 0.102, blue: 0.271), location: 0.30),
                    .init(color: Color(red: 0.247, green: 0.137, blue: 0.322), location: 0.58),
                    .init(color: Color(red: 0.416, green: 0.184, blue: 0.251), location: 1.0),
                ], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [CUPalette.violet.opacity(0.28), .clear],
                               center: .init(x: 0.14, y: 0.10), startRadius: 10, endRadius: 420)
                RadialGradient(colors: [Color(red: 0.745, green: 0.329, blue: 0.431).opacity(0.22), .clear],
                               center: .init(x: 0.9, y: 0.92), startRadius: 20, endRadius: 470)
            } else {
                Color(red: 0.945, green: 0.937, blue: 0.969)
                LinearGradient(stops: [
                    .init(color: Color(red: 0.914, green: 0.894, blue: 0.961), location: 0.0),
                    .init(color: Color(red: 0.945, green: 0.937, blue: 0.969), location: 0.48),
                    .init(color: Color(red: 0.973, green: 0.925, blue: 0.933), location: 1.0),
                ], startPoint: .top, endPoint: .bottom)
            }
        }.ignoresSafeArea()
    }
}

@available(iOS 17.0, *)
private extension View {
    func cuGlass(_ s: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(s == .dark ? 0.03 : 0.4),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(s == .dark ? 0.08 : 0.5), lineWidth: 1))
    }
    func cuShimmer() -> some View { modifier(CUShimmer()) }
}

@available(iOS 17.0, *)
private struct CUShimmer: ViewModifier {
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        content.overlay(
            LinearGradient(colors: [.clear, .white.opacity(0.18), .clear], startPoint: .leading, endPoint: .trailing)
                .offset(x: phase * 320).clipped()
        ).onAppear { withAnimation(.linear(duration: 1.15).repeatForever(autoreverses: false)) { phase = 1.5 } }
    }
}

/// Gentle live-bar breathe for the "today" column.
@available(iOS 17.0, *)
private struct CUPulse: ViewModifier {
    @State private var on = false
    func body(content: Content) -> some View {
        content.overlay(
            Rectangle().fill(Color.white.opacity(on ? 0.16 : 0.0))
        )
        .onAppear { withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: true)) { on = true } }
    }
}

/// Minimal wrapping HStack for the legend (avoids clipping when providers are many).
private struct FlowRow: Layout {
    var spacing: CGFloat = 10
    var lineSpacing: CGFloat = 8
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
        var x: CGFloat = bounds.minX, y: CGFloat = bounds.minY, rowH: CGFloat = 0
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
