//
//  AgentCostsSwiftUI.swift
//  ALMA ERP — the agent AI-cost dashboard as a native SwiftUI screen (read-only).
//
//  Mirrors the web /agent/costs page (AgentCostsDashboard) — same endpoints, colours:
//    GET /api/assistant/costs/summary   → today/month/forecast USD, byModel, byProvider,
//                                         dailyLast30, budgets + pct, telegram totals
//    GET /api/assistant/costs/balances  → per-provider live balances + spend
//  Blocks: today/month hero cost cards ($ monospaced) · budget-cap indicator (amber
//  near cap, red over) · per-model breakdown with hand-rolled gradient bars · provider
//  split (this month) · 30-day day-history rows · API balance table. Budget CONFIG,
//  logs and CSV stay on the web — footer escape hatch opens /agent/costs.
//  Read-only by design: no PUT/POST from this screen.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / the dashboard's tokens)

private enum AgentCostPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    // Web PROVIDER_COLORS (recharts fills) — same hexes.
    static func provider(_ id: String) -> Color {
        switch id {
        case "anthropic": return coral                                       // #E07A5F
        case "openai": return Color(red: 0.506, green: 0.698, blue: 0.604)   // #81B29A
        case "openrouter": return Color(red: 0.655, green: 0.545, blue: 0.980) // #A78BFA
        case "gemini": return Color(red: 0.231, green: 0.510, blue: 0.965)   // #3B82F6
        case "google_tts": return Color(red: 0.545, green: 0.361, blue: 0.965) // #8B5CF6
        case "twilio": return Color(red: 0.831, green: 0.659, blue: 0.294)   // #D4A84B
        case "elevenlabs": return Color(red: 0.925, green: 0.282, blue: 0.600) // #EC4899
        case "veo": return Color(red: 0.055, green: 0.647, blue: 0.914)      // #0EA5E9
        default: return Color(red: 0.580, green: 0.639, blue: 0.722)         // #94a3b8
        }
    }

    /// Web MODEL_CHART_COLORS — deterministic cycle by index for the model bars.
    static let modelCycle: [Color] = [
        coral,                                                                // #E07A5F
        Color(red: 0.506, green: 0.698, blue: 0.604),                         // #81B29A
        Color(red: 0.655, green: 0.545, blue: 0.980),                         // #A78BFA
        Color(red: 0.231, green: 0.510, blue: 0.965),                         // #3B82F6
        Color(red: 0.831, green: 0.659, blue: 0.294),                         // #D4A84B
        Color(red: 0.925, green: 0.282, blue: 0.600),                         // #EC4899
        Color(red: 0.055, green: 0.647, blue: 0.914),                         // #0EA5E9
        Color(red: 0.063, green: 0.725, blue: 0.506),                         // #10B981
        amber500,                                                             // #F59E0B
        Color(red: 0.388, green: 0.400, blue: 0.945),                         // #6366F1
        Color(red: 0.580, green: 0.639, blue: 0.722),                         // #94a3b8
    ]
    static func model(_ index: Int) -> Color { modelCycle[index % modelCycle.count] }

    /// Web balanceColor(): <$1 red · <$5 amber · else green · Free green.
    static func balance(_ usd: Double?, free: Bool) -> Color {
        if free { return emerald600 }
        guard let usd else { return .secondary }
        if usd < 1 { return red500 }
        if usd < 5 { return amber500 }
        return emerald600
    }

    /// Budget bar/label tone: ≥100% red (over cap) · ≥80% amber (near cap).
    static func budget(_ pct: Double) -> Color {
        if pct >= 100 { return red500 }
        if pct >= 80 { return amber600 }
        return .primary
    }

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Flexible decoding (costs are USD decimals; API mixes number/string shapes)

enum AgentCostFlex {
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

// MARK: - Models (same field names the web DashboardData type declares)

/// One row of dailyLast30 — the web row also carries per-provider keys; the native
/// day-history only needs date + total (unknown keys are ignored by keyed decoding).
struct AgentCostDayPoint: Decodable, Identifiable, Equatable {
    let date: String
    let total: Double
    var id: String { date }

