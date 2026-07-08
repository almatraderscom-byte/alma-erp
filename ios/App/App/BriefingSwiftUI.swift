//
//  BriefingSwiftUI.swift
//  ALMA ERP — the Morning Briefing as a native SwiftUI screen (read-only).
//
//  Mirrors the web /briefing page 1:1 — same endpoint, same blocks, same Bangla:
//    GET /api/briefing            → cached owner daily digest ({ ok, data: {…} })
//    GET /api/briefing?refresh=1  → forces a fresh tour (pull-to-refresh / ↻ chip)
//  Web-parity blocks: hero greeting (Dhaka-hour) · 4 KPI cards (yesterday sales /
//  7-day avg / pending orders / approvals) · আজকের করণীয় decision cards (area badge,
//  জরুরি chip, recommend →, 💡 knowledgeNote) · রিঅর্ডার দরকার · কাস্টমার অপেক্ষমাণ ·
//  স্টাফ (গতকাল) · রিটার্ন ও প্রাইসিং flags · আজকের অ্যাড · আপনার টু-ডু · agent footer.
//  iOS re-set: date header, SF-symbol section badges, comfortable Bangla line
//  spacing, long decision text clamps to ~6 lines with "আরো দেখুন" spring expand.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum BriefingPalette {
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

// MARK: - Lenient decode helpers

private func briefingFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
    return nil
}

private func briefingFlexDouble<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
    return nil
}

// MARK: - Models (structural — same fields the web Briefing type declares)

struct BriefingDecision: Decodable, Equatable {
    let area: String
    let urgency: String
    let text: String
    let recommend: String
    let knowledgeNote: String?

    private enum Keys: String, CodingKey { case area, urgency, text, recommend, knowledgeNote }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        area = (try? c.decode(String.self, forKey: .area)) ?? ""
        urgency = (try? c.decode(String.self, forKey: .urgency)) ?? "normal"
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        recommend = (try? c.decode(String.self, forKey: .recommend)) ?? ""
        knowledgeNote = try? c.decodeIfPresent(String.self, forKey: .knowledgeNote)
    }
}

struct BriefingReorder: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let reason: String
    let suggestedQty: Int
    let urgency: String

    private enum Keys: String, CodingKey { case id, name, reason, suggestedQty, urgency }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        reason = (try? c.decode(String.self, forKey: .reason)) ?? ""
        suggestedQty = briefingFlexInt(c, .suggestedQty) ?? 0
        urgency = (try? c.decode(String.self, forKey: .urgency)) ?? "normal"
    }
}

struct BriefingTodo: Decodable, Equatable {
    let title: String
    let priority: String?
    let ageDays: Int

    private enum Keys: String, CodingKey { case title, priority, ageDays }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        title = (try? c.decode(String.self, forKey: .title)) ?? "—"
        priority = try? c.decodeIfPresent(String.self, forKey: .priority)
        ageDays = briefingFlexInt(c, .ageDays) ?? 0
    }
}

struct BriefingData: Decodable {
    struct Sales: Decodable {
        let yesterdayTotal: Double
        let yesterdayOrders: Int
        let sevenDayAvg: Double
        let sevenDayOrderAvg: Double

