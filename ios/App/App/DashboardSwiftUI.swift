//
//  DashboardSwiftUI.swift
//  ALMA ERP — the Lifestyle home dashboard (web `/`) as a fully native SwiftUI screen.
//
//  1:1 parity with src/app/page.tsx `LifestyleDashboard` — same numbers, same blocks,
//  same theme. One endpoint, computed server-side (the SAME 551-line aggregation the web
//  runs), so the KPIs can never drift from the web dashboard:
//    GET /api/dashboard?business_id=ALMA_LIFESTYLE&startDate=…&endDate=…  → DashboardData
//        (kpis · by_status · by_source · by_category · monthly_trend · daily_trend ·
//         top_products · sla_breaches · recent_orders)
//
//  Web-parity blocks (top→bottom): "{range} · Live" header + connection dot · SLA banner ·
//  date-range preset chips · 4 hero KPIs (Revenue / Net profit / Orders / Delivered) ·
//  4 compact KPIs (Return loss / Return rate / Pending / Realized profit) · Daily sales ·
//  Monthly revenue · Revenue & profit trend · Order status (donut + grid) · Category mix
//  (donut + legend) · Orders by channel · Top products · Recent orders · SLA detail.
//  VIEW-ONLY by design (owner P&L surface): the header has a web escape hatch; taps on
//  orders open the web order. Money is whole-taka BDT (৳ / AlmaSwiftTheme.takaShort).
//
//  Theme is 100% the app's own tokens (AlmaSwiftTheme coral/violet/sage + the web chart
//  palette) — nothing invented; matches Finance/Approvals/Orders exactly, light + dark.
//

import SwiftUI
import UIKit

// MARK: - Host container (keeps the Capacitor bridge ALIVE behind the native dashboard)
//
// The home tab (`/`) was FROZEN_CAPACITOR because the Capacitor bridge VC drives push /
// reminders / the N1–N5 native bridges — all fed by the ERP webview + `capacitorDidLoad()`.
// If we simply swapped that VC out for a SwiftUI screen, its view would never load and those
// features would silently die. So instead we keep the Capacitor VC mounted (loaded + in the
// window hierarchy, so its JS + plugins keep running) and lay the opaque native dashboard
// ON TOP of it. The owner sees native; Capacitor keeps working exactly as before.

@available(iOS 17.0, *)
final class DashboardHostController: UIViewController {
    private let capacitor: UIViewController
    private let host: UIHostingController<DashboardScreen>

    init(capacitor: UIViewController, openWeb: @escaping (_ path: String, _ title: String) -> Void) {
        self.capacitor = capacitor
        self.host = UIHostingController(rootView: DashboardScreen(openWeb: openWeb))
        super.init(nibName: nil, bundle: nil)
        title = "Dashboard"
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        // 1) Capacitor bridge BEHIND — mounting its view runs `capacitorDidLoad()` (plugin
        //    registration) and keeps the ERP webview executing (reminders / bridges alive).
        //    It's visually covered by the opaque native dashboard, but stays in the window
        //    hierarchy so WKWebView never suspends its JS.
        addChild(capacitor)
        capacitor.view.translatesAutoresizingMaskIntoConstraints = false
        capacitor.view.isUserInteractionEnabled = false   // owner drives the native UI; this
        view.addSubview(capacitor.view)                    // layer is alive only for plugins
        capacitor.didMove(toParent: self)

        // 2) Native dashboard ON TOP. The host view gets an OPAQUE app-colour background (not
        //    clear): the SwiftUI aurora is drawn over it, but at large scroll offsets SwiftUI
        //    can momentarily not repaint a `.background`, and a clear host would then reveal the
        //    Capacitor webview behind. The opaque backing guarantees the app's own colour shows
        //    instead — the webview can never bleed through as the owner scrolls.
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        host.view.backgroundColor = AlmaTheme.rootBg
        view.addSubview(host.view)
        host.didMove(toParent: self)

        NSLayoutConstraint.activate([
            capacitor.view.topAnchor.constraint(equalTo: view.topAnchor),
            capacitor.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            capacitor.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            capacitor.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    /// The Capacitor WKWebView re-asserts itself to the front when its content loads or
    /// scrolls; without this it would cover the native dashboard as the owner scrolls down.
    /// Re-pin the native host on top on every layout pass so it always stays in front.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if host.view.superview === view, view.subviews.last !== host.view {
            view.bringSubviewToFront(host.view)
        }
    }
}

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum DashPalette {
    static let coral = AlmaSwiftTheme.coral                                   // gold / --c-accent #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)          // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)         // #C45A3C
    static let tan = Color(red: 0.831, green: 0.584, blue: 0.416)             // #D4956A
    static let sage = AlmaSwiftTheme.sage                                     // #81B29A
    static let violet = AlmaSwiftTheme.violet                                 // #a78bfa (Delivered)
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)          // #EF4444 danger
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)        // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)        // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)      // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)        // #4ADE80
    static let info = Color(red: 0.231, green: 0.510, blue: 0.965)            // #3B82F6 (Total orders)

    /// The web's donut/pie order — PALETTE = [accent, goldDim, goldLt, tan, sage].
    static let chart: [Color] = [coral, goldDim, goldLt, tan, sage]

    /// Accent-tinted text: gold-dim on cream, gold-lt over dark aurora (web txt-accent).
    static func accentText(_ s: ColorScheme) -> Color { s == .dark ? goldLt : goldDim }
    /// Positive money — emerald on cream, bright green over dark aurora (web txt-pos).
    static func positive(_ s: ColorScheme) -> Color { s == .dark ? green400 : emerald600 }
    /// Warning tone — amber (web txt-warning).
    static func warning(_ s: ColorScheme) -> Color { s == .dark ? amber500 : amber600 }
    /// Signed money tone: negative red, else positive green.
    static func signed(_ amount: Int, _ s: ColorScheme) -> Color {
        amount < 0 ? red500 : positive(s)
    }
}

// MARK: - Bangla numerals + money (owner directive: the dashboard shows ALL figures in pure Bangla)

private let dashBnDigits: [Character: Character] = [
    "0": "০", "1": "১", "2": "২", "3": "৩", "4": "৪",
    "5": "৫", "6": "৬", "7": "৭", "8": "৮", "9": "৯",
]
/// Latin digits in any string → Bangla digits (leaves separators/symbols intact).
private func bnD(_ s: String) -> String { String(s.map { dashBnDigits[$0] ?? $0 }) }
/// Indian/Bangla comma grouping of a non-negative int: 58500→"58,500", 1250000→"12,50,000".
private func dashGrouped(_ n: Int) -> String {
    var s = String(n)
    guard s.count > 3 else { return s }
    let last3 = String(s.suffix(3)); s = String(s.dropLast(3))
    var groups: [String] = []
    while s.count > 2 { groups.insert(String(s.suffix(2)), at: 0); s = String(s.dropLast(2)) }
    if !s.isEmpty { groups.insert(s, at: 0) }
    return groups.joined(separator: ",") + "," + last3
}
/// Whole int in Bangla digits with grouping (counts, orders, pieces).
private func bnN(_ n: Int) -> String { bnD(dashGrouped(abs(n))).prependingMinus(n < 0) }
/// Taka amount, Bangla digits + grouping: 58500→"৳৫৮,৫০০", -160→"-৳১৬০".
private func bnTk(_ n: Int) -> String { (n < 0 ? "-৳" : "৳") + bnD(dashGrouped(abs(n))) }
/// Percent in Bangla digits: 85→"৮৫%".
private func bnPct(_ n: Int) -> String { bnD(String(abs(n))).prependingMinus(n < 0) + "%" }

private extension String {
    func prependingMinus(_ yes: Bool) -> String { yes ? "-" + self : self }
}

// MARK: - Lenient decode helpers (numbers may arrive as strings / decimals)

private func dashFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) {
        if let i = Int(s) { return i }
        if let d = Double(s) { return Int(d.rounded()) }
    }
    return nil
}

private func dashFlexDouble<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
    return nil
}

// MARK: - Models (field names = the web DashboardMetrics / DashboardData declare)