    private enum Keys: String, CodingKey { case date, total }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        date = (try? c.decode(String.self, forKey: .date)) ?? ""
        total = AgentCostFlex.double(c, .total) ?? 0
    }
}

struct AgentCostModelRow: Decodable, Identifiable, Equatable {
    let modelId: String
    let label: String
    let provider: String
    let monthUsd: Double
    let todayUsd: Double
    var id: String { modelId }

    private enum Keys: String, CodingKey { case modelId, label, provider, monthUsd, todayUsd }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        modelId = (try? c.decode(String.self, forKey: .modelId)) ?? ""
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? modelId
        provider = (try? c.decodeIfPresent(String.self, forKey: .provider)) ?? ""
        monthUsd = AgentCostFlex.double(c, .monthUsd) ?? 0
        todayUsd = AgentCostFlex.double(c, .todayUsd) ?? 0
    }
}

struct AgentCostProviderRow: Decodable, Identifiable, Equatable {
    let provider: String
    let totalUsd: Double
    var id: String { provider }

    private enum Keys: String, CodingKey { case provider, totalUsd }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        provider = (try? c.decode(String.self, forKey: .provider)) ?? ""
        totalUsd = AgentCostFlex.double(c, .totalUsd) ?? 0
    }
}

struct AgentCostBudgets: Decodable, Equatable {
    let dailyUsd: Double?
    let monthlyUsd: Double?

    private enum Keys: String, CodingKey { case dailyUsd, monthlyUsd }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        dailyUsd = AgentCostFlex.double(c, .dailyUsd)
        monthlyUsd = AgentCostFlex.double(c, .monthlyUsd)
    }
    init() { dailyUsd = nil; monthlyUsd = nil }
}

/// GET /api/assistant/costs/summary — served flat (no {ok,data} wrapper).
struct AgentCostsSummary: Decodable {
    let todayDhakaDate: String?
    let todayUsd: Double
    let todayOxylabsCredits: Double?
    let monthUsd: Double
    let forecastUsd: Double
    let subscriptionAmortMonthUsd: Double?
    let dailyLast30: [AgentCostDayPoint]
    let byProvider: [AgentCostProviderRow]
    let byModel: [AgentCostModelRow]
    let telegramTodayUsd: Double?
    let telegramMonthUsd: Double?
    let budgets: AgentCostBudgets
    let dailyBudgetPct: Double?
    let monthlyBudgetPct: Double?

    private enum Keys: String, CodingKey {
        case todayDhakaDate, todayUsd, todayOxylabsCredits, monthUsd, forecastUsd
        case subscriptionAmortMonthUsd, dailyLast30, byProvider, byModel
        case telegramTodayUsd, telegramMonthUsd, budgets, dailyBudgetPct, monthlyBudgetPct
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        todayDhakaDate = try? c.decodeIfPresent(String.self, forKey: .todayDhakaDate)
        todayUsd = AgentCostFlex.double(c, .todayUsd) ?? 0
        todayOxylabsCredits = AgentCostFlex.double(c, .todayOxylabsCredits)
        monthUsd = AgentCostFlex.double(c, .monthUsd) ?? 0
        forecastUsd = AgentCostFlex.double(c, .forecastUsd) ?? 0
        subscriptionAmortMonthUsd = AgentCostFlex.double(c, .subscriptionAmortMonthUsd)
        dailyLast30 = (try? c.decodeIfPresent([AgentCostDayPoint].self, forKey: .dailyLast30)) ?? []
        byProvider = (try? c.decodeIfPresent([AgentCostProviderRow].self, forKey: .byProvider)) ?? []
        byModel = (try? c.decodeIfPresent([AgentCostModelRow].self, forKey: .byModel)) ?? []
        telegramTodayUsd = AgentCostFlex.double(c, .telegramTodayUsd)
        telegramMonthUsd = AgentCostFlex.double(c, .telegramMonthUsd)
        budgets = (try? c.decodeIfPresent(AgentCostBudgets.self, forKey: .budgets)) ?? AgentCostBudgets()
        dailyBudgetPct = AgentCostFlex.double(c, .dailyBudgetPct)
        monthlyBudgetPct = AgentCostFlex.double(c, .monthlyBudgetPct)
    }
}