        private enum Keys: String, CodingKey { case yesterdayTotal, yesterdayOrders, sevenDayAvg, sevenDayOrderAvg }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            yesterdayTotal = briefingFlexDouble(c, .yesterdayTotal) ?? 0
            yesterdayOrders = briefingFlexInt(c, .yesterdayOrders) ?? 0
            sevenDayAvg = briefingFlexDouble(c, .sevenDayAvg) ?? 0
            sevenDayOrderAvg = briefingFlexDouble(c, .sevenDayOrderAvg) ?? 0
        }
    }

    struct PendingOrders: Decodable {
        let count: Int
        let mismatch: Bool?

        private enum Keys: String, CodingKey { case count, mismatch }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            count = briefingFlexInt(c, .count) ?? 0
            mismatch = try? c.decodeIfPresent(Bool.self, forKey: .mismatch)
        }
    }

    struct CsWaiting: Decodable {
        let unrepliedCount: Int
        let nearWindowCount: Int
        let openAlerts: Int

        private enum Keys: String, CodingKey { case unrepliedCount, nearWindowCount, openAlerts }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            unrepliedCount = briefingFlexInt(c, .unrepliedCount) ?? 0
            nearWindowCount = briefingFlexInt(c, .nearWindowCount) ?? 0
            openAlerts = briefingFlexInt(c, .openAlerts) ?? 0
        }
        var hasAnything: Bool { unrepliedCount > 0 || nearWindowCount > 0 || openAlerts > 0 }
    }

    struct AdsCampaign: Decodable {
        let name: String
        let spend: Double
        let ctr: Double

        private enum Keys: String, CodingKey { case name, spend, ctr }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            name = (try? c.decode(String.self, forKey: .name)) ?? "—"
            spend = briefingFlexDouble(c, .spend) ?? 0
            ctr = briefingFlexDouble(c, .ctr) ?? 0
        }
    }

    struct AdsAnomaly: Decodable {
        let campaign: String
        let dropPct: Double

        private enum Keys: String, CodingKey { case campaign, dropPct }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            campaign = (try? c.decode(String.self, forKey: .campaign)) ?? "—"
            dropPct = briefingFlexDouble(c, .dropPct) ?? 0
        }
    }

    struct AdsDigest: Decodable {
        let campaigns: [AdsCampaign]
        let anomalies: [AdsAnomaly]

        private enum Keys: String, CodingKey { case campaigns, anomalies }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            campaigns = (try? c.decodeIfPresent([AdsCampaign].self, forKey: .campaigns)) ?? []
            anomalies = (try? c.decodeIfPresent([AdsAnomaly].self, forKey: .anomalies)) ?? []
        }
    }

    struct LowPerformer: Decodable {
        let name: String
        let pct: Int
        let daysLow: Int

        private enum Keys: String, CodingKey { case name, pct, daysLow }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            name = (try? c.decode(String.self, forKey: .name)) ?? "—"
            pct = briefingFlexInt(c, .pct) ?? 0
            daysLow = briefingFlexInt(c, .daysLow) ?? 0
        }
    }

    struct StaffYesterday: Decodable {
        let done: Int
        let total: Int
        let lowPerformers: [LowPerformer]

        private enum Keys: String, CodingKey { case done, total, lowPerformers }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            done = briefingFlexInt(c, .done) ?? 0
            total = briefingFlexInt(c, .total) ?? 0
            lowPerformers = (try? c.decodeIfPresent([LowPerformer].self, forKey: .lowPerformers)) ?? []
        }
    }

    struct Flags: Decodable {
        let flags: [String]
        private enum Keys: String, CodingKey { case flags }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            flags = (try? c.decodeIfPresent([String].self, forKey: .flags)) ?? []
        }
    }

    let sales: Sales?
    let pendingOrders: PendingOrders?
    let reorderSuggestions: [BriefingReorder]
    let csWaiting: CsWaiting?
    let adsDigest: AdsDigest?
    let staffYesterday: StaffYesterday?
    let returns: Flags?
    let pricing: Flags?
    let decisions: [BriefingDecision]
    let generatedAt: String?
    let pendingApprovalsCount: Int?
    let openTodos: [BriefingTodo]

    private enum Keys: String, CodingKey {
        case sales, pendingOrders, reorderSuggestions, csWaiting, adsDigest
        case staffYesterday, returns, pricing, decisions, generatedAt
        case pendingApprovalsCount, openTodos
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        sales = try? c.decodeIfPresent(Sales.self, forKey: .sales)
        pendingOrders = try? c.decodeIfPresent(PendingOrders.self, forKey: .pendingOrders)
        reorderSuggestions = (try? c.decodeIfPresent([BriefingReorder].self, forKey: .reorderSuggestions)) ?? []
        csWaiting = try? c.decodeIfPresent(CsWaiting.self, forKey: .csWaiting)
        adsDigest = try? c.decodeIfPresent(AdsDigest.self, forKey: .adsDigest)
        staffYesterday = try? c.decodeIfPresent(StaffYesterday.self, forKey: .staffYesterday)
        returns = try? c.decodeIfPresent(Flags.self, forKey: .returns)
        pricing = try? c.decodeIfPresent(Flags.self, forKey: .pricing)
        let raw = (try? c.decodeIfPresent([BriefingDecision].self, forKey: .decisions)) ?? []
        // Web ordering: high-urgency decisions first, then the rest (stable).
        decisions = raw.filter { $0.urgency == "high" } + raw.filter { $0.urgency != "high" }
        generatedAt = try? c.decodeIfPresent(String.self, forKey: .generatedAt)
        pendingApprovalsCount = briefingFlexInt(c, .pendingApprovalsCount)
        openTodos = (try? c.decodeIfPresent([BriefingTodo].self, forKey: .openTodos)) ?? []
    }
}

