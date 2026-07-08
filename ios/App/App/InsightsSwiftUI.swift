//
//  InsightsSwiftUI.swift
//  ALMA ERP — the Business Insights page as a native SwiftUI screen.
//
//  Mirrors the web /insights page 1:1 — same endpoint, same blocks:
//    GET /api/insights            → cached analyzer bundle (apiDataSuccess → { ok, data })
//    GET /api/insights?refresh=1  → recompute fresh
//  Web-parity blocks: ফিনান্সিয়াল হেলথ (৪ KPI + WoW trends + flags + টপ প্রোডাক্ট) ·
//  রিঅর্ডার দরকার · স্লো-মুভিং স্টক · কাস্টমার ইন্টেলিজেন্স (৩ KPI + ফিরিয়ে আনুন +
//  টপ VIP + notes). Read-only screen — every action escapes to the web page.
//  iOS re-set: severity-tinted SF Symbol badges (info=violet · warn=amber ·
//  critical=red · good=emerald), 5-line clamp + spring expand on long text,
//  customer detail sheet.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum InsightPalette {
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

/// Severity tint + SF Symbol per insight card class.
private enum InsightSeverity {
    case info, warn, critical, good

    var tint: Color {
        switch self {
        case .info: return AlmaSwiftTheme.violet
        case .warn: return InsightPalette.amber600
        case .critical: return InsightPalette.red500
        case .good: return InsightPalette.emerald600
        }
    }

    var icon: String {
        switch self {
        case .info: return "info.circle.fill"
        case .warn: return "exclamationmark.triangle.fill"
        case .critical: return "exclamationmark.octagon.fill"
        case .good: return "checkmark.seal.fill"
        }
    }
}

// MARK: - Lenient number decoding (API mixes Int/Double/String)

private enum InsightFlex {
    static func int<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
    static func double<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
        return nil
    }
}

// MARK: - Models (same field names the web page types declare)

struct InsightReorderItem: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let currentStock: Int
    let daysOfStock: Double
    let suggestedQty: Int
    let urgency: String            // "high" | "normal"
    let reason: String

    private enum Keys: String, CodingKey {
        case id, name, currentStock, daysOfStock, suggestedQty, urgency, reason
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        currentStock = InsightFlex.int(c, .currentStock) ?? 0
        daysOfStock = InsightFlex.double(c, .daysOfStock) ?? 0
        suggestedQty = InsightFlex.int(c, .suggestedQty) ?? 0
        urgency = (try? c.decode(String.self, forKey: .urgency)) ?? "normal"
        reason = (try? c.decode(String.self, forKey: .reason)) ?? ""
    }
}

struct InsightSlowMover: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let currentStock: Int
    let sales90d: Int

    private enum Keys: String, CodingKey { case id, name, currentStock, sales90d }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        currentStock = InsightFlex.int(c, .currentStock) ?? 0
        sales90d = InsightFlex.int(c, .sales90d) ?? 0
    }
}

struct InsightTopProduct: Decodable, Equatable {
    let product: String
    let revenue: Double
    let units: Int
    let marginPct: Double?
    let flag: String?

    private enum Keys: String, CodingKey { case product, revenue, units, marginPct, flag }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        product = (try? c.decode(String.self, forKey: .product)) ?? "—"
        revenue = InsightFlex.double(c, .revenue) ?? 0
        units = InsightFlex.int(c, .units) ?? 0
        marginPct = InsightFlex.double(c, .marginPct)
        flag = try? c.decodeIfPresent(String.self, forKey: .flag)
    }
}

struct InsightCustomer: Decodable, Identifiable, Equatable {
    let id: String
    let name: String?
    let phone: String?
    let ordersCount: Int
    let churnRisk: String          // "low" | "medium" | "high"
    let tier: String               // "vip" | "regular" | "occasional" | "new"
    let daysSinceLast: Int?
    let estimatedClv: Double?
    let engagementSuggestion: String
    let clvNote: String?

