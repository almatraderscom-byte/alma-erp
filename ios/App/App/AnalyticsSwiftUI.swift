//
//  AnalyticsSwiftUI.swift
//  ALMA ERP — the Analytics tab as a native SwiftUI screen (web /analytics parity).
//
//  Mirrors the web /analytics page — same endpoint, same numbers, same blocks:
//    GET /api/analytics?business_id=…&startDate=…&endDate=…  → DashboardData
//        (kpis · by_status · by_source · by_payment · by_category ·
//         monthly_trend · expense_by_cat · total_expenses)
//  Web-parity blocks: date-range preset chips (the web DateRangeFilter) · KPI strip
//  (Total Revenue / Net Profit / Gross Margin / Avg Order Value + return KPIs) ·
//  Revenue vs Profit trend (native gradient bars, tap a month → detail sheet) ·
//  Orders by Status · Orders by Channel · Payment Method Mix (brand colours) ·
//  Expense Breakdown · Category Performance (ranked list, rank badges).
//  READ-ONLY by design: every deeper flow stays on the web escape hatch.
//  Money is whole-taka BDT (৳ / AlmaSwiftTheme.takaShort).
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum AnalyticsPalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80

    /// Web category PALETTE ['#E07A5F','#C45A3C','#F4A28C','#D4956A','#8B5E3C','#A0644A'].
    static let series: [Color] = [
        coral, goldDim, goldLt,
        Color(red: 0.831, green: 0.584, blue: 0.416),   // #D4956A
        Color(red: 0.545, green: 0.369, blue: 0.235),   // #8B5E3C
        Color(red: 0.627, green: 0.392, blue: 0.290),   // #A0644A
    ]

    /// Web paymentPie COLORS — bKash pink, Nagad orange, etc.
    static func payment(_ name: String) -> Color {
        switch name {
        case "COD": return Color(red: 0.961, green: 0.651, blue: 0.137)            // #F5A623
        case "bKash": return Color(red: 0.910, green: 0.208, blue: 0.478)          // #E8357A
        case "Nagad": return Color(red: 0.957, green: 0.384, blue: 0.137)          // #F46223
        case "Rocket": return Color(red: 0.545, green: 0.361, blue: 0.965)         // #8B5CF6
        case "Bank Transfer": return Color(red: 0.290, green: 0.620, blue: 1.0)    // #4A9EFF
        case "Card": return Color(red: 0.180, green: 0.800, blue: 0.443)           // #2ECC71
        default: return Color(red: 0.612, green: 0.639, blue: 0.686)               // #9CA3AF
        }
    }

    /// Order status tones (web badge colours family).
    static func status(_ s: String) -> Color {
        switch s.uppercased() {
        case "DELIVERED", "PAID", "COMPLETED": return emerald600
        case "RETURNED", "CANCELLED", "FAILED", "FAILED_DELIVERY": return red500
        case "PENDING", "PROCESSING", "IN_TRANSIT", "SHIPPED": return amber500
        default: return coral
        }
    }

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
    /// Web "txt-pos" (positive money) — emerald on cream, bright green over dark aurora.
    static func positive(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? green400 : emerald600
    }
    /// Signed money tone: positive green, negative red.
    static func signed(_ amount: Int, _ scheme: ColorScheme) -> Color {
        amount < 0 ? red500 : positive(scheme)
    }
}

// MARK: - Lenient decode helpers (numbers may arrive as strings/decimals)

private func analyticsFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) {
        if let i = Int(s) { return i }
        if let d = Double(s) { return Int(d.rounded()) }
    }
    return nil
}

private func analyticsFlexDouble<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
    return nil
}

/// Single lenient number for map values (`by_status`, `by_payment`, `expense_by_cat`).
struct AnalyticsFlexNumber: Decodable, Equatable {
    let value: Int
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let i = try? c.decode(Int.self) { value = i }
        else if let d = try? c.decode(Double.self) { value = Int(d.rounded()) }
        else if let s = try? c.decode(String.self) { value = Int(s) ?? Int(Double(s)?.rounded() ?? 0) }
        else { value = 0 }
    }
}

// MARK: - Models (same field names the web DashboardData type declares)