/// The kpis slice the web `LifestyleDashboard` reads. Everything optional-with-default so a
/// server that hasn't shipped the additive fields yet (pending_count/top_products/daily_trend)
/// still decodes cleanly — the affected blocks simply show their empty state until it lands.
struct DashKpis: Decodable, Equatable {
    let totalOrders: Int
    let totalRevenue: Int
    let totalProfit: Int
    let netBusinessProfit: Int?
    let totalRealizedProfit: Int?
    let deliveredCount: Int
    let deliveryRate: Int          // 0–100 (web Math.round(delivered/n*100))
    let returnRate: Int            // 0–100
    let returnRatePaid: Int
    let returnRateRefused: Int
    let totalReturnsLoss: Int
    let returnedPaidCount: Int
    let returnedUnpaidCount: Int
    let pendingCount: Int?

    private enum K: String, CodingKey {
        case totalOrders = "total_orders"
        case totalRevenue = "total_revenue"
        case totalProfit = "total_profit"
        case netBusinessProfit = "net_business_profit"
        case totalRealizedProfit = "total_realized_profit"
        case deliveredCount = "delivered_count"
        case deliveryRate = "delivery_rate"
        case returnRate = "return_rate"
        case returnRatePaid = "return_rate_paid"
        case returnRateRefused = "return_rate_refused"
        case totalReturnsLoss = "total_returns_loss"
        case returnedPaidCount = "returned_paid_count"
        case returnedUnpaidCount = "returned_unpaid_count"
        case pendingCount = "pending_count"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        totalOrders = dashFlexInt(c, .totalOrders) ?? 0
        totalRevenue = dashFlexInt(c, .totalRevenue) ?? 0
        totalProfit = dashFlexInt(c, .totalProfit) ?? 0
        netBusinessProfit = dashFlexInt(c, .netBusinessProfit)
        totalRealizedProfit = dashFlexInt(c, .totalRealizedProfit)
        deliveredCount = dashFlexInt(c, .deliveredCount) ?? 0
        deliveryRate = dashFlexInt(c, .deliveryRate) ?? 0
        returnRate = dashFlexInt(c, .returnRate) ?? 0
        returnRatePaid = dashFlexInt(c, .returnRatePaid) ?? 0
        returnRateRefused = dashFlexInt(c, .returnRateRefused) ?? 0
        totalReturnsLoss = dashFlexInt(c, .totalReturnsLoss) ?? 0
        returnedPaidCount = dashFlexInt(c, .returnedPaidCount) ?? 0
        returnedUnpaidCount = dashFlexInt(c, .returnedUnpaidCount) ?? 0
        pendingCount = dashFlexInt(c, .pendingCount)
    }

    /// Net profit = web `net_business_profit ?? total_profit`.
    var netProfit: Int { netBusinessProfit ?? totalProfit }
    /// Realized = web `total_realized_profit ?? total_profit`.
    var realizedProfit: Int { totalRealizedProfit ?? totalProfit }
}

struct DashSourceStat: Decodable, Equatable {
    let orders: Int
    let revenue: Int
    private enum K: String, CodingKey { case orders, revenue }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        orders = dashFlexInt(c, .orders) ?? 0
        revenue = dashFlexInt(c, .revenue) ?? 0
    }
}

struct DashCategoryStat: Decodable, Equatable {
    let orders: Int
    let revenue: Int
    let profit: Int
    private enum K: String, CodingKey { case orders, revenue, profit }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        orders = dashFlexInt(c, .orders) ?? 0
        revenue = dashFlexInt(c, .revenue) ?? 0
        profit = dashFlexInt(c, .profit) ?? 0
    }
}

struct DashSizeSlice: Decodable, Equatable {
    let label: String
    let pieces: Int
    private enum K: String, CodingKey { case label, pieces }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        label = (try? c.decode(String.self, forKey: .label)) ?? ""
        pieces = dashFlexInt(c, .pieces) ?? 0
    }
}

struct DashGroupDetail: Decodable, Equatable {
    let group: String
    let pieces: Int
    let sizeBreakdown: [DashSizeSlice]
    private enum K: String, CodingKey { case group, pieces; case sizeBreakdown = "size_breakdown" }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        group = (try? c.decode(String.self, forKey: .group)) ?? ""
        pieces = dashFlexInt(c, .pieces) ?? 0
        sizeBreakdown = (try? c.decodeIfPresent([DashSizeSlice].self, forKey: .sizeBreakdown)) ?? []
    }
    /// Swift mirror of web `formatGroupSizeLine`: "Group N pcs · sz A (x) · B (y)".
    var line: String {
        let sizes = sizeBreakdown.prefix(2).map { "\($0.label) (\($0.pieces))" }.joined(separator: " · ")
        let base = "\(group) \(pieces) pcs"
        return sizes.isEmpty ? base : "\(base) · sz \(sizes)"
    }
}

struct DashTopProduct: Decodable, Identifiable, Equatable {
    let product: String
    let orders: Int
    let revenue: Int
    let profit: Int
    let pieces: Int
    let topSize: DashSizeSlice?
    let groupDetails: [DashGroupDetail]
    var id: String { product }

    private enum K: String, CodingKey {
        case product, orders, revenue, profit, pieces
        case topSize = "top_size"
        case groupDetails = "group_details"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        product = (try? c.decode(String.self, forKey: .product)) ?? ""
        orders = dashFlexInt(c, .orders) ?? 0
        revenue = dashFlexInt(c, .revenue) ?? 0
        profit = dashFlexInt(c, .profit) ?? 0
        pieces = dashFlexInt(c, .pieces) ?? 0
        topSize = try? c.decodeIfPresent(DashSizeSlice.self, forKey: .topSize)
        groupDetails = (try? c.decodeIfPresent([DashGroupDetail].self, forKey: .groupDetails)) ?? []
    }
}

struct DashDailyPoint: Decodable, Identifiable, Equatable {
    let date: String       // yyyy-MM-dd
    let revenue: Int
    let profit: Int
    let orders: Int
    var id: String { date }
    private enum K: String, CodingKey { case date, revenue, profit, orders }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        date = (try? c.decode(String.self, forKey: .date)) ?? ""
        revenue = dashFlexInt(c, .revenue) ?? 0
        profit = dashFlexInt(c, .profit) ?? 0
        orders = dashFlexInt(c, .orders) ?? 0
    }
}

struct DashMonthlyPoint: Decodable, Identifiable, Equatable {
    let month: String      // yyyy-MM
    let revenue: Int
    let profit: Int
    let orders: Int
    var id: String { month }
    private enum K: String, CodingKey { case month, revenue, profit, orders }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        month = (try? c.decode(String.self, forKey: .month)) ?? ""
        revenue = dashFlexInt(c, .revenue) ?? 0
        profit = dashFlexInt(c, .profit) ?? 0
        orders = dashFlexInt(c, .orders) ?? 0
    }
}

struct DashSlaBreach: Decodable, Identifiable, Equatable {
    let id: String
    let customer: String
    let slaStatus: String
    private enum K: String, CodingKey { case id, customer; case slaStatus = "sla_status" }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        customer = (try? c.decodeIfPresent(String.self, forKey: .customer)) ?? ""
        slaStatus = (try? c.decodeIfPresent(String.self, forKey: .slaStatus)) ?? ""
    }
}

struct DashRecentOrder: Decodable, Identifiable, Equatable {
    let id: String
    let customer: String
    let product: String
    let status: String
    let sellPrice: Int
    private enum K: String, CodingKey { case id, customer, product, status; case sellPrice = "sell_price" }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        customer = (try? c.decodeIfPresent(String.self, forKey: .customer)) ?? ""
        product = (try? c.decodeIfPresent(String.self, forKey: .product)) ?? ""
        status = (try? c.decodeIfPresent(String.self, forKey: .status)) ?? ""
        sellPrice = dashFlexInt(c, .sellPrice) ?? 0
    }
}

/// GET /api/dashboard payload (tolerates an `{ok,data:{…}}` wrapper like the other pages).
struct DashboardData: Decodable {
    let kpis: DashKpis
    let byStatus: [String: Int]
    let bySource: [String: DashSourceStat]
    let byCategory: [String: DashCategoryStat]
    let monthlyTrend: [DashMonthlyPoint]
    let dailyTrend: [DashDailyPoint]
    let topProducts: [DashTopProduct]
    let slaBreaches: [DashSlaBreach]
    let recentOrders: [DashRecentOrder]