/// The briefing route wraps its payload via apiDataSuccess → `{ ok, data: {…} }` —
/// decode both the nested and flat shapes (same defensive pattern as approvals).
struct BriefingResponse: Decodable {
    let briefing: BriefingData

    private enum Keys: String, CodingKey { case ok, data }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        if let nested = try? root.decodeIfPresent(BriefingData.self, forKey: .data) {
            briefing = nested
        } else {
            briefing = try BriefingData(from: decoder)
        }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class BriefingVM {
    var data: BriefingData? = nil
    var loading = false
    var refreshing = false      // the web's "রিফ্রেশ হচ্ছে…" state (forces ?refresh=1)
    var error: String? = nil
    var authExpired = false

    func load(fresh: Bool = false) async {
        if fresh { refreshing = true } else { loading = true }
        error = nil
        defer { loading = false; refreshing = false }
        do {
            let resp: BriefingResponse = try await AlmaAPI.shared.get(
                "/api/briefing", query: fresh ? ["refresh": "1"] : [:])
            data = resp.briefing
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = "ব্রিফিং লোড করা গেল না"
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
struct BriefingScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = BriefingVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 14) {
                if vm.authExpired { authCard }
                if let err = vm.error, vm.data == nil { errorCard(err) }
                if vm.loading && vm.data == nil { loadingRows }
                if let data = vm.data { content(data) }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(BriefingAurora())
        .claudeTopFade()
        .refreshable { await vm.load(fresh: true) }
        .task { await vm.load() }
    }

    // ── Assembled briefing (web block order) ──

    @ViewBuilder private func content(_ data: BriefingData) -> some View {
        heroCard(data)
        kpiGrid(data)

        // Today's actions — the centerpiece.
        section(icon: "target", title: "আজকের করণীয়", count: data.decisions.count)
        if data.decisions.isEmpty {
            VStack(spacing: 5) {
                Text("সব শান্ত ✓").font(.subheadline.weight(.bold))
                Text("জরুরি কোনো সিদ্ধান্ত নেই — ব্যবসা স্বাভাবিক চলছে, Boss।")
                    .font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity).padding(22)
            .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        } else {
            ForEach(Array(data.decisions.enumerated()), id: \.offset) { _, d in
                BriefingDecisionCard(decision: d)
            }
        }

        // Reorder suggestions.
        if !data.reorderSuggestions.isEmpty {
            section(icon: "shippingbox.fill", title: "রিঅর্ডার দরকার",
                    count: data.reorderSuggestions.count,
                    linkTitle: "দেখুন →", linkAction: { openWeb("/inventory", "Inventory") })
            ForEach(data.reorderSuggestions.prefix(6)) { r in
                BriefingReorderCard(reorder: r)
            }
        }

        // CS waiting.
        if let cs = data.csWaiting, cs.hasAnything {
            section(icon: "bubble.left.and.bubble.right.fill", title: "কাস্টমার অপেক্ষমাণ")
            VStack(spacing: 10) {
                miniRow("অপেক্ষমাণ রিপ্লাই", "\(cs.unrepliedCount)",
                        tone: cs.unrepliedCount >= 5 ? .warn : .normal)
                miniRow("২৪ঘ window প্রায় শেষ", "\(cs.nearWindowCount)",
                        tone: cs.nearWindowCount > 0 ? .danger : .normal)
                miniRow("খোলা alert", "\(cs.openAlerts)",
                        tone: cs.openAlerts > 0 ? .warn : .normal)
            }
            .padding(14)
            .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }

        // Staff yesterday.
        if let staff = data.staffYesterday {
            section(icon: "person.2.fill", title: "স্টাফ (গতকাল)")
            VStack(alignment: .leading, spacing: 10) {
                miniRow("কাজ শেষ", "\(staff.done)/\(staff.total)", tone: .normal)
                if staff.lowPerformers.isEmpty {
                    Text("সবাই ভালো করছে ✓")
                        .font(.caption).foregroundStyle(BriefingPalette.emerald600)
                } else {
                    ForEach(Array(staff.lowPerformers.prefix(4).enumerated()), id: \.offset) { _, p in
                        HStack {
                            Text(p.name).font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Text("\(p.pct)% · \(p.daysLow) দিন কম")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(BriefingPalette.red500)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }

        // Returns & pricing flags.
        let flagLines = (data.returns?.flags ?? []) + (data.pricing?.flags ?? [])
        if !flagLines.isEmpty {
            section(icon: "arrow.uturn.backward", title: "রিটার্ন ও প্রাইসিং")
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(flagLines.enumerated()), id: \.offset) { _, f in
                    flagLine(f)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }

        // Ads digest.
        if let ads = data.adsDigest, !ads.campaigns.isEmpty {
            section(icon: "megaphone.fill", title: "আজকের অ্যাড")
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(ads.campaigns.prefix(4).enumerated()), id: \.offset) { _, c in
                    HStack(spacing: 8) {
                        Text(c.name).font(.caption).foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 4)
                        Text("\(BriefingFormat.tk(c.spend)) · CTR \(BriefingFormat.pct(c.ctr))%")
                            .font(.caption.monospaced())
                    }
                }
                ForEach(Array(ads.anomalies.prefix(2).enumerated()), id: \.offset) { _, a in
                    flagLine("\(a.campaign): CTR গড়ের \(BriefingFormat.pct(a.dropPct))% নিচে")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }

        // Todos.
        if !data.openTodos.isEmpty {
            section(icon: "checklist", title: "আপনার টু-ডু", count: data.openTodos.count)
            VStack(spacing: 0) {
                ForEach(Array(data.openTodos.prefix(8).enumerated()), id: \.offset) { i, t in
                    HStack(spacing: 10) {
                        Circle()
                            .fill(t.priority == "high" ? BriefingPalette.red500 : BriefingPalette.coral)
                            .frame(width: 6, height: 6)
                        Text(t.title).font(.caption).lineLimit(1)
                        Spacer(minLength: 4)
                        if t.ageDays >= 3 {
                            Text("\(t.ageDays) দিন")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(BriefingPalette.red500)
                        }
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    if i < min(data.openTodos.count, 8) - 1 {
                        Divider().opacity(0.4).padding(.leading, 30)
                    }
                }
            }
            .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }

        // Agent footer.
        Text("ব্রিফিং তৈরি করেছে ALMA Agent\(data.generatedAt != nil ? " · \(BriefingFormat.timeAgo(data.generatedAt))" : "")")
            .font(.caption2).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.top, 4)
    }

    // ── Hero greeting (web gold Card + Dhaka greeting) + native date header ──

    private func heroCard(_ data: BriefingData) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(BriefingFormat.greeting()), Boss")
                .font(.caption2.weight(.black))
                .tracking(1.6)
                .textCase(.uppercase)
                .foregroundStyle(BriefingPalette.accentText(colorScheme))
            Text("আজকের ব্যবসা ব্রিফিং")
                .font(.title3.weight(.black))
            Text(BriefingFormat.dhakaDateLine())
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text(heroMetaLine(data))
                    .font(.caption2).foregroundStyle(.secondary)
                Spacer()
                refreshChip
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .overlay(alignment: .topTrailing) {
            // The web hero's gold glow blob, clipped to the card.
            Circle()
                .fill(BriefingPalette.coral.opacity(0.12))
                .frame(width: 130, height: 130)
                .blur(radius: 30)
                .offset(x: 36, y: -44)
                .allowsHitTesting(false)
        }
        .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
    }

    private func heroMetaLine(_ data: BriefingData) -> String {
        var bits: [String] = []
        if let gen = data.generatedAt { bits.append("আপডেট: \(BriefingFormat.timeAgo(gen))") }
        bits.append(data.decisions.isEmpty ? "সব ঠিক আছে ✓" : "\(data.decisions.count)টি করণীয়")
        return bits.joined(separator: " · ")
    }

    /// The web header's gold "↻ রিফ্রেশ" button as a native capsule chip.
    private var refreshChip: some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            Task { await vm.load(fresh: true) }
        } label: {
            HStack(spacing: 5) {
                if vm.refreshing {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 10, weight: .semibold))
                }
                Text(vm.refreshing ? "রিফ্রেশ হচ্ছে…" : "রিফ্রেশ")
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(BriefingPalette.accentText(colorScheme))
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(BriefingPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14), in: Capsule())
            .overlay(Capsule().strokeBorder(BriefingPalette.coral.opacity(0.55), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(vm.refreshing)
    }

    // ── KPI grid (web: grid-cols-2 KpiCards, exact labels/colours) ──

    private func kpiGrid(_ data: BriefingData) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)],
                  spacing: 10) {
            kpiCard("গতকালের বিক্রি",
                    BriefingFormat.tk(data.sales?.yesterdayTotal ?? 0),
                    tint: BriefingPalette.goldLt,
                    sub: data.sales.map { "\($0.yesterdayOrders) অর্ডার" } ?? "ডেটা নেই")
            kpiCard("৭-দিন গড়/দিন",
                    BriefingFormat.tk(data.sales?.sevenDayAvg ?? 0),
                    tint: .primary,
                    sub: data.sales.map { "\(BriefingFormat.pct($0.sevenDayOrderAvg)) অর্ডার/দিন" } ?? "—")
            kpiCard("পেন্ডিং অর্ডার",
                    "\(data.pendingOrders?.count ?? 0)",
                    tint: (data.pendingOrders?.count ?? 0) >= 10 ? BriefingPalette.red500 : .primary,
                    sub: data.pendingOrders?.mismatch == true ? "⚠️ sync mismatch" : "অপেক্ষমাণ")
            kpiCard("অনুমোদন বাকি",
                    "\(data.pendingApprovalsCount ?? 0)",
                    tint: (data.pendingApprovalsCount ?? 0) > 0 ? BriefingPalette.goldLt : .primary,
                    sub: "approvals")
        }
    }

    private func kpiCard(_ label: String, _ value: String, tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.headline.weight(.bold)).foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.7)
            Text(sub).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Section header (SF-symbol badge + count capsule + optional link) ──

    private func section(icon: String, title: String, count: Int? = nil,
                         linkTitle: String? = nil, linkAction: (() -> Void)? = nil) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 26, height: 26)
                .background(
                    LinearGradient(colors: [BriefingPalette.coral, AlmaSwiftTheme.violet],
                                   startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .shadow(color: BriefingPalette.coral.opacity(0.30), radius: 4, y: 1)
            Text(title).font(.footnote.weight(.black))
            if let count, count > 0 {
                Text("\(count)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(BriefingPalette.accentText(colorScheme))
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(BriefingPalette.coral.opacity(0.14), in: Capsule())
            }
            Spacer()
            if let linkTitle, let linkAction {
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    linkAction()
                } label: {
                    Text(linkTitle)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(BriefingPalette.accentText(colorScheme))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.top, 6)
    }

    // ── Small shared rows ──

    private enum MiniTone { case normal, warn, danger }
    private func miniRow(_ label: String, _ value: String, tone: MiniTone) -> some View {
        let color: Color = switch tone {
        case .danger: BriefingPalette.red500
        case .warn: BriefingPalette.goldLt
        case .normal: .primary
        }
        return HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline.weight(.black).monospacedDigit())
                .foregroundStyle(color)
        }
    }

    private func flagLine(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text("▸")
                .font(.caption)
                .foregroundStyle(BriefingPalette.accentText(colorScheme))
            Text(text)
                .font(.caption)
                .lineSpacing(3)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // ── States ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        VStack(spacing: 10) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(BriefingPalette.red500)
            Button {
                Task { await vm.load(fresh: true) }
            } label: {
                Text("আবার চেষ্টা করুন")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(BriefingPalette.accentText(colorScheme))
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(BriefingPalette.coral.opacity(0.14), in: Capsule())
                    .overlay(Capsule().strokeBorder(BriefingPalette.coral.opacity(0.55), lineWidth: 1))
            }
            .buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity).padding(20)
        .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        Group {
            Color.clear.frame(height: 110)
                .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .briefingShimmer()
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)],
                      spacing: 10) {
                ForEach(0..<4, id: \.self) { _ in
                    Color.clear.frame(height: 78)
                        .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                        .briefingShimmer()
                }
            }
            ForEach(0..<3, id: \.self) { _ in
                Color.clear.frame(height: 96)
                    .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                    .briefingShimmer()
            }
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/briefing", "Briefing")
        } label: {
            Label("সম্পূর্ণ ব্রিফিং — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Decision card (web DecisionCard — area badge · জরুরি chip · text ·
// recommend → · 💡 knowledgeNote; long text clamps with "আরো দেখুন" spring expand)

@available(iOS 17.0, *)
private struct BriefingDecisionCard: View {
    let decision: BriefingDecision
    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded = false

    private var high: Bool { decision.urgency == "high" }
    /// Digest decisions can run long Bangla paragraphs — clamp unless expanded.
    private var isLong: Bool {
        (decision.text.count + decision.recommend.count + (decision.knowledgeNote?.count ?? 0)) > 320
    }

    /// Web AREA table — same Bangla labels, SF symbols instead of emoji.
    private var area: (icon: String, label: String) {
        switch decision.area {
        case "stock": ("shippingbox.fill", "স্টক")
        case "sales": ("banknote.fill", "বিক্রি")
        case "orders": ("cart.fill", "অর্ডার")
        case "customers": ("person.3.fill", "কাস্টমার")
        case "ads": ("megaphone.fill", "অ্যাড")
        case "staff": ("person.2.fill", "স্টাফ")
        case "returns": ("arrow.uturn.backward.circle.fill", "রিটার্ন")
        case "pricing": ("tag.fill", "প্রাইসিং")
        case "marketing": ("sparkles", "মার্কেটিং")
        default: ("circle.fill", decision.area)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: area.icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(high ? BriefingPalette.red500 : BriefingPalette.accentText(colorScheme))
                .frame(width: 34, height: 34)
                .background((high ? BriefingPalette.red500 : BriefingPalette.coral).opacity(0.13),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(area.label)
                        .font(.system(size: 10, weight: .black))
                        .tracking(1.0)
                        .textCase(.uppercase)
                        .foregroundStyle(.secondary)
                    if high {
                        Text("জরুরি")
                            .font(.system(size: 9, weight: .black))
                            .foregroundStyle(BriefingPalette.red500)
                            .padding(.horizontal, 6).padding(.vertical, 1.5)
                            .background(BriefingPalette.red500.opacity(0.13), in: Capsule())
                    }
                }
                body6Clamp
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(high ? BriefingPalette.red500.opacity(0.35) : .clear, lineWidth: 1))
    }

    /// Comfortable Bangla reading block, clamped to ~6 lines with a bottom fade;
    /// tapping "আরো দেখুন" springs the full brief open (AgentActionCard pattern).
    private var body6Clamp: some View {
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 6) {
                Text(decision.text)
                    .font(.footnote.weight(.semibold))
                    .lineSpacing(3.5)
                HStack(alignment: .top, spacing: 5) {
                    Text("→")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(BriefingPalette.accentText(colorScheme))
                    Text(decision.recommend)
                        .font(.caption)
                        .lineSpacing(3)
                        .foregroundStyle(BriefingPalette.accentText(colorScheme))
                }
                if let note = decision.knowledgeNote, !note.isEmpty {
                    Text("💡 \(note)")
                        .font(.caption2.italic())
                        .lineSpacing(2.5)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 9).padding(.vertical, 6)
                        .background(Color.primary.opacity(0.04),
                                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1))
                }
            }
            .lineLimit(expanded || !isLong ? nil : 6)
            .mask(
                // Fade the last clamped line so the cut reads intentional.
                VStack(spacing: 0) {
                    Rectangle()
                    if isLong && !expanded {
                        LinearGradient(colors: [.black, .clear],
                                       startPoint: .top, endPoint: .bottom)
                            .frame(height: 18)
                    }
                }
            )
            if isLong {
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    withAnimation(.spring(duration: 0.35, bounce: 0.15)) { expanded.toggle() }
                } label: {
                    HStack(spacing: 3) {
                        Text(expanded ? "কম দেখান" : "আরো দেখুন")
                        Image(systemName: "chevron.down")
                            .rotationEffect(.degrees(expanded ? 180 : 0))
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(BriefingPalette.accentText(colorScheme))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Reorder card (web reorder Card — জরুরি/শীঘ্রই chip + reason + qty)

@available(iOS 17.0, *)
private struct BriefingReorderCard: View {
    let reorder: BriefingReorder
    @Environment(\.colorScheme) private var colorScheme

    private var high: Bool { reorder.urgency == "high" }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Text(reorder.name).font(.subheadline.weight(.bold))
                Spacer(minLength: 4)
                Text(high ? "জরুরি" : "শীঘ্রই")
                    .font(.system(size: 10, weight: .black))
                    .foregroundStyle(high ? BriefingPalette.red500 : BriefingPalette.goldLt)
                    .padding(.horizontal, 8).padding(.vertical, 2.5)
                    .background((high ? BriefingPalette.red500 : BriefingPalette.coral).opacity(0.13),
                                in: Capsule())
            }
            if !reorder.reason.isEmpty {
                Text(reorder.reason)
                    .font(.caption)
                    .lineSpacing(3)
                    .foregroundStyle(.secondary)
            }
            Text("~\(reorder.suggestedQty)টি রিঅর্ডার করুন")
                .font(.caption.weight(.bold))
                .foregroundStyle(BriefingPalette.accentText(colorScheme))
                .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .briefingGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(high ? BriefingPalette.red500.opacity(0.35) : .clear, lineWidth: 1))
    }
}