    private enum Keys: String, CodingKey {
        case id, name, phone, ordersCount, churnRisk, tier
        case daysSinceLast, estimatedClv, engagementSuggestion, clvNote
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        ordersCount = InsightFlex.int(c, .ordersCount) ?? 0
        churnRisk = (try? c.decode(String.self, forKey: .churnRisk)) ?? "low"
        tier = (try? c.decode(String.self, forKey: .tier)) ?? "regular"
        daysSinceLast = InsightFlex.int(c, .daysSinceLast)
        estimatedClv = InsightFlex.double(c, .estimatedClv)
        engagementSuggestion = (try? c.decode(String.self, forKey: .engagementSuggestion)) ?? ""
        clvNote = try? c.decodeIfPresent(String.self, forKey: .clvNote)
    }
}

struct InsightFinance: Decodable, Equatable {
    let period: String?
    let revenue: Double
    let expensesTotal: Double
    let adSpend: Double
    let grossProfit: Double?
    let netProfit: Double?
    let marginPct: Double?
    let revenueWoW: Double?
    let expenseWoW: Double?
    let flags: [String]
    let costDataMissing: Bool
    let topProducts: [InsightTopProduct]

    private enum Keys: String, CodingKey {
        case period, revenue, expensesTotal, adSpend, grossProfit, netProfit, marginPct
        case revenueWoW, expenseWoW, flags, costDataMissing, topProducts
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        period = try? c.decodeIfPresent(String.self, forKey: .period)
        revenue = InsightFlex.double(c, .revenue) ?? 0
        expensesTotal = InsightFlex.double(c, .expensesTotal) ?? 0
        adSpend = InsightFlex.double(c, .adSpend) ?? 0
        grossProfit = InsightFlex.double(c, .grossProfit)
        netProfit = InsightFlex.double(c, .netProfit)
        marginPct = InsightFlex.double(c, .marginPct)
        revenueWoW = InsightFlex.double(c, .revenueWoW)
        expenseWoW = InsightFlex.double(c, .expenseWoW)
        flags = (try? c.decode([String].self, forKey: .flags)) ?? []
        costDataMissing = (try? c.decode(Bool.self, forKey: .costDataMissing)) ?? false
        topProducts = (try? c.decode([InsightTopProduct].self, forKey: .topProducts)) ?? []
    }
}

struct InsightCustomerDigest: Decodable, Equatable {
    let vipCount: Int
    let highChurnCount: Int
    let newThisWeekCount: Int
    let highChurn: [InsightCustomer]
    let topVips: [InsightCustomer]
    let notes: [String]

    private enum Keys: String, CodingKey {
        case vipCount, highChurnCount, newThisWeekCount, highChurn, topVips, notes
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        vipCount = InsightFlex.int(c, .vipCount) ?? 0
        highChurnCount = InsightFlex.int(c, .highChurnCount) ?? 0
        newThisWeekCount = InsightFlex.int(c, .newThisWeekCount) ?? 0
        highChurn = (try? c.decode([InsightCustomer].self, forKey: .highChurn)) ?? []
        topVips = (try? c.decode([InsightCustomer].self, forKey: .topVips)) ?? []
        notes = (try? c.decode([String].self, forKey: .notes)) ?? []
    }
}

/// The insights route wraps its payload via apiDataSuccess → `{ ok, data: {…} }` —
/// decode both the wrapped and flat shapes (approvals-screen convention).
struct InsightsBundle: Decodable {
    let reorder: [InsightReorderItem]
    let slowMovers: [InsightSlowMover]
    let finance: InsightFinance?
    let customers: InsightCustomerDigest?
    let generatedAt: String?