    private enum K: String, CodingKey {
        case ok, data, kpis
        case byStatus = "by_status"
        case bySource = "by_source"
        case byCategory = "by_category"
        case monthlyTrend = "monthly_trend"
        case dailyTrend = "daily_trend"
        case topProducts = "top_products"
        case slaBreaches = "sla_breaches"
        case recentOrders = "recent_orders"
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: K.self)
        let c = (try? root.nestedContainer(keyedBy: K.self, forKey: .data)) ?? root
        kpis = (try? c.decode(DashKpis.self, forKey: .kpis)) ?? Self.emptyKpis()
        byStatus = (try? c.decodeIfPresent([String: Int].self, forKey: .byStatus)) ?? [:]
        bySource = (try? c.decodeIfPresent([String: DashSourceStat].self, forKey: .bySource)) ?? [:]
        byCategory = (try? c.decodeIfPresent([String: DashCategoryStat].self, forKey: .byCategory)) ?? [:]
        monthlyTrend = (try? c.decodeIfPresent([DashMonthlyPoint].self, forKey: .monthlyTrend)) ?? []
        dailyTrend = (try? c.decodeIfPresent([DashDailyPoint].self, forKey: .dailyTrend)) ?? []
        topProducts = (try? c.decodeIfPresent([DashTopProduct].self, forKey: .topProducts)) ?? []
        slaBreaches = (try? c.decodeIfPresent([DashSlaBreach].self, forKey: .slaBreaches)) ?? []
        recentOrders = (try? c.decodeIfPresent([DashRecentOrder].self, forKey: .recentOrders)) ?? []
    }

    /// Decode an all-zero kpis object so a partial payload never throws (DashKpis
    /// decodes `{}` cleanly — every field is optional-with-default).
    private static func emptyKpis() -> DashKpis {
        (try? JSONDecoder().decode(DashKpis.self, from: Data("{}".utf8)))
            ?? (try! JSONDecoder().decode(DashKpis.self, from: Data("{}".utf8)))
    }
}

// MARK: - Date presets (web DateRangeFilter parity — default last30, Asia/Dhaka)

enum DashDatePreset: String, CaseIterable {
    case today, yesterday, last7, last30, thisMonth, lastMonth

    var label: String {
        switch self {
        case .today: return "Today"
        case .yesterday: return "Yesterday"
        case .last7: return "Last 7 days"
        case .last30: return "Last 30 days"
        case .thisMonth: return "This month"
        case .lastMonth: return "Last month"
        }
    }

    private static var dhaka: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return c
    }
    private static func ymd(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    /// Inclusive yyyy-MM-dd range — mirrors the web getDatePresetRange exactly.
    func range(now: Date = Date()) -> (start: String, end: String) {
        let cal = Self.dhaka
        let today = cal.startOfDay(for: now)
        switch self {
        case .today:
            return (Self.ymd(today), Self.ymd(today))
        case .yesterday:
            let y = cal.date(byAdding: .day, value: -1, to: today) ?? today
            return (Self.ymd(y), Self.ymd(y))
        case .last7:
            let s = cal.date(byAdding: .day, value: -6, to: today) ?? today
            return (Self.ymd(s), Self.ymd(today))
        case .last30:
            let s = cal.date(byAdding: .day, value: -29, to: today) ?? today
            return (Self.ymd(s), Self.ymd(today))
        case .thisMonth:
            let s = cal.date(from: cal.dateComponents([.year, .month], from: today)) ?? today
            return (Self.ymd(s), Self.ymd(today))
        case .lastMonth:
            let thisStart = cal.date(from: cal.dateComponents([.year, .month], from: today)) ?? today
            let prevEnd = cal.date(byAdding: .day, value: -1, to: thisStart) ?? today
            let prevStart = cal.date(from: cal.dateComponents([.year, .month], from: prevEnd)) ?? prevEnd
            return (Self.ymd(prevStart), Self.ymd(prevEnd))
        }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class DashboardVM {
    var data: DashboardData? = nil
    var preset: DashDatePreset = .last30       // web default (DateRangeContext 'last30')
    var loading = false
    var error: String? = nil
    var authExpired = false

    static let businessId = "ALMA_LIFESTYLE"

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        let range = preset.range()
        let query: [String: String?] = [
            "business_id": Self.businessId,
            "startDate": range.start,
            "endDate": range.end,
        ]
        do {
            let d: DashboardData = try await AlmaAPI.shared.get("/api/dashboard", query: query)
            withAnimation(.spring(duration: 0.4, bounce: 0.15)) { data = d }
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = error.localizedDescription
        }
    }

    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }
}

// MARK: - Owner To-Do (super-admin) — mirrors web OwnerTodoBar on /api/assistant/todos

/// One owner to-do. The route answers camelCase JSON (AlmaAPI keeps keys verbatim), so the
/// property names ARE the CodingKeys. `description` is ignored — the card shows title + meta.
@available(iOS 17.0, *)
private struct OwnerTodo: Identifiable, Decodable {
    let id: String
    let title: String
    let priority: String        // "low" | "normal" | "high"
    let status: String          // "pending" | "in_progress" | "running" | "completed" | "cancelled"
    let dueDate: String?
    let createdAt: String?

    var priorityRank: Int { priority == "high" ? 2 : (priority == "low" ? 0 : 1) }
    var isHigh: Bool { priority == "high" }
}

@available(iOS 17.0, *)
private struct TodosEnvelope: Decodable { let todos: [OwnerTodo] }
@available(iOS 17.0, *)
private struct TodoEnvelope: Decodable { let todo: OwnerTodo }

/// Loads / mutates the owner's open to-dos. `visible` gates the whole card: the route
/// returns 403 (→ AlmaAPIError.notAuthenticated) for any non-SUPER_ADMIN session, so the
/// card only ever appears for the owner. A 403 here does NOT prompt re-login on the
/// dashboard — only AssistantSwiftUI observes AlmaAPI.authExpiredNotification.
@available(iOS 17.0, *)
@Observable
private final class OwnerTodoVM {
    var items: [OwnerTodo] = []
    var visible = false
    var newTitle = ""
    var busy = false
    var done: Set<String> = []           // locally marked complete — stays checked, never auto-removed

    /// Remaining (un-checked) count — drives the chip badge and "N টি বাকি".
    var openCount: Int { items.filter { !done.contains($0.id) }.count }

    private static let open: Set<String> = ["pending", "in_progress", "running"]

    func load() async {
        do {
            let env: TodosEnvelope = try await AlmaAPI.shared.get("/api/assistant/todos")
            let list = env.todos.filter { Self.open.contains($0.status) }
                .sorted { a, b in
                    a.priorityRank != b.priorityRank ? a.priorityRank > b.priorityRank
                                                     : (a.createdAt ?? "") < (b.createdAt ?? "")
                }
            withAnimation(.spring(duration: 0.35, bounce: 0.12)) { items = list }
            visible = true
        } catch AlmaAPIError.notAuthenticated {
            visible = false                          // not the owner — hide silently
        } catch {
            if DashboardVM.isCancellation(error) { return }   // transient — keep current list
        }
    }

    func add() async {
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !busy else { return }
        busy = true; defer { busy = false }
        struct Body: Encodable { let title: String; let source = "owner" }
        do {
            let _: TodoEnvelope = try await AlmaAPI.shared.send("POST", "/api/assistant/todos", body: Body(title: title))
            newTitle = ""
            await load()
        } catch { /* leave the text so the owner can retry */ }
    }

    /// Tap the circle → toggle done. The row STAYS (checked + struck-through); it is NOT
    /// removed. Deleting is a separate action (`remove`, the ✕). Owner directive 2026-07-07.
    func toggle(_ id: String) async {
        let marking = !done.contains(id)
        withAnimation(.snappy(duration: 0.22)) { if marking { done.insert(id) } else { done.remove(id) } }
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        struct Body: Encodable { let id: String; let status: String }
        do {
            let _: TodoEnvelope = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/todos", body: Body(id: id, status: marking ? "completed" : "pending"))
        } catch {
            withAnimation(.snappy(duration: 0.2)) { if marking { done.remove(id) } else { done.insert(id) } }
        }
    }