// MARK: - Formatting helpers (web util parity)

private enum BriefingFormat {
    /// Web tk(): `৳` + whole-taka with en-BD thousands separators.
    static func tk(_ n: Double?) -> String {
        "৳\(Int((n ?? 0).rounded()).formatted())"
    }

    /// Compact numeric text for CTR / averages — trims trailing zeros ("2.5", "3").
    static func pct(_ n: Double) -> String {
        n == n.rounded() ? "\(Int(n))" : String(format: "%.1f", n)
    }

    /// Web greeting(): Dhaka-hour greeting for the owner — exact strings.
    static func greeting(now: Date = Date()) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        let h = cal.component(.hour, from: now)
        if h < 12 { return "শুভ সকাল" }
        if h < 17 { return "শুভ অপরাহ্ন" }
        if h < 20 { return "শুভ সন্ধ্যা" }
        return "শুভ রাত্রি"
    }

    /// Native date header — today in Bangla, Dhaka time ("সোমবার, ৬ জুলাই ২০২৬").
    static func dhakaDateLine(now: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "bn_BD")
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        f.dateFormat = "EEEE, d MMMM yyyy"
        return f.string(from: now)
    }

    /// Web relTime() — exact Bangla strings.
    static func timeAgo(_ iso: String?) -> String {
        guard let iso, let date = parse(iso) else { return "" }
        let mins = Int(Date().timeIntervalSince(date) / 60)
        if mins < 1 { return "এইমাত্র" }
        if mins < 60 { return "\(mins) মিনিট আগে" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs) ঘণ্টা আগে" }
        return "\(hrs / 24) দিন আগে"
    }

    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }
}

// MARK: - Aurora background + glass (Briefing-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct BriefingAurora: View {
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
    func briefingGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct BriefingShimmer: ViewModifier {
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
    func briefingShimmer() -> some View { modifier(BriefingShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Briefing — Light") {
    BriefingScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