    private enum Keys: String, CodingKey {
        case ok, data, reorder, slowMovers, finance, customers, generatedAt
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        reorder = (try? c.decode([InsightReorderItem].self, forKey: .reorder)) ?? []
        slowMovers = (try? c.decode([InsightSlowMover].self, forKey: .slowMovers)) ?? []
        finance = try? c.decodeIfPresent(InsightFinance.self, forKey: .finance)
        customers = try? c.decodeIfPresent(InsightCustomerDigest.self, forKey: .customers)
        generatedAt = try? c.decodeIfPresent(String.self, forKey: .generatedAt)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class InsightsVM {
    var bundle: InsightsBundle? = nil
    var loading = false
    var refreshing = false        // web's "↻ রিফ্রেশ" (fresh recompute) state
    var error: String? = nil
    var authExpired = false

    func load(fresh: Bool = false) async {
        if fresh { refreshing = true } else { loading = true }
        error = nil
        defer { loading = false; refreshing = false }
        do {
            let resp: InsightsBundle = try await AlmaAPI.shared.get(
                "/api/insights", query: fresh ? ["refresh": "1"] : [:])
            bundle = resp
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = "ইনসাইট লোড করা গেল না"
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
struct InsightsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = InsightsVM()
    @State private var selectedCustomer: InsightCustomer? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 10) {
                headerRow
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.bundle == nil { loadingRows }
                if let bundle = vm.bundle {
                    financeSection(bundle.finance)
                    reorderSection(bundle.reorder)
                    slowMoverSection(bundle.slowMovers)
                    customerSection(bundle.customers)
                    footerNote
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(InsightsAurora())
        .claudeTopFade()
        .refreshable { await vm.load(fresh: true) }
        .task { if vm.bundle == nil { await vm.load() } }
        .sheet(item: $selectedCustomer) { customer in
            InsightCustomerSheet(customer: customer, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Header (web PageHeader subtitle + ↻ রিফ্রেশ) ──

    private var headerRow: some View {
        HStack(spacing: 8) {
            Text("রিঅর্ডার · ফিনান্সিয়াল হেলথ · কাস্টমার — গভীর বিশ্লেষণ")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Spacer(minLength: 6)
            Button {
                UISelectionFeedbackGenerator().selectionChanged()
                Task { await vm.load(fresh: true) }
            } label: {
                Group {
                    if vm.refreshing {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 34, height: 34)
                .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            }
            .buttonStyle(.plain)
            .disabled(vm.refreshing || vm.loading)
        }
        .padding(.top, 4)
    }

    // ── ফিনান্সিয়াল হেলথ ──

    @ViewBuilder private func financeSection(_ finance: InsightFinance?) -> some View {
        sectionTitle("banknote.fill", "ফিনান্সিয়াল হেলথ", sub: finance?.period)
        if let f = finance {
            financeKpiStrip(f)
            ForEach(Array(f.flags.enumerated()), id: \.offset) { _, flag in
                InsightFlagCard(text: flag, severity: .warn)
            }
            if !f.topProducts.isEmpty { topProductsCard(f.topProducts) }
        } else {
            emptyCard("ফিনান্সিয়াল ডেটা নেই",
                      "এই মুহূর্তে হিসাব আনা গেল না — রিফ্রেশ করে দেখুন।", severity: .info)
        }
    }

    private func financeKpiStrip(_ f: InsightFinance) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("রেভিনিউ (৩০দিন)", InsightFormat.taka(f.revenue),
                        InsightPalette.accentText(colorScheme),
                        sub: trendSub(f.revenueWoW, goodUp: true))
                kpiCard("খরচ (৩০দিন)", InsightFormat.taka(f.expensesTotal), .primary,
                        sub: trendSub(f.expenseWoW, goodUp: false))
                kpiCard("নেট প্রফিট", InsightFormat.taka(f.netProfit ?? 0),
                        (f.netProfit ?? 0) >= 0 ? InsightPalette.emerald600 : InsightPalette.red500,
                        sub: (f.costDataMissing ? "cost ডেটা অসম্পূর্ণ" : "আনুমানিক", .secondary))
                kpiCard("মার্জিন",
                        f.marginPct != nil ? "\(InsightFormat.num(f.marginPct ?? 0))%" : "—",
                        (f.marginPct ?? 0) >= 0 ? .primary : InsightPalette.red500,
                        sub: ("net margin", .secondary))
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    /// Web KpiCard TrendSub: "↑ x% WoW" green when moving the good way, red otherwise.
    private func trendSub(_ pct: Double?, goodUp: Bool) -> (text: String, color: Color) {
        guard let pct else { return ("WoW —", .secondary) }
        let up = pct >= 0
        let good = up == goodUp
        return ("\(up ? "↑" : "↓") \(InsightFormat.num(abs(pct)))% WoW",
                good ? InsightPalette.emerald600 : InsightPalette.red500)
    }

    /// Web "টপ প্রোডাক্ট (প্রফিট)" table — name · units · revenue · margin%.
    private func topProductsCard(_ products: [InsightTopProduct]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("টপ প্রোডাক্ট (প্রফিট)")
                .font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14).padding(.vertical, 10)
            ForEach(Array(products.enumerated()), id: \.offset) { index, p in
                if index > 0 { Divider().opacity(0.25).padding(.leading, 14) }
                HStack(spacing: 10) {
                    Text(p.product)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text("\(p.units) pcs")
                        .font(.caption2).foregroundStyle(.secondary)
                    Text(InsightFormat.taka(p.revenue))
                        .font(.caption.monospaced().weight(.bold))
                        .foregroundStyle(InsightPalette.accentText(colorScheme))
                    if let margin = p.marginPct {
                        Text("\(InsightFormat.num(margin))%")
                            .font(.caption2.weight(.bold).monospacedDigit())
                            .foregroundStyle(margin >= 0 ? InsightPalette.emerald600 : InsightPalette.red500)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 8)
            }
            Color.clear.frame(height: 4)
        }
        .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── রিঅর্ডার দরকার ──

    @ViewBuilder private func reorderSection(_ items: [InsightReorderItem]) -> some View {
        sectionTitle("shippingbox.fill", "রিঅর্ডার দরকার", count: items.count)
        if items.isEmpty {
            emptyCard("স্টক ঠিক আছে ✓", "জরুরি রিঅর্ডার নেই, Boss।", severity: .good)
        } else {
            ForEach(items.prefix(8)) { item in
                InsightReorderCard(item: item)
            }
        }
    }

    // ── স্লো-মুভিং স্টক ──

    @ViewBuilder private func slowMoverSection(_ movers: [InsightSlowMover]) -> some View {
        sectionTitle("tortoise.fill", "স্লো-মুভিং স্টক", count: movers.count)
        if movers.isEmpty {
            emptyCard("সব নড়ছে ✓", "পুঁজি আটকে নেই — সব স্টক বিক্রি হচ্ছে।", severity: .good)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                Text("৩০ দিনে বিক্রি নেই — পুঁজি আটকে আছে")
                    .font(.caption2).foregroundStyle(.secondary)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                ForEach(Array(movers.enumerated()), id: \.offset) { index, mover in
                    if index > 0 { Divider().opacity(0.25).padding(.leading, 14) }
                    HStack(spacing: 10) {
                        Text(mover.name)
                            .font(.caption.weight(.semibold))
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        Text("৯০দিনে \(mover.sales90d)")
                            .font(.caption2).foregroundStyle(.secondary)
                        Text("\(mover.currentStock) pcs")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8).padding(.vertical, 2)
                            .background(Color.primary.opacity(0.06), in: Capsule())
                    }
                    .padding(.horizontal, 14).padding(.vertical, 8)
                }
                Color.clear.frame(height: 4)
            }
            .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    // ── কাস্টমার ইন্টেলিজেন্স ──

    @ViewBuilder private func customerSection(_ digest: InsightCustomerDigest?) -> some View {
        sectionTitle("person.2.fill", "কাস্টমার ইন্টেলিজেন্স")
        if let cs = digest {
            customerKpiStrip(cs)
            if !cs.highChurn.isEmpty {
                customerListCard("⚠ ফিরিয়ে আনুন", tint: InsightPalette.red500,
                                 customers: cs.highChurn, vip: false)
            }
            if !cs.topVips.isEmpty {
                customerListCard("⭐ টপ VIP", tint: InsightPalette.accentText(colorScheme),
                                 customers: cs.topVips, vip: true)
            }
            ForEach(Array(cs.notes.enumerated()), id: \.offset) { _, note in
                InsightFlagCard(text: note, severity: .info)
            }
        } else {
            emptyCard("কাস্টমার ডেটা নেই",
                      "বিশ্লেষণ আনা গেল না — রিফ্রেশ করে দেখুন।", severity: .info)
        }
    }

    private func customerKpiStrip(_ cs: InsightCustomerDigest) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("VIP কাস্টমার", "\(cs.vipCount)",
                        InsightPalette.accentText(colorScheme), sub: ("top tier", .secondary))
                kpiCard("চার্ন ঝুঁকি", "\(cs.highChurnCount)",
                        cs.highChurnCount > 0 ? InsightPalette.red500 : .primary,
                        sub: ("হারানোর ঝুঁকি", .secondary))
                kpiCard("নতুন (এই সপ্তাহ)", "\(cs.newThisWeekCount)",
                        InsightPalette.emerald600, sub: ("new", .secondary))
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    private func customerListCard(_ title: String, tint: Color,
                                  customers: [InsightCustomer], vip: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(tint)
                .padding(.horizontal, 14).padding(.vertical, 10)
            ForEach(Array(customers.enumerated()), id: \.offset) { index, customer in
                if index > 0 { Divider().opacity(0.25).padding(.leading, 14) }
                InsightCustomerRow(customer: customer, vip: vip) {
                    selectedCustomer = customer
                }
            }
            Color.clear.frame(height: 4)
        }
        .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Shared bits ──

    private func sectionTitle(_ icon: String, _ title: String,
                              count: Int? = nil, sub: String? = nil) -> some View {
        HStack(spacing: 7) {
            Image(systemName: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(InsightPalette.accentText(colorScheme))
            Text(title).font(.footnote.weight(.heavy))
            if let count, count > 0 {
                Text("\(count)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(InsightPalette.accentText(colorScheme))
                    .padding(.horizontal, 7).padding(.vertical, 1.5)
                    .background(InsightPalette.coral.opacity(0.15), in: Capsule())
            }
            if let sub {
                Text(sub).font(.system(size: 10)).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.top, 6)
    }

    private func kpiCard(_ label: String, _ value: String, _ tint: Color,
                         sub: (text: String, color: Color)? = nil) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(value)
                .font(.headline.weight(.bold).monospacedDigit())
                .foregroundStyle(tint)
            if let sub {
                Text(sub.text).font(.caption2.weight(.bold)).foregroundStyle(sub.color)
            }
        }
        .frame(minWidth: 104, alignment: .leading)
        .padding(12)
        .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func emptyCard(_ title: String, _ desc: String,
                           severity: InsightSeverity) -> some View {
        HStack(spacing: 10) {
            InsightSeverityBadge(severity: severity)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.footnote.weight(.bold))
                Text(desc).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        VStack(spacing: 10) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(InsightPalette.red500)
            Button {
                Task { await vm.load(fresh: true) }
            } label: {
                Text("আবার চেষ্টা").font(.footnote.weight(.semibold))
            }
            .buttonStyle(.bordered)
            .tint(InsightPalette.coral)
        }
        .frame(maxWidth: .infinity)
        .padding(16)
        .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 110)
                .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .insightsShimmer()
        }
    }

    private var footerNote: some View {
        Text("ALMA Agent বিশ্লেষণ · ৩০ দিনের ডেটা")
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.top, 4)
    }

    private var webEscape: some View {
        Button {
            openWeb("/insights", "Insights")
        } label: {
            Label("সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Severity badge (squircle, tinted per class — the screen's iOS signature)

@available(iOS 17.0, *)
private struct InsightSeverityBadge: View {
    let severity: InsightSeverity

    var body: some View {
        Image(systemName: severity.icon)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(severity.tint)
            .frame(width: 30, height: 30)
            .background(severity.tint.opacity(0.13),
                        in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(severity.tint.opacity(0.30), lineWidth: 1))
    }
}

// MARK: - Flag / note card (web FlagLine "▸ …", re-set with a severity badge and
// the 5-line clamp + spring expand)

@available(iOS 17.0, *)
private struct InsightFlagCard: View {
    let text: String
    let severity: InsightSeverity
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            InsightSeverityBadge(severity: severity)
            InsightExpandableText(text: text)
            Spacer(minLength: 0)
        }
        .padding(12)
        .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }
}

/// Small, calm body text — clamped to 5 lines with a bottom fade; tapping
/// "আরো দেখুন" springs the full text open (same recipe as the Approvals agent card).
@available(iOS 17.0, *)
private struct InsightExpandableText: View {
    let text: String
    var threshold: Int = 200
    @Environment(\.colorScheme) private var colorScheme
    @State private var expanded = false

    private var isLong: Bool { text.count > threshold }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(.caption)
                .lineSpacing(2.5)
                .foregroundStyle(.primary.opacity(0.85))
                .lineLimit(expanded || !isLong ? nil : 5)
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
                    .foregroundStyle(InsightPalette.accentText(colorScheme))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// MARK: - Reorder card (web reorder Card parity: urgency chip · reason · stock line)

@available(iOS 17.0, *)
private struct InsightReorderCard: View {
    let item: InsightReorderItem
    @Environment(\.colorScheme) private var colorScheme

    private var isHigh: Bool { item.urgency == "high" }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            InsightSeverityBadge(severity: isHigh ? .critical : .warn)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(item.name)
                        .font(.subheadline.weight(.bold))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(isHigh ? "জরুরি" : "শীঘ্রই")
                        .font(.system(size: 10, weight: .black))
                        .foregroundStyle(isHigh ? InsightPalette.red500
                                                : InsightPalette.accentText(colorScheme))
                        .padding(.horizontal, 8).padding(.vertical, 2)
                        .background((isHigh ? InsightPalette.red500 : InsightPalette.coral).opacity(0.14),
                                    in: Capsule())
                }
                if !item.reason.isEmpty {
                    InsightExpandableText(text: item.reason)
                }
                HStack(spacing: 6) {
                    Text("স্টক \(item.currentStock) · ~\(Int(item.daysOfStock.rounded())) দিন বাকি")
                        .font(.caption2).foregroundStyle(.secondary)
                    Spacer(minLength: 4)
                    Text("~\(item.suggestedQty)টি অর্ডার")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(InsightPalette.accentText(colorScheme))
                }
            }
        }
        .padding(12)
        .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .overlay {
            if isHigh {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .strokeBorder(InsightPalette.red500.opacity(0.35), lineWidth: 1)
            }
        }
    }
}

// MARK: - Customer row + detail sheet

@available(iOS 17.0, *)
private struct InsightCustomerRow: View {
    let customer: InsightCustomer
    let vip: Bool
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(customer.name ?? customer.phone ?? "কাস্টমার")
                        .font(.caption.weight(.bold))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text("\(customer.ordersCount) অর্ডার")
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                    if vip, let clv = customer.estimatedClv, clv > 0 {
                        Text(InsightFormat.taka(clv))
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(InsightPalette.accentText(colorScheme))
                    } else if let days = customer.daysSinceLast {
                        Text("\(days)দিন আগে")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(InsightPalette.red500)
                    }
                }
                if !customer.engagementSuggestion.isEmpty {
                    Text(customer.engagementSuggestion)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .padding(.horizontal, 14).padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }
}

/// Detail sheet — the full engagement suggestion + CLV note, read-only. Any follow-up
/// action (call/message the customer) escapes to the web page.
@available(iOS 17.0, *)
private struct InsightCustomerSheet: View {
    let customer: InsightCustomer
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                infoCard
                suggestionCard
                webLink
            }
            .padding(18)
        }
        .presentationBackground { InsightsAurora() }
    }