    func remove(_ id: String) async {
        struct Body: Encodable { let id: String; let status = "cancelled" }
        UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
        withAnimation(.snappy(duration: 0.26)) { items.removeAll { $0.id == id }; done.remove(id) }
        do { let _: TodoEnvelope = try await AlmaAPI.shared.send("PATCH", "/api/assistant/todos", body: Body(id: id)) }
        catch { await load() }                       // rollback from server on failure
    }
}

@available(iOS 17.0, *)
private struct OwnerTodoBar: View {
    @Bindable var vm: OwnerTodoVM
    let scheme: ColorScheme
    @Binding var open: Bool
    @FocusState private var inputFocused: Bool

    /// Bengali digits, matching the web bar's "{n}টি বাকি".
    private func bn(_ n: Int) -> String {
        let d = Array("০১২৩৪৫৬৭৮৯")
        return String(String(n).compactMap { c in c.wholeNumberValue.map { d[$0] } })
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            chip
            if open {
                // Light transition (opacity + tiny slide) — scaling a blurred material every
                // frame is what made the open feel laggy; opacity/offset composite cheaply.
                panel.transition(.opacity.combined(with: .offset(y: -8)))
            }
        }
    }

    // Collapsed pill: "টুডু" + remaining-count badge.
    private var chip: some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            withAnimation(.snappy(duration: 0.26, extraBounce: 0.02)) { open.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "checklist").font(.caption2.weight(.bold))
                Text("টুডু").font(.caption.weight(.bold))
                if vm.openCount > 0 {
                    Text(bn(vm.openCount))
                        .font(.caption2.weight(.heavy)).foregroundStyle(.white)
                        .frame(minWidth: 16).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(DashPalette.coral, in: Capsule())
                        .contentTransition(.numericText())
                }
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .foregroundStyle(DashPalette.accentText(scheme))
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(.ultraThinMaterial, in: Capsule())
            .background(DashPalette.coral.opacity(scheme == .dark ? 0.18 : 0.10), in: Capsule())
            .overlay(Capsule().strokeBorder(DashPalette.coral.opacity(0.45), lineWidth: 1))
            .shadow(color: .black.opacity(0.12), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
    }

    // Expanded dropdown (web OwnerTodoBar panel), native glass.
    private var panel: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack {
                Text("আমার টুডু").font(.subheadline.weight(.bold))
                Spacer()
                Text("\(bn(vm.openCount))টি বাকি").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .contentTransition(.numericText())
            }

            HStack(spacing: 8) {
                TextField("নতুন টুডু লিখুন…", text: $vm.newTitle)
                    .font(.footnote).focused($inputFocused).submitLabel(.done)
                    .onSubmit { Task { await vm.add() } }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color.primary.opacity(scheme == .dark ? 0.08 : 0.05), in: Capsule())
                Button { Task { await vm.add() } } label: {
                    Text(vm.busy ? "…" : "যোগ").font(.caption.weight(.bold)).foregroundStyle(.white)
                        .padding(.horizontal, 13).padding(.vertical, 9)
                        .background(LinearGradient(colors: [DashPalette.coral, DashPalette.goldDim],
                                                   startPoint: .topLeading, endPoint: .bottomTrailing), in: Capsule())
                }
                .disabled(vm.newTitle.trimmingCharacters(in: .whitespaces).isEmpty || vm.busy)
                .opacity(vm.newTitle.trimmingCharacters(in: .whitespaces).isEmpty ? 0.5 : 1)
            }

            if vm.items.isEmpty {
                Text("কোনো টুডু বাকি নেই — এজেন্টকে বললে বা এখানে লিখলে যুক্ত হবে।")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, 4)
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 0) {
                        ForEach(Array(vm.items.enumerated()), id: \.element.id) { idx, t in
                            if idx > 0 { Divider().opacity(0.25) }
                            row(t)
                        }
                    }
                }
                .frame(maxHeight: 300)
            }
        }
        .padding(14)
        .frame(width: 300, alignment: .leading)
        .background(scheme == .dark ? Color(red: 0.11, green: 0.09, blue: 0.17) : Color(red: 0.99, green: 0.98, blue: 1.0),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.12 : 0.6), lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 14, y: 8)
    }

    private func row(_ t: OwnerTodo) -> some View {
        let done = vm.done.contains(t.id)
        return HStack(spacing: 11) {
            // Tap = mark done / undo. The row STAYS (checked); it is not removed.
            Button { Task { await vm.toggle(t.id) } } label: {
                ZStack {
                    Circle()
                        .strokeBorder(done ? DashPalette.positive(scheme) : Color.secondary.opacity(0.5), lineWidth: 2)
                        .background(Circle().fill(done ? DashPalette.positive(scheme) : Color.clear))
                        .frame(width: 23, height: 23)
                    if done {
                        Image(systemName: "checkmark").font(.system(size: 11, weight: .heavy)).foregroundStyle(.white)
                            .transition(.scale.combined(with: .opacity))
                    }
                }
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 2) {
                Text(t.title)
                    .font(.subheadline.weight(.medium))
                    .strikethrough(done)
                    .foregroundStyle(done ? Color.secondary : Color.primary)
                    .lineLimit(2)
                if t.isHigh || dueLabel(t.dueDate) != nil {
                    HStack(spacing: 8) {
                        if t.isHigh {
                            Text("জরুরি").font(.caption2.weight(.bold)).foregroundStyle(DashPalette.red500)
                        }
                        if let d = dueLabel(t.dueDate) {
                            Label(d.text, systemImage: "clock")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(d.overdue ? DashPalette.red500 : Color.secondary)
                        }
                    }
                }
            }
            Spacer(minLength: 6)
            // Delete — ALWAYS a separate action (owner: marking must not delete).
            Button { Task { await vm.remove(t.id) } } label: {
                Image(systemName: "trash").font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(DashPalette.red500.opacity(0.85))
                    .frame(width: 30, height: 30)
                    .background(DashPalette.red500.opacity(scheme == .dark ? 0.14 : 0.09), in: Circle())
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 5)
        .animation(.snappy(duration: 0.22), value: done)
    }

    /// Due-date label in Asia/Dhaka, matching the web bar: আজ / আগামীকাল / বাকি পড়ে আছে / d/M.
    private func dueLabel(_ iso: String?) -> (text: String, overdue: Bool)? {
        guard let iso, let date = Self.parse(iso) else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        let today = cal.startOfDay(for: Date())
        let due = cal.startOfDay(for: date)
        let days = cal.dateComponents([.day], from: today, to: due).day ?? 0
        if days < 0 { return ("বাকি পড়ে আছে", true) }
        if days == 0 { return ("আজ", false) }
        if days == 1 { return ("আগামীকাল", false) }
        let f = DateFormatter(); f.timeZone = cal.timeZone; f.dateFormat = "d/M"
        return (f.string(from: date), false)
    }
    private static func parse(_ s: String) -> Date? {
        let a = ISO8601DateFormatter(); a.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = a.date(from: s) { return d }
        let b = ISO8601DateFormatter(); b.formatOptions = [.withInternetDateTime]
        return b.date(from: s)
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct DashboardScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm = DashboardVM()
    @State private var todoVM = OwnerTodoVM()
    @State private var todoOpen = false
    let openWeb: (_ path: String, _ title: String) -> Void

    /// DEBUG self-test hook (never set on a real launch): ALMA_DASH_ANCHOR=top|charts|lists|end
    /// auto-scrolls to a section so a headless sim proof can capture the below-the-fold blocks.
    private var debugAnchor: String? { ProcessInfo.processInfo.environment["ALMA_DASH_ANCHOR"] }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    // Reserve a slim top strip for the floating To-Do chip (overlay below).
                    Color.clear.frame(height: todoVM.visible ? 30 : 0).id("top")
                    if vm.authExpired { authCard }
                    if let err = vm.error { noticeCard(err) }
                    if let breaches = vm.data?.slaBreaches, !breaches.isEmpty { slaBanner(breaches) }
                    presetChips
                    if vm.loading && vm.data == nil {
                        loadingRows
                    } else if let d = vm.data {
                        kpiBento(d.kpis, daily: d.dailyTrend, monthly: d.monthlyTrend)
                        dailySalesCard(d.dailyTrend).id("charts")
                        monthlyRevenueCard(d.monthlyTrend)
                        revenueTrendCard(d.monthlyTrend)
                        orderStatusCard(d.byStatus).id("charts2")
                        categoryMixCard(d.byCategory)
                        channelCard(d.bySource)
                        topProductsCard(d.topProducts).id("lists")
                        recentOrdersCard(d.recentOrders)
                        if !d.slaBreaches.isEmpty { slaDetailCard(d.slaBreaches) }
                    }
                    webEscape
                    Color.clear.frame(height: 8).id("end")
                }
                .padding(.horizontal, 14)
                .padding(.top, 4)
            }
            .onChange(of: vm.data != nil) { _, ready in
                if ready, let a = debugAnchor {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                        withAnimation { proxy.scrollTo(a, anchor: .top) }
                    }
                }
            }
        }
        .background(DashAurora())
        // Custom UIKit nav-bar title (no SwiftUI .toolbar), so use the MANUAL masked-blur +
        // colour-dissolve fade — same as OrdersSwiftUI. The native iOS-26 edge effect only
        // paints under a real .toolbar, which is why the fade was invisible here before.
        .claudeTopFade(useNativeEdgeEffect: false)
        // Dim backdrop UNDER the bar (added first → renders below the topTrailing overlay).
        .overlay {
            if todoVM.visible && todoOpen {
                Rectangle().fill(.black.opacity(scheme == .dark ? 0.28 : 0.12)).ignoresSafeArea()
                    .transition(.opacity)
                    .onTapGesture { withAnimation(.spring(duration: 0.3, bounce: 0.1)) { todoOpen = false } }
            }
        }
        // The web OwnerTodoBar, native: a small chip pinned top-right that expands to a glass
        // dropdown. Owner directive 2026-07-07 — small chip, not a big inline card.
        .overlay(alignment: .topTrailing) {
            if todoVM.visible {
                OwnerTodoBar(vm: todoVM, scheme: scheme, open: $todoOpen)
                    .padding(.trailing, 14).padding(.top, 6)
            }
        }
        .refreshable { await vm.load(); await todoVM.load() }
        .task { await vm.load() }
        .task {
            await todoVM.load()
            // DEBUG self-test hook (never set on a real launch): ALMA_DASH_TODO_OPEN=1 opens the
            // To-Do dropdown at launch so a headless sim proof can capture the expanded panel.
            if ProcessInfo.processInfo.environment["ALMA_DASH_TODO_OPEN"] == "1", todoVM.visible {
                withAnimation(.spring(duration: 0.34, bounce: 0.16)) { todoOpen = true }
            }
        }
    }

    // The page title is the centred inline UIKit nav-bar title "Dashboard" (set on
    // DashboardHostController + darkNav largeTitles:false) — exactly like every other
    // native screen. No in-scroll header / subtitle (owner directive 2026-07-07).

    // ── SLA banner (web warning strip) ──

    private func slaBanner(_ breaches: [DashSlaBreach]) -> some View {
        let ids = breaches.prefix(3).map { "#\($0.id)" }.joined(separator: ", ")
        let extra = breaches.count > 3 ? " +\(breaches.count - 3) more" : ""
        return Button {
            openWeb("/orders?status=sla", "Orders")
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "bolt.fill").foregroundStyle(DashPalette.warning(scheme))
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(breaches.count) order\(breaches.count > 1 ? "s" : "") need attention")
                        .font(.footnote.weight(.bold)).foregroundStyle(DashPalette.warning(scheme))
                    Text(ids + extra).font(.caption2).foregroundStyle(DashPalette.warning(scheme).opacity(0.85))
                        .lineLimit(1)
                }
                Spacer()
                Text("View all →").font(.caption2.weight(.bold)).foregroundStyle(DashPalette.warning(scheme))
            }
            .padding(12)
            .background(DashPalette.amber500.opacity(scheme == .dark ? 0.16 : 0.12),
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(DashPalette.amber500.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Date preset chips (web DateRangeFilter) ──

    private var presetChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(DashDatePreset.allCases, id: \.rawValue) { p in
                    dashChip(p.label, active: vm.preset == p) {
                        vm.preset = p
                        Task { await vm.load() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    // ── KPI bento: revenue hero + tiles + mini chips (the approved demo layout) ──

    @ViewBuilder
    private func kpiBento(_ k: DashKpis, daily: [DashDailyPoint], monthly: [DashMonthlyPoint]) -> some View {
        VStack(spacing: 10) {
            RevenueHeroCard(value: bnTk(k.totalRevenue),
                            spark: daily.map(\.revenue),
                            trend: Self.trend(monthly.map(\.revenue)))

            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())], spacing: 10) {
                KpiTile(label: "Net Profit",
                        value: bnTk(k.netProfit),
                        valueTint: DashPalette.signed(k.netProfit, scheme),
                        accent: k.netProfit < 0 ? DashPalette.red500 : DashPalette.positive(scheme),
                        trend: Self.trend(monthly.map(\.profit)))
                KpiTile(label: "Delivered",
                        value: bnN(k.deliveredCount),
                        valueTint: DashPalette.violet, accent: DashPalette.violet,
                        ring: DashRingSpec(percent: k.deliveryRate, total: k.totalOrders))
                KpiTile(label: "Total Orders",
                        value: bnN(k.totalOrders),
                        valueTint: DashPalette.info, accent: DashPalette.info,
                        sub: ordersSub(k))
                KpiTile(label: "Realized Profit",
                        value: bnTk(k.realizedProfit),
                        valueTint: DashPalette.positive(scheme), accent: DashPalette.positive(scheme),
                        sub: "ডেলিভারড অর্ডার")
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                MiniChip(label: "Return Loss", value: bnTk(k.totalReturnsLoss),
                         tint: DashPalette.red500)
                MiniChip(label: "Return Rate", value: bnPct(k.returnRate),
                         tint: k.returnRate > 20 ? DashPalette.red500
                             : k.returnRate > 10 ? DashPalette.warning(scheme) : .primary)
                MiniChip(label: "Pending", value: k.pendingCount.map { bnN($0) } ?? "—",
                         tint: DashPalette.warning(scheme))
            }
        }
    }

    private func ordersSub(_ k: DashKpis) -> String {
        if let p = k.pendingCount, p > 0 { return "\(bnN(p)) পেন্ডিং · \(bnPct(k.deliveryRate)) ডেলিভারড" }
        return "\(bnPct(k.deliveryRate)) ডেলিভারড"
    }

    /// Period-over-period % from the last two points of a real series. Only returns a value
    /// when BOTH months have real revenue (a partial/zero current month would read as a
    /// misleading −100%), and drops absurd swings — otherwise nil so no chip is shown.
    static func trend(_ series: [Int]) -> Double? {
        guard series.count >= 2 else { return nil }
        let prev = series[series.count - 2], last = series[series.count - 1]
        guard prev > 0, last > 0 else { return nil }
        let pct = (Double(last - prev) / Double(prev)) * 100
        guard abs(pct) <= 300 else { return nil }
        return pct
    }

    // ── Daily Sales (web DailySalesChart — native area/line) ──

    private func dailySalesCard(_ points: [DashDailyPoint]) -> some View {
        ChartCard(title: "Daily Sales", subtitle: vm.preset.label) {
            if points.isEmpty {
                emptyChart("◈", "No data", "Pick another date range")
            } else {
                DashLineChart(values: points.map(\.revenue), color: DashPalette.coral, height: 150)
                    .padding(.top, 8)
            }
        }
    }

    // ── Monthly Revenue (web MonthlyRevenueChart — native bars + profit overlay) ──

    private func monthlyRevenueCard(_ points: [DashMonthlyPoint]) -> some View {
        ChartCard(title: "Monthly Revenue", subtitle: vm.preset.label,
                  legend: [("Revenue", DashPalette.coral), ("Profit", DashPalette.positive(scheme))]) {
            if points.isEmpty {
                emptyChart("◈", "No data", "Monthly breakdown appears when orders exist")
            } else {
                DashMonthlyBars(points: points).padding(.top, 8)
            }
        }
    }

    // ── Revenue & Profit Trend (web RevenueChart — native dual line) ──

    private func revenueTrendCard(_ points: [DashMonthlyPoint]) -> some View {
        ChartCard(title: "Revenue & Profit Trend", subtitle: vm.preset.label,
                  legend: [("Revenue", DashPalette.coral), ("Profit", DashPalette.positive(scheme))]) {
            if points.isEmpty {
                emptyChart("◈", "No data", "Revenue chart appears once orders exist")
            } else {
                ZStack {
                    DashLineChart(values: points.map(\.revenue), color: DashPalette.coral, height: 160, fill: false)
                    DashLineChart(values: points.map(\.profit), color: DashPalette.positive(scheme),
                                  height: 160, fill: false, maxOverride: points.map(\.revenue).max())
                }
                .padding(.top, 8)
            }
        }
    }

    // ── Order Status (web StatusPieChart + value grid) ──

    private func orderStatusCard(_ byStatus: [String: Int]) -> some View {
        let slices = byStatus
            .filter { !["Cancelled", "CANCELLED"].contains($0.key) }
            .sorted { $0.value > $1.value }
        return ChartCard(title: "Order Status", subtitle: nil) {
            if slices.isEmpty {
                emptyChart("◫", "No data", "Status breakdown updates with your filter")
            } else {
                VStack(spacing: 12) {
                    DashDonut(slices: slices.enumerated().map {
                        ($1.key, $1.value, DashPalette.chart[$0 % DashPalette.chart.count])
                    })
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                        ForEach(Array(slices.enumerated()), id: \.offset) { _, s in
                            VStack(spacing: 1) {
                                Text(bnN(s.value)).font(.subheadline.weight(.bold))
                                Text(s.key).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .background(Color.primary.opacity(scheme == .dark ? 0.05 : 0.035),
                                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }
                }
                .padding(.top, 6)
            }
        }
    }

    // ── Category Mix (web DonutChart + legend) ──

    private func categoryMixCard(_ byCategory: [String: DashCategoryStat]) -> some View {
        let top = byCategory.sorted { $0.value.orders > $1.value.orders }.prefix(5)
        let slices = top.enumerated().map {
            ($1.key, $1.value.orders, DashPalette.chart[$0 % DashPalette.chart.count])
        }
        return ChartCard(title: "Category Mix", subtitle: nil) {
            if slices.isEmpty {
                emptyChart("◧", "No data", "Category mix appears once orders exist")
            } else {
                VStack(spacing: 12) {
                    DashDonut(slices: slices)
                    VStack(spacing: 8) {
                        ForEach(Array(slices.enumerated()), id: \.offset) { _, s in
                            HStack(spacing: 10) {
                                RoundedRectangle(cornerRadius: 3).fill(s.2).frame(width: 10, height: 10)
                                Text(s.0).font(.caption).foregroundStyle(.secondary)
                                Spacer()
                                Text(bnN(s.1)).font(.caption.weight(.bold))
                            }
                        }
                    }
                }
                .padding(.top, 6)
            }
        }
    }

    // ── Orders by Channel (web BarSourceChart — native h-bars) ──

    private func channelCard(_ bySource: [String: DashSourceStat]) -> some View {
        let rows = bySource.sorted { $0.value.orders > $1.value.orders }
        let maxV = max(rows.map { $0.value.orders }.max() ?? 1, 1)
        return ChartCard(title: "Orders by Channel", subtitle: nil) {
            if rows.isEmpty {
                emptyChart("◩", "No data", "Channel breakdown updates with your filter")
            } else {
                VStack(spacing: 10) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                        HStack(spacing: 10) {
                            Text(r.key).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                                .frame(width: 74, alignment: .leading).lineLimit(1)
                            GeometryReader { geo in
                                Capsule()
                                    .fill(LinearGradient(colors: [DashPalette.goldLt, DashPalette.coral],
                                                         startPoint: .leading, endPoint: .trailing))
                                    .frame(width: max(geo.size.width * CGFloat(r.value.orders) / CGFloat(maxV), 6))
                            }
                            .frame(height: 14)
                            Text(bnN(r.value.orders)).font(.caption.weight(.bold))
                                .frame(width: 34, alignment: .trailing)
                        }
                        .animation(.spring(duration: 0.5, bounce: 0.2).delay(Double(i) * 0.03), value: maxV)
                    }
                }
                .padding(.top, 8)
            }
        }
    }

    // ── Top Products (web list) ──

    private func topProductsCard(_ products: [DashTopProduct]) -> some View {
        let top = Array(products.prefix(5))
        return ListCard(title: "Top Products", subtitle: vm.preset.label) {
            if top.isEmpty {
                emptyChart("◧", "No products", "Top sellers appear when orders exist")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(top.enumerated()), id: \.element.id) { i, p in
                        if i > 0 { Divider().opacity(0.3) }
                        topProductRow(rank: i + 1, p)
                    }
                }
            }
        }
    }

    private func topProductRow(rank: Int, _ p: DashTopProduct) -> some View {
        HStack(spacing: 12) {
            Text(bnN(rank))
                .font(.caption.weight(.bold)).foregroundStyle(DashPalette.accentText(scheme))
                .frame(width: 26, height: 26)
                .background(DashPalette.coral.opacity(scheme == .dark ? 0.18 : 0.12),
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(p.product).font(.caption.weight(.semibold)).lineLimit(1)
                Text("\(bnN(p.orders)) orders" + (p.pieces > 0 ? " · \(bnN(p.pieces)) pcs" : ""))
                    .font(.caption2).foregroundStyle(.secondary)
                if let firstGroup = p.groupDetails.first {
                    Text(p.groupDetails.prefix(2).map(\.line).joined(separator: " | "))
                        .font(.caption2).foregroundStyle(DashPalette.positive(scheme)).lineLimit(1)
                        .id(firstGroup.group)
                } else if let ts = p.topSize {
                    Text("Top: \(ts.label) · \(bnN(ts.pieces)) pcs")
                        .font(.caption2).foregroundStyle(DashPalette.positive(scheme)).lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 2) {
                Text(bnTk(p.revenue))
                    .font(.caption.weight(.bold).monospacedDigit())
                    .foregroundStyle(DashPalette.accentText(scheme))
                Text(bnTk(p.profit))
                    .font(.caption2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(DashPalette.positive(scheme))
            }
        }
        .padding(.vertical, 9).padding(.horizontal, 2)
    }

    // ── Recent Orders (web list) ──

    private func recentOrdersCard(_ orders: [DashRecentOrder]) -> some View {
        let recent = Array(orders.prefix(6))
        return ListCard(title: "Recent Orders", subtitle: nil,
                        action: ("View all →", { openWeb("/orders", "Orders") })) {
            if recent.isEmpty {
                emptyChart("◫", "No orders", "Recent orders appear for the selected date range")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(recent.enumerated()), id: \.element.id) { i, o in
                        if i > 0 { Divider().opacity(0.3) }
                        Button {
                            openWeb("/orders?focus=\(o.id)", "Order \(o.id)")
                        } label: {
                            HStack(spacing: 10) {
                                Text(o.id).font(.caption2.monospaced().weight(.bold))
                                    .foregroundStyle(DashPalette.accentText(scheme))
                                    .frame(width: 58, alignment: .leading).lineLimit(1)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(o.customer).font(.caption.weight(.semibold)).lineLimit(1)
                                    Text(o.product).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 6)
                                DashStatusBadge(status: o.status)
                                Text(bnTk(o.sellPrice))
                                    .font(.caption.weight(.bold).monospacedDigit())
                            }
                            .padding(.vertical, 9).padding(.horizontal, 2)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // ── SLA detail card (web SLA alerts) ──

    private func slaDetailCard(_ breaches: [DashSlaBreach]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "bolt.fill").foregroundStyle(DashPalette.warning(scheme))
                Text("SLA Alerts — \(breaches.count) order\(breaches.count > 1 ? "s" : "")")
                    .font(.subheadline.weight(.bold)).foregroundStyle(DashPalette.warning(scheme))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 8)
            ForEach(Array(breaches.enumerated()), id: \.offset) { i, b in
                if i > 0 { Divider().opacity(0.25) }
                HStack(spacing: 10) {
                    Text(b.id).font(.caption2.monospaced().weight(.bold))
                        .foregroundStyle(DashPalette.accentText(scheme))
                        .frame(width: 58, alignment: .leading)
                    Text(b.customer).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Text(b.slaStatus).font(.caption2.weight(.semibold))
                        .foregroundStyle(DashPalette.warning(scheme))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(DashPalette.amber500.opacity(0.18), in: Capsule())
                }
                .padding(.vertical, 8)
            }
        }
        .padding(14)
        .dashGlass(scheme, corner: 16)
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(DashPalette.amber500.opacity(0.3), lineWidth: 1))
    }

    // ── Shared bits ──

    private func dashChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? DashPalette.accentText(scheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? DashPalette.coral.opacity(scheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(scheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? DashPalette.coral.opacity(0.55)
                           : Color.white.opacity(scheme == .dark ? 0.10 : 0.4), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func emptyChart(_ icon: String, _ title: String, _ desc: String) -> some View {
        VStack(spacing: 4) {
            Text(icon).font(.title2).foregroundStyle(.secondary)
            Text(title).font(.footnote.weight(.semibold))
            Text(desc).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 24)
    }

    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(DashPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).dashGlass(scheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
                .tint(DashPalette.coral)
        }
        .frame(maxWidth: .infinity).padding(20).dashGlass(scheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 96).dashGlass(scheme, corner: 16).dashShimmer()
        }
    }

    private var webEscape: some View {
        Button { openWeb("/", "Dashboard") } label: {
            Label("সম্পূর্ণ ড্যাশবোর্ড — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote).frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain).foregroundStyle(.secondary).padding(.vertical, 6)
    }
}

// MARK: - KPI bento components (revenue hero + tiles + mini chips + ring + trend)

private struct DashRingSpec { let percent: Int; let total: Int }

/// ▲/▼ percent pill — green up, red down (real period-over-period from the monthly series).
@available(iOS 17.0, *)
private struct TrendChip: View {
    @Environment(\.colorScheme) private var scheme
    let pct: Double
    var body: some View {
        let up = pct >= 0
        let color = up ? DashPalette.positive(scheme) : DashPalette.red500
        return HStack(spacing: 2) {
            Image(systemName: up ? "arrow.up.right" : "arrow.down.right").font(.system(size: 8, weight: .black))
            Text("\(abs(pct), specifier: "%.0f")%").font(.system(size: 10.5, weight: .heavy)).monospacedDigit()
        }
        .foregroundStyle(color)
        .padding(.horizontal, 6).padding(.vertical, 2)
        .background(color.opacity(scheme == .dark ? 0.20 : 0.14), in: Capsule())
    }
}

/// Circular progress ring for the delivery rate (animated fill on appear).
@available(iOS 17.0, *)
private struct DashRing: View {
    @Environment(\.colorScheme) private var scheme
    let percent: Int
    let color: Color
    @State private var animate = false
    var body: some View {
        ZStack {
            Circle().stroke(Color.primary.opacity(scheme == .dark ? 0.14 : 0.08), lineWidth: 5)
            Circle().trim(from: 0, to: animate ? CGFloat(min(max(percent, 0), 100)) / 100 : 0)
                .stroke(color, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(bnPct(percent)).font(.system(size: 12, weight: .heavy))
        }
        .frame(width: 50, height: 50)
        .onAppear { withAnimation(.spring(duration: 0.7, bounce: 0.12)) { animate = true } }
    }
}

/// Full-width Revenue hero: big value + real month-over-month trend + live sparkline.
@available(iOS 17.0, *)
private struct RevenueHeroCard: View {
    @Environment(\.colorScheme) private var scheme
    let value: String
    let spark: [Int]
    let trend: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("REVENUE").font(.system(size: 10, weight: .bold)).tracking(0.6).foregroundStyle(.secondary)
                Spacer()
                if let trend { TrendChip(pct: trend) }
            }
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text("৳").font(.title2.weight(.bold)).foregroundStyle(.secondary)
                Text(stripTaka(value)).font(.system(size: 34, weight: .heavy)).monospacedDigit()
                    .minimumScaleFactor(0.6).lineLimit(1).contentTransition(.numericText())
                if trend != nil {
                    Text("vs last month").font(.caption2).foregroundStyle(.secondary).padding(.leading, 4)
                }
            }
            if !spark.isEmpty {
                DashLineChart(values: spark, color: DashPalette.coral, height: 46).padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(15)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous).fill(.ultraThinMaterial)
                RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.white.opacity(scheme == .dark ? 0.04 : 0.35))
                LinearGradient(colors: [DashPalette.coral.opacity(scheme == .dark ? 0.16 : 0.12), .clear],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
                HStack(spacing: 0) { Rectangle().fill(DashPalette.coral).frame(width: 3); Spacer(minLength: 0) }
            }
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
    private func stripTaka(_ s: String) -> String { s.hasPrefix("৳") ? String(s.dropFirst()) : s }
}

/// One KPI tile — optional trend pill, optional right-side ring (Delivered).
@available(iOS 17.0, *)
private struct KpiTile: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String
    let valueTint: Color
    let accent: Color
    var sub: String? = nil
    var trend: Double? = nil
    var ring: DashRingSpec? = nil

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 5) {
                    Text(label.uppercased()).font(.system(size: 10, weight: .bold)).tracking(0.5)
                        .foregroundStyle(.secondary).lineLimit(1)
                    if let trend { TrendChip(pct: trend) }
                }
                HStack(alignment: .firstTextBaseline, spacing: 1) {
                    Text(value).font(.title3.weight(.bold)).monospacedDigit()
                        .foregroundStyle(valueTint).lineLimit(1).minimumScaleFactor(0.6)
                        .contentTransition(.numericText())
                    if let ring { Text("/\(bnN(ring.total))").font(.caption2).foregroundStyle(.secondary) }
                }
                if let sub { Text(sub).font(.caption2).foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.8) }
            }
            if let ring { Spacer(minLength: 0); DashRing(percent: ring.percent, color: DashPalette.sage) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.ultraThinMaterial)
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(scheme == .dark ? 0.04 : 0.35))
                LinearGradient(colors: [accent.opacity(scheme == .dark ? 0.12 : 0.08), .clear],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
                HStack(spacing: 0) { Rectangle().fill(accent).frame(width: 3); Spacer(minLength: 0) }
            }
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// Compact 3-up chip (Return Loss / Return Rate / Pending).
@available(iOS 17.0, *)
private struct MiniChip: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: String
    let tint: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.75)
            Text(value).font(.subheadline.weight(.heavy)).monospacedDigit()
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.7).contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 11).padding(.vertical, 10)
        .dashGlass(scheme, corner: 13)
    }
}