struct AnalyticsKpis: Decodable, Equatable {
    let totalOrders: Int
    let totalRevenue: Int
    let totalProfit: Int
    let totalCogs: Int
    let grossMargin: Double
    let avgOrderValue: Int
    let deliveredCount: Int
    let deliveryRate: Double
    let returnRate: Double
    let netBusinessProfit: Int?
    let totalReturnsLoss: Int?
    let returnedUnpaidCount: Int?
    let returnRatePaid: Double?
    let returnRateRefused: Double?

    private enum Keys: String, CodingKey {
        case totalOrders = "total_orders"
        case totalRevenue = "total_revenue"
        case totalProfit = "total_profit"
        case totalCogs = "total_cogs"
        case grossMargin = "gross_margin"
        case avgOrderValue = "avg_order_value"
        case deliveredCount = "delivered_count"
        case deliveryRate = "delivery_rate"
        case returnRate = "return_rate"
        case netBusinessProfit = "net_business_profit"
        case totalReturnsLoss = "total_returns_loss"
        case returnedUnpaidCount = "returned_unpaid_count"
        case returnRatePaid = "return_rate_paid"
        case returnRateRefused = "return_rate_refused"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        totalOrders = analyticsFlexInt(c, .totalOrders) ?? 0
        totalRevenue = analyticsFlexInt(c, .totalRevenue) ?? 0
        totalProfit = analyticsFlexInt(c, .totalProfit) ?? 0
        totalCogs = analyticsFlexInt(c, .totalCogs) ?? 0
        grossMargin = analyticsFlexDouble(c, .grossMargin) ?? 0
        avgOrderValue = analyticsFlexInt(c, .avgOrderValue) ?? 0
        deliveredCount = analyticsFlexInt(c, .deliveredCount) ?? 0
        deliveryRate = analyticsFlexDouble(c, .deliveryRate) ?? 0
        returnRate = analyticsFlexDouble(c, .returnRate) ?? 0
        netBusinessProfit = analyticsFlexInt(c, .netBusinessProfit)
        totalReturnsLoss = analyticsFlexInt(c, .totalReturnsLoss)
        returnedUnpaidCount = analyticsFlexInt(c, .returnedUnpaidCount)
        returnRatePaid = analyticsFlexDouble(c, .returnRatePaid)
        returnRateRefused = analyticsFlexDouble(c, .returnRateRefused)
    }
}

/// by_source values: `{ orders, revenue }`.
struct AnalyticsSourceStat: Decodable, Equatable {
    let orders: Int
    let revenue: Int
    private enum Keys: String, CodingKey { case orders, revenue }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        orders = analyticsFlexInt(c, .orders) ?? 0
        revenue = analyticsFlexInt(c, .revenue) ?? 0
    }
}

/// by_category values: `{ orders, revenue, profit }` (web adds margin client-side).
struct AnalyticsCategoryStat: Decodable, Equatable {
    let orders: Int
    let revenue: Int
    let profit: Int
    private enum Keys: String, CodingKey { case orders, revenue, profit }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        orders = analyticsFlexInt(c, .orders) ?? 0
        revenue = analyticsFlexInt(c, .revenue) ?? 0
        profit = analyticsFlexInt(c, .profit) ?? 0
    }
}

/// monthly_trend points: `{ month, revenue, profit, orders, cogs }`.
struct AnalyticsTrendPoint: Decodable, Identifiable, Equatable {
    let month: String        // "2026-03"
    let revenue: Int
    let profit: Int
    let orders: Int
    let cogs: Int
    var id: String { month }

    private enum Keys: String, CodingKey { case month, revenue, profit, orders, cogs }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        month = (try? c.decode(String.self, forKey: .month)) ?? ""
        revenue = analyticsFlexInt(c, .revenue) ?? 0
        profit = analyticsFlexInt(c, .profit) ?? 0
        orders = analyticsFlexInt(c, .orders) ?? 0
        cogs = analyticsFlexInt(c, .cogs) ?? 0
    }
}