    private var displayName: String { customer.name ?? customer.phone ?? "কাস্টমার" }

    private var churnColor: Color {
        switch customer.churnRisk {
        case "high": return InsightPalette.red500
        case "medium": return InsightPalette.amber600
        default: return InsightPalette.emerald600
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(InsightFormat.initials(displayName))
                .font(.subheadline.weight(.bold))
                .foregroundStyle(InsightPalette.accentText(colorScheme))
                .frame(width: 42, height: 42)
                .background(InsightPalette.coral.opacity(0.16), in: Circle())
                .overlay(Circle().strokeBorder(InsightPalette.coral.opacity(0.35), lineWidth: 1))
            VStack(alignment: .leading, spacing: 3) {
                Text(displayName).font(.subheadline.weight(.bold))
                HStack(spacing: 6) {
                    Text(customer.tier.uppercased())
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(InsightPalette.accentText(colorScheme))
                        .padding(.horizontal, 6).padding(.vertical, 1.5)
                        .background(InsightPalette.coral.opacity(0.14), in: Capsule())
                    Text("চার্ন: \(customer.churnRisk.uppercased())")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(churnColor)
                        .padding(.horizontal, 6).padding(.vertical, 1.5)
                        .background(churnColor.opacity(0.12), in: Capsule())
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var infoCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let phone = customer.phone { infoRow("ফোন", phone) }
            infoRow("অর্ডার", "\(customer.ordersCount) অর্ডার")
            if let days = customer.daysSinceLast {
                infoRow("শেষ অর্ডার", "\(days)দিন আগে",
                        color: customer.churnRisk == "high" ? InsightPalette.red500 : .primary)
            }
            if let clv = customer.estimatedClv, clv > 0 {
                infoRow("আনুমানিক CLV", InsightFormat.taka(clv),
                        color: InsightPalette.accentText(colorScheme))
            }
            if let note = customer.clvNote, !note.isEmpty {
                infoRow("CLV নোট", note)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func infoRow(_ label: String, _ value: String, color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2.weight(.heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.semibold)).foregroundStyle(color)
        }
    }

    @ViewBuilder private var suggestionCard: some View {
        if !customer.engagementSuggestion.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("এনগেজমেন্ট পরামর্শ")
                    .font(.caption2.weight(.heavy)).textCase(.uppercase)
                    .foregroundStyle(.secondary)
                Text(customer.engagementSuggestion)
                    .font(.caption)
                    .lineSpacing(2.5)
                    .foregroundStyle(.primary.opacity(0.85))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .insightsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/insights", "Insights")
        } label: {
            Label("সব অপশন — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Formatting helpers (web util parity)

private enum InsightFormat {
    /// Web tk(): "৳12,345" — whole-taka, rounded.
    static func taka(_ n: Double?) -> String {
        "৳\(Int((n ?? 0).rounded()).formatted())"
    }

    /// Percent-style number: integers stay bare ("12"), fractions keep one place.
    static func num(_ d: Double) -> String {
        d == d.rounded() ? String(Int(d)) : String(format: "%.1f", d)
    }

    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Aurora background + glass (Insights-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct InsightsAurora: View {
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
    func insightsGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct InsightsShimmer: ViewModifier {
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
    func insightsShimmer() -> some View { modifier(InsightsShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Insights — Light") {
    InsightsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