// MARK: - Card chrome (chart + list containers)

@available(iOS 17.0, *)
private struct ChartCard<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let subtitle: String?
    var legend: [(String, Color)] = []
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.subheadline.weight(.bold))
                    if let subtitle { Text(subtitle).font(.caption2).foregroundStyle(.secondary) }
                }
                Spacer()
                if !legend.isEmpty {
                    HStack(spacing: 10) {
                        ForEach(Array(legend.enumerated()), id: \.offset) { _, l in
                            HStack(spacing: 4) {
                                Circle().fill(l.1).frame(width: 7, height: 7)
                                Text(l.0).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14).dashGlass(scheme, corner: 18)
    }
}

@available(iOS 17.0, *)
private struct ListCard<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    let title: String
    let subtitle: String?
    var action: (String, () -> Void)? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.subheadline.weight(.bold))
                    if let subtitle { Text(subtitle).font(.caption2).foregroundStyle(.secondary) }
                }
                Spacer()
                if let action {
                    Button(action.0, action: action.1)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(DashPalette.accentText(scheme))
                }
            }
            .padding(.bottom, 2)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14).dashGlass(scheme, corner: 18)
    }
}

// MARK: - Status badge (web StatusBadge — keyword colour map)

@available(iOS 17.0, *)
private struct DashStatusBadge: View {
    @Environment(\.colorScheme) private var scheme
    let status: String