/// GET /api/analytics — flat payload on the web, but decode an `{ok,data:{…}}`
/// wrapper too in case the route is ever normalized (same tolerance the pattern uses).
struct AnalyticsResponse: Decodable {
    let kpis: AnalyticsKpis?
    let byStatus: [String: Int]
    let bySource: [String: AnalyticsSourceStat]
    let byPayment: [String: Int]
    let byCategory: [String: AnalyticsCategoryStat]
    let monthlyTrend: [AnalyticsTrendPoint]
    let expenseByCat: [String: Int]
    let totalExpenses: Int?

    private enum Keys: String, CodingKey {
        case ok, data, kpis
        case byStatus = "by_status"
        case bySource = "by_source"
        case byPayment = "by_payment"
        case byCategory = "by_category"
        case monthlyTrend = "monthly_trend"
        case expenseByCat = "expense_by_cat"
        case totalExpenses = "total_expenses"
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        kpis = try? c.decodeIfPresent(AnalyticsKpis.self, forKey: .kpis)
        let status = (try? c.decodeIfPresent([String: AnalyticsFlexNumber].self, forKey: .byStatus)) ?? [:]
        byStatus = (status ?? [:]).mapValues(\.value)
        bySource = ((try? c.decodeIfPresent([String: AnalyticsSourceStat].self, forKey: .bySource)) ?? [:]) ?? [:]
        let payment = (try? c.decodeIfPresent([String: AnalyticsFlexNumber].self, forKey: .byPayment)) ?? [:]
        byPayment = (payment ?? [:]).mapValues(\.value)
        byCategory = ((try? c.decodeIfPresent([String: AnalyticsCategoryStat].self, forKey: .byCategory)) ?? [:]) ?? [:]
        monthlyTrend = ((try? c.decodeIfPresent([AnalyticsTrendPoint].self, forKey: .monthlyTrend)) ?? []) ?? []
        let expenses = (try? c.decodeIfPresent([String: AnalyticsFlexNumber].self, forKey: .expenseByCat)) ?? [:]
        expenseByCat = (expenses ?? [:]).mapValues(\.value)
        totalExpenses = analyticsFlexInt(c, .totalExpenses)
    }
}

// MARK: - Date presets (web DateRangeFilter parity — default last30)

enum AnalyticsDatePreset: String, CaseIterable {
    case today, yesterday, last7, last30, thisMonth, lastMonth

    /// Same labels the web DATE_PRESETS table uses ("Custom" stays on the web).
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