struct AgentCostBalanceRow: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let balanceUsd: Double?
    let todayUsd: Double?
    let monthUsd: Double?
    let source: String?
    let free: Bool
    let syncedThrough: String?

    private enum Keys: String, CodingKey {
        case id, label, balanceUsd, todayUsd, monthUsd, source, free, syncedThrough
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? id
        balanceUsd = AgentCostFlex.double(c, .balanceUsd)
        todayUsd = AgentCostFlex.double(c, .todayUsd)
        monthUsd = AgentCostFlex.double(c, .monthUsd)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        free = (try? c.decodeIfPresent(Bool.self, forKey: .free)) ?? false
        syncedThrough = try? c.decodeIfPresent(String.self, forKey: .syncedThrough)
    }
}

/// GET /api/assistant/costs/balances — also flat.
struct AgentCostsBalances: Decodable {
    let checkedAt: String?
    let providers: [AgentCostBalanceRow]
    let summaryLine: String?

    private enum Keys: String, CodingKey { case checkedAt, providers, summaryLine }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        checkedAt = try? c.decodeIfPresent(String.self, forKey: .checkedAt)
        providers = (try? c.decodeIfPresent([AgentCostBalanceRow].self, forKey: .providers)) ?? []
        summaryLine = try? c.decodeIfPresent(String.self, forKey: .summaryLine)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class AgentCostsVM {
    var summary: AgentCostsSummary? = nil
    var balances: AgentCostsBalances? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let s: AgentCostsSummary = try await AlmaAPI.shared.get("/api/assistant/costs/summary")
            summary = s
            authExpired = false
            // Balances are best-effort — the web page also renders without them.
            if let b: AgentCostsBalances = try? await AlmaAPI.shared.get("/api/assistant/costs/balances") {
                balances = b
            }
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
}

// MARK: - Screen

@available(iOS 17.0, *)
struct AgentCostsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = AgentCostsVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.summary == nil { loadingRows }
                if let s = vm.summary {
                    heroCards(s)
                    if let bar = budgetCard(s) { bar }
                    if !s.byModel.isEmpty { modelBreakdown(s) }
                    if !s.byProvider.isEmpty { providerBreakdown(s) }
                    if !s.dailyLast30.isEmpty { dayHistory(s) }
                }
                if let b = vm.balances, !b.providers.isEmpty { balancesCard(b) }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(AgentCostsAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    // ── Hero cost cards (আজ / এই মাস / পূর্বাভাস) — big monospaced dollars ──

    private func heroCards(_ s: AgentCostsSummary) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                heroCard(
                    label: s.todayDhakaDate.map { "আজ (Dhaka \($0))" } ?? "আজ (USD API)",
                    value: AgentCostFormat.usd(s.todayUsd),
                    sub: "Anthropic/Twilio/OpenAI ইত্যাদি — Oxylabs বাদ",
                    tint: AgentCostPalette.accentText(colorScheme))
                heroCard(
                    label: "এই মাস",
                    value: AgentCostFormat.usd(s.monthUsd),
                    sub: s.subscriptionAmortMonthUsd.map { "+ সাবস্ক্রিপশন \(AgentCostFormat.usd($0))" },
                    tint: .primary)
            }
            HStack(spacing: 10) {
                smallStat("পূর্বাভাস (মাস)", AgentCostFormat.usd(s.forecastUsd))
                smallStat("Oxylabs আজ",
                          "\(Int((s.todayOxylabsCredits ?? 0).rounded())) ক্রেডিট",
                          sub: "Prepaid credit — USD নয়")
            }
            if let tToday = s.telegramTodayUsd, let tMonth = s.telegramMonthUsd {
                Text("📱 Telegram — আজ \(AgentCostFormat.usd(tToday)) · এই মাসে \(AgentCostFormat.usd(tMonth))")
                    .font(.caption2).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 2)
            }
        }
    }

    private func heroCard(label: String, value: String, sub: String?, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption2.weight(.semibold)).textCase(.uppercase)
                .foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(value)
                .font(.system(size: 26, weight: .bold, design: .rounded).monospacedDigit())
                .foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.6)
            if let sub {
                Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .agentCostsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func smallStat(_ label: String, _ value: String, sub: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(value)
                .font(.headline.weight(.bold).monospacedDigit())
                .lineLimit(1).minimumScaleFactor(0.6)
            if let sub {
                Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .agentCostsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Budget-cap indicator (read-only; config lives on the web) ──

    private func budgetCard(_ s: AgentCostsSummary) -> AnyView? {
        let hasDaily = s.dailyBudgetPct != nil && s.budgets.dailyUsd != nil
        let hasMonthly = s.monthlyBudgetPct != nil && s.budgets.monthlyUsd != nil
        guard hasDaily || hasMonthly else { return nil }
        return AnyView(
            VStack(alignment: .leading, spacing: 10) {
                Text("বাজেট সতর্কতা (USD)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AgentCostPalette.accentText(colorScheme))
                if hasDaily, let pct = s.dailyBudgetPct, let cap = s.budgets.dailyUsd {
                    budgetRow("আজকের বাজেট ব্যবহার", pct: pct, spent: s.todayUsd, cap: cap)
                }
                if hasMonthly, let pct = s.monthlyBudgetPct, let cap = s.budgets.monthlyUsd {
                    budgetRow("মাসিক বাজেট ব্যবহার", pct: pct, spent: s.monthUsd, cap: cap)
                }
                Text("৮০% → Tier 1 সতর্কতা | ১০০% → Tier 2 critical")
                    .font(.system(size: 9)).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .agentCostsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        )
    }

    private func budgetRow(_ label: String, pct: Double, spent: Double, cap: Double) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label).font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Text("\(Int(pct.rounded()))% (\(AgentCostFormat.usd(spent)) / \(AgentCostFormat.usd(cap)))")
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(AgentCostPalette.budget(pct))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.06))
                    Capsule()
                        .fill(barGradient(pct))
                        .frame(width: max(geo.size.width * min(pct, 100) / 100, pct > 0 ? 4 : 0))
                }
            }
            .frame(height: 6)
            .animation(.spring(duration: 0.5, bounce: 0.1), value: pct)
        }
    }

    /// Web bar gradients: ≥100% red-500→red-400 · ≥80% amber-500→amber-400 ·
    /// else coral #E07A5F → gold #D4A84B.
    private func barGradient(_ pct: Double) -> LinearGradient {
        if pct >= 100 {
            return LinearGradient(colors: [AgentCostPalette.red500,
                                           Color(red: 0.973, green: 0.443, blue: 0.443)],
                                  startPoint: .leading, endPoint: .trailing)
        }
        if pct >= 80 {
            return LinearGradient(colors: [AgentCostPalette.amber500,
                                           Color(red: 0.984, green: 0.749, blue: 0.141)],
                                  startPoint: .leading, endPoint: .trailing)
        }
        return LinearGradient(colors: [AgentCostPalette.coral,
                                       Color(red: 0.831, green: 0.659, blue: 0.294)],
                              startPoint: .leading, endPoint: .trailing)
    }

    // ── Per-model breakdown — hand-rolled horizontal gradient bars ──

    private func modelBreakdown(_ s: AgentCostsSummary) -> some View {
        let maxMonth = max(s.byModel.map(\.monthUsd).max() ?? 0, 0.0001)
        return VStack(alignment: .leading, spacing: 10) {
            Text("🤖 মডেল অনুযায়ী খরচ (প্রতিটি API key আলাদা)")
                .font(.caption.weight(.bold))
                .foregroundStyle(AgentCostPalette.accentText(colorScheme))
            Text("কোন মডেল কত খরচ করল — আজ ও এই মাসে")
                .font(.system(size: 9)).foregroundStyle(.secondary)
            ForEach(Array(s.byModel.enumerated()), id: \.element.id) { idx, m in
                modelRow(m, index: idx, fraction: m.monthUsd / maxMonth)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .agentCostsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func modelRow(_ m: AgentCostModelRow, index: Int, fraction: Double) -> some View {
        let tint = AgentCostPalette.model(index)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(tint).frame(width: 7, height: 7)
                Text(m.label)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1).minimumScaleFactor(0.75)
                Text(AgentCostFormat.providerLabel(m.provider))
                    .font(.system(size: 9)).foregroundStyle(.secondary)
                Spacer()
                Text("আজ \(AgentCostFormat.usd(m.todayUsd))")
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                Text(AgentCostFormat.usd(m.monthUsd))
                    .font(.caption2.weight(.bold).monospacedDigit())
                    .foregroundStyle(AgentCostPalette.accentText(colorScheme))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.05))
                    Capsule()
                        .fill(LinearGradient(colors: [tint.opacity(0.55), tint],
                                             startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(geo.size.width * fraction, m.monthUsd > 0 ? 4 : 0))
                }
            }
            .frame(height: 7)
        }
    }

    // ── Provider split (এই মাস) — the web pie, re-set as gradient bars ──

    private func providerBreakdown(_ s: AgentCostsSummary) -> some View {
        let sorted = s.byProvider.sorted { $0.totalUsd > $1.totalUsd }
        let maxUsd = max(sorted.map(\.totalUsd).max() ?? 0, 0.0001)
        return VStack(alignment: .leading, spacing: 10) {
            Text("প্রোভাইডার (এই মাস)")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary)
            ForEach(sorted) { p in
                let tint = AgentCostPalette.provider(p.provider)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Circle().fill(tint).frame(width: 7, height: 7)
                        Text(AgentCostFormat.providerLabel(p.provider))
                            .font(.caption.weight(.semibold))
                        Spacer()
                        Text(AgentCostFormat.usd(p.totalUsd))
                            .font(.caption2.weight(.bold).monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Color.primary.opacity(0.05))
                            Capsule()
                                .fill(LinearGradient(colors: [tint.opacity(0.55), tint],
                                                     startPoint: .leading, endPoint: .trailing))
                                .frame(width: max(geo.size.width * p.totalUsd / maxUsd,
                                                  p.totalUsd > 0 ? 4 : 0))
                        }
                    }
                    .frame(height: 7)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .agentCostsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Day-history rows (দৈনিক খরচ — ৩০ দিন), newest first ──

    private func dayHistory(_ s: AgentCostsSummary) -> some View {
        let days = s.dailyLast30.reversed()
        let maxTotal = max(s.dailyLast30.map(\.total).max() ?? 0, 0.0001)
        return VStack(alignment: .leading, spacing: 8) {
            Text("দৈনিক খরচ (৩০ দিন)")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary)
            if s.dailyLast30.allSatisfy({ $0.total == 0 }) {
                Text("এখনো কোনো ইভেন্ট নেই")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 20)
            } else {
                ForEach(Array(days)) { d in
                    HStack(spacing: 10) {
                        Text(AgentCostFormat.dayLabel(d.date))
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(width: 44, alignment: .leading)
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule().fill(Color.primary.opacity(0.05))
                                Capsule()
                                    .fill(LinearGradient(colors: [AgentCostPalette.goldLt,
                                                                  AgentCostPalette.coral],
                                                         startPoint: .leading, endPoint: .trailing))
                                    .frame(width: max(geo.size.width * d.total / maxTotal,
                                                      d.total > 0 ? 3 : 0))
                            }
                        }
                        .frame(height: 6)
                        Text(AgentCostFormat.usd(d.total))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(d.total > 0 ? .primary : .secondary)
                            .frame(width: 58, alignment: .trailing)
                    }
                    .frame(height: 16)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .agentCostsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── API balances (💳 API ব্যালেন্স) — read-only table ──

    private func balancesCard(_ b: AgentCostsBalances) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("💳 API ব্যালেন্স")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AgentCostPalette.accentText(colorScheme))
                Spacer()
                if let checked = AgentCostFormat.checkedAt(b.checkedAt) {
                    Text("শেষ চেক: \(checked)")
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                }
            }
            ForEach(b.providers) { row in
                balanceRow(row)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .agentCostsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func balanceRow(_ row: AgentCostBalanceRow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Circle().fill(AgentCostPalette.provider(row.id)).frame(width: 7, height: 7)
                Text(row.label).font(.caption.weight(.semibold))
                if row.free {
                    Text("Free")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(AgentCostPalette.emerald600)
                        .padding(.horizontal, 5).padding(.vertical, 1.5)
                        .background(AgentCostPalette.emerald600.opacity(0.10), in: Capsule())
                        .overlay(Capsule().strokeBorder(
                            AgentCostPalette.emerald600.opacity(0.30), lineWidth: 0.8))
                }
                Spacer()
                Text(row.free ? "Free" : (row.balanceUsd.map { AgentCostFormat.usd($0) } ?? "—"))
                    .font(.caption.weight(.bold).monospacedDigit())
                    .foregroundStyle(AgentCostPalette.balance(row.balanceUsd, free: row.free))
            }
            HStack(spacing: 8) {
                Text("আজ খরচ \(AgentCostFormat.spend(row.todayUsd, providerId: row.id))")
                Text("· এই মাসে \(AgentCostFormat.spend(row.monthUsd, providerId: row.id))")
                Spacer()
                if let synced = row.syncedThrough {
                    Text("⏳ \(synced) পর্যন্ত sync")
                        .foregroundStyle(AgentCostPalette.amber600)
                }
            }
            .font(.system(size: 9).monospacedDigit())
            .foregroundStyle(.secondary)
            .padding(.leading, 13)
        }
        .padding(.vertical, 3)
    }

    // ── Shared bits ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .agentCostsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        VStack(spacing: 8) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(AgentCostPalette.red500)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                Task { await vm.load() }
            } label: {
                Text("আবার চেষ্টা")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AgentCostPalette.accentText(colorScheme))
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(AgentCostPalette.coral.opacity(0.13), in: Capsule())
                    .overlay(Capsule().strokeBorder(AgentCostPalette.coral.opacity(0.35), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12).agentCostsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 110)
                .agentCostsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .agentCostsShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/agent/costs", "Costs")
        } label: {
            Label("সব অপশন (বাজেট/লগ/CSV সহ) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Formatting helpers (web util parity)

private enum AgentCostFormat {
    /// Web fmtUsd: 2 decimals; 4 when 0 < n < $0.01 (sub-cent API events).
    static func usd(_ n: Double) -> String {
        let digits = (n < 0.01 && n > 0) ? 4 : 2
        return "$" + String(format: "%.\(digits)f", n)
    }

    /// Web fmtSpendCell: Oxylabs shows prepaid credits, everything else USD.
    static func spend(_ n: Double?, providerId: String) -> String {
        guard let n else { return "—" }
        if providerId == "oxylabs" { return "\(Int(n.rounded())) ক্রেডিট" }
        return usd(n)
    }

    /// Web PROVIDER_LABELS.
    static func providerLabel(_ id: String) -> String {
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
        default: return id
        }
    }

    /// "2026-07-05" → "07-05" (the web slices off the year the same way).
    static func dayLabel(_ ymd: String) -> String {
        ymd.count > 5 ? String(ymd.dropFirst(5)) : ymd
    }

    /// checkedAt ISO → Dhaka-time short stamp (web fmtCheckedAt, bn-BD).
    static func checkedAt(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "bn_BD")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        f.dateStyle = .medium
        f.timeStyle = .short
        return f.string(from: date)
    }

    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }
}

// MARK: - Aurora background + glass (AgentCosts-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct AgentCostsAurora: View {
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
    func agentCostsGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct AgentCostsShimmer: ViewModifier {
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
    func agentCostsShimmer() -> some View { modifier(AgentCostsShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Agent Costs — Light") {
    AgentCostsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