    private var tint: Color {
        let s = status.lowercased()
        if s.contains("deliver") { return DashPalette.positive(scheme) }
        if s.contains("cancel") || s.contains("return") || s.contains("refus") || s.contains("fail") {
            return DashPalette.red500
        }
        if s.contains("pending") || s.contains("hold") || s.contains("process") { return DashPalette.warning(scheme) }
        if s.contains("transit") || s.contains("ship") || s.contains("dispatch") { return DashPalette.info }
        return DashPalette.accentText(scheme)
    }

    var body: some View {
        Text(status).font(.system(size: 10, weight: .semibold))
            .foregroundStyle(tint).lineLimit(1)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.14), in: Capsule())
    }
}

// MARK: - Charts (native re-sets of the web recharts — hand-rolled, app aesthetic)

/// Area/line chart for a numeric series (web DailySalesChart / RevenueChart line).
@available(iOS 17.0, *)
private struct DashLineChart: View {
    let values: [Int]
    let color: Color
    let height: CGFloat
    var fill: Bool = true
    var maxOverride: Int? = nil

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            let maxV = CGFloat(max(maxOverride ?? (values.max() ?? 1), 1))
            let n = max(values.count - 1, 1)
            let pts: [CGPoint] = values.enumerated().map { i, v in
                CGPoint(x: w * CGFloat(i) / CGFloat(n),
                        y: h - (h - 6) * CGFloat(max(v, 0)) / maxV - 3)
            }
            ZStack {
                if fill, pts.count > 1 {
                    areaPath(pts, w: w, h: h)
                        .fill(LinearGradient(colors: [color.opacity(0.28), color.opacity(0.02)],
                                             startPoint: .top, endPoint: .bottom))
                }
                linePath(pts)
                    .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                if let last = pts.last {
                    Circle().fill(color).frame(width: 6, height: 6).position(last)
                }
            }
        }
        .frame(height: height)
        .animation(.spring(duration: 0.5, bounce: 0.15), value: values)
    }

    private func linePath(_ pts: [CGPoint]) -> Path {
        var p = Path()
        guard let first = pts.first else { return p }
        p.move(to: first)
        pts.dropFirst().forEach { p.addLine(to: $0) }
        return p
    }
    private func areaPath(_ pts: [CGPoint], w: CGFloat, h: CGFloat) -> Path {
        var p = linePath(pts)
        if let last = pts.last, let first = pts.first {
            p.addLine(to: CGPoint(x: last.x, y: h))
            p.addLine(to: CGPoint(x: first.x, y: h))
            p.closeSubpath()
        }
        return p
    }
}