    private static var dhakaCalendar: Calendar {
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
        let cal = Self.dhakaCalendar
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
final class AnalyticsVM {
    var data: AnalyticsResponse? = nil
    var preset: AnalyticsDatePreset = .last30    // web default (DateRangeContext 'last30')
    var loading = false
    var error: String? = nil
    var authExpired = false

    /// The same business the other native tabs scope to (web _businessId default).
    static let businessId = "ALMA_LIFESTYLE"

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        let range = preset.range()
        do {
            let resp: AnalyticsResponse = try await AlmaAPI.shared.get(
                "/api/analytics",
                query: [
                    "business_id": Self.businessId,
                    "startDate": range.start,
                    "endDate": range.end,
                ])
            withAnimation(.spring(duration: 0.4, bounce: 0.15)) { data = resp }
            authExpired = false
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

    // Sorted derivations the sections render.

    var statusRows: [(name: String, count: Int)] {
        (data?.byStatus ?? [:]).map { ($0.key, $0.value) }.sorted { $0.1 > $1.1 }
    }
    var sourceRows: [(name: String, stat: AnalyticsSourceStat)] {
        (data?.bySource ?? [:]).map { ($0.key, $0.value) }.sorted { $0.1.revenue > $1.1.revenue }
    }
    /// Web paymentPie: each method as a rounded % of all payments.
    var paymentRows: [(name: String, pct: Int)] {
        let map = data?.byPayment ?? [:]
        let total = map.values.reduce(0, +)
        guard total > 0 else { return [] }
        return map.map { ($0.key, Int((Double($0.value) / Double(total) * 100).rounded())) }
            .sorted { $0.1 > $1.1 }
    }
    var expenseRows: [(name: String, amount: Int)] {
        (data?.expenseByCat ?? [:]).map { ($0.key, $0.value) }.sorted { $0.1 > $1.1 }
    }
    /// Web catArr: by_category + client-side margin, sorted by revenue.
    var categoryRows: [(name: String, stat: AnalyticsCategoryStat, margin: Int)] {
        (data?.byCategory ?? [:])
            .map { (name: $0.key, stat: $0.value,
                    margin: $0.value.revenue > 0
                        ? Int((Double($0.value.profit) / Double($0.value.revenue) * 100).rounded())
                        : 0) }
            .sorted { $0.stat.revenue > $1.stat.revenue }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct AnalyticsScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = AnalyticsVM()
    @State private var selectedMonth: AnalyticsTrendPoint? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                presetChips
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err) }
                if vm.loading && vm.data == nil {
                    loadingRows
                } else {
                    kpiGrid
                    returnKpiStrip
                    trendCard
                    statusCard
                    channelCard
                    paymentCard
                    expenseCard
                    categoryCard
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(AnalyticsAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selectedMonth) { p in
            AnalyticsMonthDetailSheet(point: p)
                .presentationDetents([.height(380)])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Date preset chips (web DateRangeFilter) ──

    private var presetChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(AnalyticsDatePreset.allCases, id: \.rawValue) { p in
                    analyticsChip(p.label, active: vm.preset == p) {
                        vm.preset = p
                        Task { await vm.load() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .padding(.top, 4)
    }

    // ── KPI grid (web's 4 KpiCards + operational extras, 2-column on phone) ──

    private var kpiGrid: some View {
        let k = vm.data?.kpis
        let netProfit = k?.netBusinessProfit ?? k?.totalProfit
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())],
                         spacing: 10) {
            kpiCard("Total Revenue", money(k?.totalRevenue), AnalyticsPalette.goldLt)
            kpiCard("Net Profit (MTD)", money(netProfit),
                    AnalyticsPalette.signed(netProfit ?? 0, colorScheme))
            kpiCard("Gross Margin", percent(k?.grossMargin),
                    AnalyticsPalette.accentText(colorScheme))
            kpiCard("Avg Order Value", money(k?.avgOrderValue), .primary)
            kpiCard("Total Orders", k.map { "\($0.totalOrders.formatted())" } ?? "—", .primary)
            kpiCard("Delivery Rate", percent(k?.deliveryRate), .primary)
        }
    }

    /// Web's second KPI row (Return Loss / Return Rate / Refused Returns).
    @ViewBuilder private var returnKpiStrip: some View {
        if let k = vm.data?.kpis {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    kpiCard("Return Loss", money(k.totalReturnsLoss ?? 0),
                            (k.totalReturnsLoss ?? 0) > 0 ? AnalyticsPalette.red500 : .primary,
                            fixedWidth: true)
                    kpiCard("Return Rate", percent(k.returnRate), .primary,
                            sub: "\(Int((k.returnRatePaid ?? 0).rounded()))% paid · \(Int((k.returnRateRefused ?? 0).rounded()))% refused",
                            fixedWidth: true)
                    kpiCard("Refused Returns", "\((k.returnedUnpaidCount ?? 0).formatted())",
                            (k.returnedUnpaidCount ?? 0) > 0 ? AnalyticsPalette.red500 : .primary,
                            fixedWidth: true)
                }
                .padding(.horizontal, 2)
                .padding(.vertical, 1)
            }
        }
    }

    private func money(_ amount: Int?) -> String {
        guard let amount else { return "—" }
        return AlmaSwiftTheme.takaShort(amount)
    }

    private func percent(_ value: Double?) -> String {
        guard let value else { return "—" }
        return "\(Int(value.rounded()))%"
    }

    private func kpiCard(_ label: String, _ value: String, _ tint: Color,
                         sub: String? = nil, fixedWidth: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.8)
            Text(value)
                .font(.headline.weight(.bold).monospacedDigit())
                .foregroundStyle(tint)
            if let sub {
                Text(sub).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(minWidth: fixedWidth ? 120 : nil,
               maxWidth: fixedWidth ? nil : .infinity, alignment: .leading)
        .padding(12)
        .analyticsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Revenue vs Profit trend (native gradient bars; tap a month → detail sheet) ──

    private var trendCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Revenue vs Profit Trend").font(.subheadline.weight(.bold))
            Text("Monthly · live data").font(.caption2).foregroundStyle(.secondary)
            if let points = vm.data?.monthlyTrend, !points.isEmpty {
                AnalyticsTrendBars(points: points) { p in
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    selectedMonth = p
                }
                .padding(.top, 10)
                legend
            } else {
                emptyBlock("◈", "No trend data yet", "Revenue chart appears after orders are placed")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .analyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var legend: some View {
        HStack(spacing: 14) {
            legendDot(AnalyticsPalette.coral, "Revenue")
            legendDot(AnalyticsPalette.positive(colorScheme), "Profit")
            Spacer()
            Text("মাস চাপলে বিস্তারিত").font(.caption2).foregroundStyle(.secondary)
        }
        .padding(.top, 8)
    }

    private func legendDot(_ color: Color, _ label: String) -> some View {
        HStack(spacing: 4) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }

    // ── Orders by Status (horizontal tinted bars) ──

    private var statusCard: some View {
        let rows = vm.statusRows
        let maxCount = max(rows.map(\.count).max() ?? 1, 1)
        return VStack(alignment: .leading, spacing: 10) {
            Text("Orders by Status").font(.subheadline.weight(.bold))
            if rows.isEmpty {
                emptyBlock("◩", "No status data", "Appears once orders are placed")
            } else {
                ForEach(rows, id: \.name) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(row.name.replacingOccurrences(of: "_", with: " "))
                                .font(.caption.weight(.semibold))
                            Spacer()
                            Text("\(row.count)")
                                .font(.caption.weight(.bold).monospacedDigit())
                                .foregroundStyle(AnalyticsPalette.status(row.name))
                        }
                        analyticsHBar(fraction: Double(row.count) / Double(maxCount),
                                      color: AnalyticsPalette.status(row.name))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .analyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Orders by Channel (web card: orders + revenue + gold progress bar) ──

    private var channelCard: some View {
        let rows = vm.sourceRows
        let totalRevenue = max(vm.data?.kpis?.totalRevenue ?? 1, 1)
        return VStack(alignment: .leading, spacing: 12) {
            Text("Orders by Channel").font(.subheadline.weight(.bold))
            if rows.isEmpty {
                emptyBlock("◩", "No channel data", "Appears once orders are placed")
            } else {
                ForEach(rows, id: \.name) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(row.name).font(.caption.weight(.semibold))
                            Spacer()
                            Text("\(row.stat.orders) orders")
                                .font(.caption2).foregroundStyle(.secondary)
                            Text(money(row.stat.revenue))
                                .font(.caption.weight(.bold).monospacedDigit())
                                .foregroundStyle(AnalyticsPalette.accentText(colorScheme))
                        }
                        analyticsHBar(fraction: Double(row.stat.revenue) / Double(totalRevenue),
                                      color: AnalyticsPalette.coral)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .analyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Payment Method Mix (web donut, re-set as brand-coloured % bars) ──

    private var paymentCard: some View {
        let rows = vm.paymentRows
        return VStack(alignment: .leading, spacing: 12) {
            Text("Payment Method Mix").font(.subheadline.weight(.bold))
            if rows.isEmpty {
                emptyBlock("◈", "No payment data", "Appears once orders are placed")
            } else {
                ForEach(rows, id: \.name) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(AnalyticsPalette.payment(row.name))
                                .frame(width: 8, height: 8)
                            Text(row.name).font(.caption.weight(.semibold))
                            Spacer()
                            Text("\(row.pct)%")
                                .font(.caption.weight(.bold).monospacedDigit())
                        }
                        analyticsHBar(fraction: Double(row.pct) / 100,
                                      color: AnalyticsPalette.payment(row.name))
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .analyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Expense Breakdown (web ExpenseBarChart, re-set as sorted bars) ──

    private var expenseCard: some View {
        let rows = vm.expenseRows
        let maxAmount = max(rows.map(\.amount).max() ?? 1, 1)
        let total = vm.data?.totalExpenses ?? 0
        return VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Expense Breakdown").font(.subheadline.weight(.bold))
                Text(total > 0 ? "\(fullTaka(total)) total · live data" : "No expense data yet")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if rows.isEmpty {
                emptyBlock("◫", "No expenses recorded", "Appears after expenses are logged")
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.name) { i, row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(row.name).font(.caption.weight(.semibold))
                            Spacer()
                            Text(fullTaka(row.amount))
                                .font(.caption.weight(.bold).monospacedDigit())
                        }
                        analyticsHBar(fraction: Double(row.amount) / Double(maxAmount),
                                      color: AnalyticsPalette.series[i % AnalyticsPalette.series.count])
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .analyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Category Performance (web table, re-set as a ranked list with rank badges) ──

    private var categoryCard: some View {
        let rows = vm.categoryRows
        return VStack(alignment: .leading, spacing: 12) {
            Text("Category Performance").font(.subheadline.weight(.bold))
            if rows.isEmpty {
                emptyBlock("◧", "No category data", "Appears once orders are placed")
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.name) { i, row in
                    categoryRow(rank: i + 1, row: row)
                    if i < rows.count - 1 { Divider().opacity(0.35) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .analyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func categoryRow(rank: Int,
                             row: (name: String, stat: AnalyticsCategoryStat, margin: Int)) -> some View {
        HStack(spacing: 10) {
            // Rank badge — top seller gets the coral→violet gradient like the app's icons.
            Text("\(rank)")
                .font(.caption.weight(.bold).monospacedDigit())
                .foregroundStyle(rank <= 3 ? .white : Color.secondary)
                .frame(width: 26, height: 26)
                .background(
                    rank <= 3
                        ? AnyShapeStyle(LinearGradient(
                            colors: [AnalyticsPalette.coral, AlmaSwiftTheme.violet],
                            startPoint: .topLeading, endPoint: .bottomTrailing))
                        : AnyShapeStyle(Color.primary.opacity(0.06)),
                    in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(row.name).font(.footnote.weight(.semibold)).lineLimit(1)
                    Spacer()
                    Text(money(row.stat.revenue))
                        .font(.footnote.weight(.bold).monospacedDigit())
                }
                HStack(spacing: 8) {
                    Text("\(row.stat.orders) orders").font(.caption2).foregroundStyle(.secondary)
                    Text(fullTaka(row.stat.profit))
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(AnalyticsPalette.signed(row.stat.profit, colorScheme))
                    Spacer()
                    analyticsHBar(fraction: Double(max(min(row.margin, 100), 0)) / 100,
                                  color: AnalyticsPalette.goldLt, height: 4)
                        .frame(width: 56)
                    Text("\(row.margin)%")
                        .font(.caption2.weight(.bold).monospacedDigit())
                        .foregroundStyle(AnalyticsPalette.accentText(colorScheme))
                        .frame(width: 34, alignment: .trailing)
                }
            }
        }
    }

    // ── Shared bits ──

    /// Track-and-fill horizontal bar (the web's rounded progress bars).
    private func analyticsHBar(fraction: Double, color: Color, height: CGFloat = 6) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.07))
                Capsule()
                    .fill(LinearGradient(colors: [color.opacity(0.85), color],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(geo.size.width * min(max(fraction, 0), 1), fraction > 0 ? 3 : 0))
            }
        }
        .frame(height: height)
    }

    private func fullTaka(_ amount: Int) -> String {
        (amount < 0 ? "-৳" : "৳") + abs(amount).formatted()
    }

    private func emptyBlock(_ glyph: String, _ title: String, _ desc: String) -> some View {
        VStack(spacing: 4) {
            Text(glyph).font(.title2).foregroundStyle(.secondary)
            Text(title).font(.footnote.weight(.semibold))
            Text(desc).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 26)
    }

    private func analyticsChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? AnalyticsPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? AnalyticsPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? AnalyticsPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(AnalyticsPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).analyticsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .analyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 110)
                .analyticsGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .analyticsShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/analytics", "Analytics")
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

// MARK: - Trend bars (native re-set of the web RevenueChart — the Finance bar look)

@available(iOS 17.0, *)
private struct AnalyticsTrendBars: View {
    let points: [AnalyticsTrendPoint]
    let onSelect: (AnalyticsTrendPoint) -> Void
    @Environment(\.colorScheme) private var colorScheme

    private var maxRevenue: Int { max(points.map(\.revenue).max() ?? 1, 1) }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .bottom, spacing: 10) {
                ForEach(points) { p in
                    bar(p)
                }
            }
            .padding(.horizontal, 2)
        }
        .animation(.spring(duration: 0.45, bounce: 0.2), value: points)
    }

    private func bar(_ p: AnalyticsTrendPoint) -> some View {
        let h = max(CGFloat(p.revenue) / CGFloat(maxRevenue) * 120, 3)
        let ph = p.revenue > 0
            ? max(CGFloat(max(p.profit, 0)) / CGFloat(maxRevenue) * 120, p.profit > 0 ? 3 : 0)
            : 0
        return VStack(spacing: 4) {
            Text(AlmaSwiftTheme.takaShort(p.revenue))
                .font(.system(size: 8, weight: .semibold).monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1).fixedSize()
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(LinearGradient(colors: [AnalyticsPalette.goldLt, AnalyticsPalette.coral],
                                         startPoint: .top, endPoint: .bottom))
                    .frame(width: 26, height: h)
                if ph > 0 {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(AnalyticsPalette.positive(colorScheme).opacity(0.9))
                        .frame(width: 10, height: ph)
                        .padding(.bottom, 0)
                }
            }
            .frame(height: 124, alignment: .bottom)
            Text(AnalyticsFormat.monthShort(p.month))
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .onTapGesture { onSelect(p) }
    }
}

// MARK: - Month detail sheet (tap a trend bar — view-only breakdown)

@available(iOS 17.0, *)
private struct AnalyticsMonthDetailSheet: View {
    let point: AnalyticsTrendPoint
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    private var margin: Int {
        point.revenue > 0 ? Int((Double(point.profit) / Double(point.revenue) * 100).rounded()) : 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text(AnalyticsFormat.monthLong(point.month)).font(.headline)
                Text("মাসিক আয়-ব্যয়ের বিবরণ").font(.caption).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 10) {
                detailRow("Revenue", "৳" + point.revenue.formatted(), .primary)
                detailRow("COGS", "৳" + point.cogs.formatted(), .primary)
                detailRow("Profit",
                          (point.profit < 0 ? "-৳" : "৳") + abs(point.profit).formatted(),
                          AnalyticsPalette.signed(point.profit, colorScheme))
                detailRow("Orders", "\(point.orders.formatted())", .primary)
                Divider().opacity(0.4)
                HStack {
                    Text("MARGIN").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                    Spacer()
                    Text("\(margin)%")
                        .font(.footnote.monospaced().weight(.bold))
                        .foregroundStyle(AnalyticsPalette.accentText(colorScheme))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .analyticsGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            Button {
                dismiss()
            } label: {
                Text("ঠিক আছে")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(AnalyticsPalette.coral)
            Spacer(minLength: 0)
        }
        .padding(18)
        .presentationBackground { AnalyticsAurora() }
    }

    private func detailRow(_ label: String, _ value: String, _ tint: Color) -> some View {
        HStack {
            Text(label.uppercased()).font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.footnote.monospaced().weight(.semibold))
                .foregroundStyle(tint)
        }
    }
}

// MARK: - Formatting helpers

private enum AnalyticsFormat {
    private static let shortNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    private static let longNames = ["January", "February", "March", "April", "May", "June",
                                    "July", "August", "September", "October", "November", "December"]

    /// "2026-03" → "Mar".
    static func monthShort(_ ym: String) -> String {
        let parts = ym.split(separator: "-")
        guard parts.count >= 2, let m = Int(parts[1]), (1...12).contains(m) else { return ym }
        return shortNames[m - 1]
    }

    /// "2026-03" → "March 2026".
    static func monthLong(_ ym: String) -> String {
        let parts = ym.split(separator: "-")
        guard parts.count >= 2, let m = Int(parts[1]), (1...12).contains(m) else { return ym }
        return "\(longNames[m - 1]) \(parts[0])"
    }
}

// MARK: - Aurora background + glass (Analytics-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct AnalyticsAurora: View {
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
    func analyticsGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct AnalyticsShimmer: ViewModifier {
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
    func analyticsShimmer() -> some View { modifier(AnalyticsShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Analytics — Light") {
    AnalyticsScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