/// Monthly revenue bars + profit overlay (web MonthlyRevenueChart).
@available(iOS 17.0, *)
private struct DashMonthlyBars: View {
    let points: [DashMonthlyPoint]
    private var maxRevenue: Int { max(points.map(\.revenue).max() ?? 1, 1) }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .bottom, spacing: 12) {
                ForEach(points) { p in bar(p) }
            }
            .padding(.horizontal, 2)
        }
        .animation(.spring(duration: 0.5, bounce: 0.2), value: points)
    }

    private func bar(_ p: DashMonthlyPoint) -> some View {
        let h = max(CGFloat(p.revenue) / CGFloat(maxRevenue) * 120, 3)
        let ph = p.revenue > 0
            ? max(CGFloat(max(p.profit, 0)) / CGFloat(maxRevenue) * 120, p.profit > 0 ? 3 : 0) : 0
        return VStack(spacing: 4) {
            Text(bnTk(p.revenue))
                .font(.system(size: 8, weight: .semibold).monospacedDigit())
                .foregroundStyle(.secondary).fixedSize()
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(LinearGradient(colors: [DashPalette.goldLt, DashPalette.coral],
                                         startPoint: .top, endPoint: .bottom))
                    .frame(width: 26, height: h)
                if ph > 0 {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(DashPalette.positive(.light).opacity(0.9))
                        .frame(width: 10, height: ph)
                }
            }
            .frame(height: 124, alignment: .bottom)
            Text(DashFormat.monthShort(p.month))
                .font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
        }
    }
}

/// Donut (web DonutChart / StatusPieChart) — segments from (label, value, colour).
@available(iOS 17.0, *)
private struct DashDonut: View {
    let slices: [(String, Int, Color)]
    private var total: Int { max(slices.reduce(0) { $0 + $1.1 }, 1) }

    var body: some View {
        ZStack {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                Circle()
                    .trim(from: seg.start, to: seg.end)
                    .stroke(seg.color, style: StrokeStyle(lineWidth: 20, lineCap: .butt))
                    .rotationEffect(.degrees(-90))
            }
            VStack(spacing: 0) {
                Text(bnN(total)).font(.headline.weight(.bold))
                Text("total").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(width: 150, height: 150)
        .frame(maxWidth: .infinity)
        .animation(.spring(duration: 0.6, bounce: 0.1), value: slices.map { $0.1 })
    }

    private var segments: [(start: CGFloat, end: CGFloat, color: Color)] {
        var acc: CGFloat = 0
        return slices.map { s in
            let frac = CGFloat(s.1) / CGFloat(total)
            let seg = (start: acc, end: acc + frac, color: s.2)
            acc += frac
            return seg
        }
    }
}

// MARK: - Formatting

private enum DashFormat {
    private static let short = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    /// "2026-03" → "Mar".
    static func monthShort(_ ym: String) -> String {
        let parts = ym.split(separator: "-")
        guard parts.count >= 2, let m = Int(parts[1]), (1...12).contains(m) else { return ym }
        return short[m - 1]
    }
}

// MARK: - Aurora background + glass + shimmer (Dashboard-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is duplicated
// verbatim from the Finance/Orders spec).

@available(iOS 17.0, *)
private struct DashAurora: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ZStack {
            if scheme == .dark {
                LinearGradient(stops: [
                    .init(color: Color(red: 0.075, green: 0.063, blue: 0.196), location: 0.0),
                    .init(color: Color(red: 0.216, green: 0.125, blue: 0.439), location: 0.32),
                    .init(color: Color(red: 0.478, green: 0.176, blue: 0.494), location: 0.62),
                    .init(color: Color(red: 0.706, green: 0.255, blue: 0.404), location: 1.0),
                ], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [AlmaSwiftTheme.violet.opacity(0.35), .clear],
                               center: .init(x: 0.15, y: 0.18), startRadius: 10, endRadius: 420)
                RadialGradient(colors: [Color(red: 0.93, green: 0.42, blue: 0.55).opacity(0.30), .clear],
                               center: .init(x: 0.9, y: 0.85), startRadius: 20, endRadius: 480)
            } else {
                AlmaSwiftTheme.rootBg(.light)
                LinearGradient(stops: [
                    .init(color: Color(red: 0.902, green: 0.882, blue: 0.973), location: 0.0),
                    .init(color: Color(red: 0.949, green: 0.941, blue: 0.972), location: 0.45),
                    .init(color: Color(red: 0.988, green: 0.918, blue: 0.925), location: 1.0),
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
    func dashGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct DashShimmer: ViewModifier {
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        content
            .overlay(
                LinearGradient(colors: [.clear, .white.opacity(0.25), .clear],
                               startPoint: .leading, endPoint: .trailing)
                    .offset(x: phase * 320).clipped())
            .onAppear {
                withAnimation(.linear(duration: 1.15).repeatForever(autoreverses: false)) { phase = 1.5 }
            }
    }
}

@available(iOS 17.0, *)
private extension View {
    func dashShimmer() -> some View { modifier(DashShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Dashboard — Light") {
    DashboardScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}

@available(iOS 17.0, *)
#Preview("Dashboard — Dark") {
    DashboardScreen(openWeb: { _, _ in }).preferredColorScheme(.dark)
}
