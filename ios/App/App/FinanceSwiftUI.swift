//
//  FinanceSwiftUI.swift
//  ALMA ERP — the Finance hub as a native SwiftUI screen (web /finance parity).
//
//  Mirrors the web /finance page 1:1 — same endpoints, same numbers, same blocks:
//    GET /api/finance/report?business_id=…&startDate=…&endDate=…  → FinancialReport
//        (profit_loss · monthly_revenue · cashflow · period_label)
//    GET /api/hr/dashboard?business_id=…&startDate=…&endDate=…    → { kpis: … }
//  Web-parity blocks: date-range preset chips (the web DateRangeFilter) · KPI grid
//  (Revenue/Expenses/Net profit/Margin + Payroll budget/Unpaid/Advances/Order GP) ·
//  Revenue & margin trend (native bars, tap a month for the detail sheet) ·
//  Cashflow (report) · Payroll snapshot · quick links (Expenses / Office Fund /
//  Payroll → web). VIEW-ONLY by design: every mutating flow stays on the web
//  escape hatch. Money is whole-taka BDT (৳ / AlmaSwiftTheme.takaShort).
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum FinancePalette {
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

private func financeFlexInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Int? {
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) {
        if let i = Int(s) { return i }
        if let d = Double(s) { return Int(d.rounded()) }
    }
    return nil
}

private func financeFlexDouble<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ k: K) -> Double? {
    if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return d }
    if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return Double(i) }
    if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Double(s) }
    return nil
}

// MARK: - Models (same field names the web FinancialReport / HRDashboardApi declare)

struct FinanceMonthlyPoint: Decodable, Identifiable, Equatable {
    let month: String        // "2026-03"
    let revenue: Int
    let profit: Int
    let expenses: Int
    var id: String { month }

    private enum Keys: String, CodingKey { case month, revenue, profit, expenses }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        month = (try? c.decode(String.self, forKey: .month)) ?? ""
        revenue = financeFlexInt(c, .revenue) ?? 0
        profit = financeFlexInt(c, .profit) ?? 0
        expenses = financeFlexInt(c, .expenses) ?? 0
    }
}

struct FinanceProfitLoss: Decodable, Equatable {
    let revenue: Int
    let cogs: Int
    let expenses: Int
    let netProfit: Int
    let marginPct: Double

    private enum Keys: String, CodingKey {
        case revenue, cogs, expenses
        case netProfit = "net_profit"
        case marginPct = "margin_pct"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        revenue = financeFlexInt(c, .revenue) ?? 0
        cogs = financeFlexInt(c, .cogs) ?? 0
        expenses = financeFlexInt(c, .expenses) ?? 0
        netProfit = financeFlexInt(c, .netProfit) ?? 0
        marginPct = financeFlexDouble(c, .marginPct) ?? 0
    }
}

struct FinanceCashflow: Decodable, Equatable {
    let inflow: Int
    let outflow: Int
    let net: Int

    private enum Keys: String, CodingKey { case inflow, outflow, net }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        inflow = financeFlexInt(c, .inflow) ?? 0
        outflow = financeFlexInt(c, .outflow) ?? 0
        net = financeFlexInt(c, .net) ?? 0
    }
}

/// GET /api/finance/report — flat payload on the web, but decode an `{ok,data:{…}}`
/// wrapper too in case the route is ever normalized (same tolerance the pattern uses).
struct FinanceReport: Decodable {
    let periodLabel: String?
    let monthlyRevenue: [FinanceMonthlyPoint]
    let profitLoss: FinanceProfitLoss?
    let cashflow: FinanceCashflow?

    private enum Keys: String, CodingKey {
        case ok, data
        case periodLabel = "period_label"
        case monthlyRevenue = "monthly_revenue"
        case profitLoss = "profit_loss"
        case cashflow
    }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        periodLabel = try? c.decodeIfPresent(String.self, forKey: .periodLabel)
        monthlyRevenue = (try? c.decodeIfPresent([FinanceMonthlyPoint].self, forKey: .monthlyRevenue)) ?? []
        profitLoss = try? c.decodeIfPresent(FinanceProfitLoss.self, forKey: .profitLoss)
        cashflow = try? c.decodeIfPresent(FinanceCashflow.self, forKey: .cashflow)
    }
}

/// The kpis slice of GET /api/hr/dashboard the web finance page renders.
struct FinanceHRKpis: Decodable, Equatable {
    let totalMonthlySalary: Int
    let unpaidSalaryHint: Int
    let advanceOutstanding: Int
    let orderGrossProfit: Int?
    let netBusinessProfitHint: Int?
    let periodSalaryPaid: Int?
    let periodAdvances: Int?
    let totalExpenses: Int

    private enum Keys: String, CodingKey {
        case totalMonthlySalary = "total_monthly_salary"
        case unpaidSalaryHint = "unpaid_salary_hint"
        case advanceOutstanding = "advance_outstanding"
        case orderGrossProfit = "order_gross_profit"
        case netBusinessProfitHint = "net_business_profit_hint"
        case periodSalaryPaid = "period_salary_paid"
        case periodAdvances = "period_advances"
        case totalExpenses = "total_expenses"
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        totalMonthlySalary = financeFlexInt(c, .totalMonthlySalary) ?? 0
        unpaidSalaryHint = financeFlexInt(c, .unpaidSalaryHint) ?? 0
        advanceOutstanding = financeFlexInt(c, .advanceOutstanding) ?? 0
        orderGrossProfit = financeFlexInt(c, .orderGrossProfit)
        netBusinessProfitHint = financeFlexInt(c, .netBusinessProfitHint)
        periodSalaryPaid = financeFlexInt(c, .periodSalaryPaid)
        periodAdvances = financeFlexInt(c, .periodAdvances)
        totalExpenses = financeFlexInt(c, .totalExpenses) ?? 0
    }
}

struct FinanceHRDashboardResponse: Decodable {
    let kpis: FinanceHRKpis?
    private enum Keys: String, CodingKey { case ok, data, kpis }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        kpis = try? c.decodeIfPresent(FinanceHRKpis.self, forKey: .kpis)
    }
}

// MARK: - Date presets (web DateRangeFilter parity — default last30)

enum FinanceDatePreset: String, CaseIterable {
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
final class FinanceVM {
    var report: FinanceReport? = nil
    var kpis: FinanceHRKpis? = nil
    var preset: FinanceDatePreset = .last30      // web default (DateRangeContext 'last30')
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
        let query: [String: String?] = [
            "business_id": Self.businessId,
            "startDate": range.start,
            "endDate": range.end,
        ]
        do {
            async let reportTask: FinanceReport =
                AlmaAPI.shared.get("/api/finance/report", query: query)
            async let hrTask: FinanceHRDashboardResponse =
                AlmaAPI.shared.get("/api/hr/dashboard", query: query)
            let (r, h) = try await (reportTask, hrTask)
            withAnimation(.spring(duration: 0.4, bounce: 0.15)) {
                report = r
                kpis = h.kpis
            }
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
}

// MARK: - Screen

@available(iOS 17.0, *)
struct FinanceScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = FinanceVM()
    @State private var selectedMonth: FinanceMonthlyPoint? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                presetChips
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err) }
                if vm.loading && vm.report == nil && vm.kpis == nil {
                    loadingRows
                } else {
                    kpiGrid
                    trendCard
                    cashflowCard
                    payrollSnapshotCard
                    quickLinks
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(FinanceAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selectedMonth) { p in
            FinanceMonthDetailSheet(point: p)
                .presentationDetents([.height(360)])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Date preset chips (web DateRangeFilter) ──

    private var presetChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(FinanceDatePreset.allCases, id: \.rawValue) { p in
                    financeChip(p.label, active: vm.preset == p) {
                        vm.preset = p
                        Task { await vm.load() }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
        .padding(.top, 4)
    }

    // ── KPI board (web's two 4-card rows) — bento language (owner spec 2026-07-08):
    //    row 1 (Revenue/Expenses/Net profit/Margin) = the dark hero anchor,
    //    row 2 (Payroll budget/Unpaid/Advances/Order GP) = 2×2 glass stat tiles.
    //    Same numbers, same nil fallbacks, same tint rules — presentation only. ──

    private var kpiGrid: some View {
        let pl = vm.report?.profitLoss
        let k = vm.kpis
        return VStack(spacing: 10) {
            FinBentoHeroCard(revenue: pl?.revenue,
                             expenses: pl?.expenses ?? k?.totalExpenses,
                             netProfit: pl?.netProfit ?? k?.netBusinessProfitHint,
                             marginPct: pl.map { Int($0.marginPct.rounded()) })
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible())],
                      spacing: 10) {
                FinBentoStatTile(label: "Payroll budget", target: k?.totalMonthlySalary,
                                 format: { AlmaSwiftTheme.takaShort($0) },
                                 sub: "মাসিক বেতন বাজেট",
                                 tint: .primary, accent: AlmaSwiftTheme.violet)
                FinBentoStatTile(label: "Unpaid / due (roll)", target: k?.unpaidSalaryHint,
                                 format: { AlmaSwiftTheme.takaShort($0) },
                                 sub: "বকেয়া / ডিউ",
                                 tint: (k?.unpaidSalaryHint ?? 0) > 0 ? FinancePalette.amber600 : .primary,
                                 accent: FinancePalette.amber500)
                FinBentoStatTile(label: "Advances out", target: k?.advanceOutstanding,
                                 format: { AlmaSwiftTheme.takaShort($0) },
                                 sub: "অ্যাডভান্স বাকি",
                                 tint: .primary, accent: FinancePalette.coral)
                FinBentoStatTile(label: "Order gross profit", target: k?.orderGrossProfit,
                                 format: { AlmaSwiftTheme.takaShort($0) },
                                 sub: "অর্ডার গ্রস প্রফিট",
                                 tint: FinancePalette.signed(k?.orderGrossProfit ?? 0, colorScheme),
                                 accent: AlmaSwiftTheme.sage)
            }
        }
    }

    // ── Revenue & margin trend (native bars; tap a month → detail sheet) ──

    private var trendCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Revenue & margin trend").font(.subheadline.weight(.bold))
            Text(vm.report?.periodLabel ?? vm.preset.label)
                .font(.caption2).foregroundStyle(.secondary)
            if let points = vm.report?.monthlyRevenue, !points.isEmpty {
                FinanceTrendBars(points: points) { p in
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    selectedMonth = p
                }
                .padding(.top, 10)
                legend
            } else {
                VStack(spacing: 4) {
                    Text("◩").font(.title2).foregroundStyle(.secondary)
                    Text("No range data").font(.footnote.weight(.semibold))
                    Text("Adjust the date filter or add orders / invoices")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 26)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .financeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var legend: some View {
        HStack(spacing: 14) {
            legendDot(FinancePalette.coral, "Revenue")
            legendDot(FinancePalette.positive(colorScheme), "Profit")
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

    // ── Cashflow (report) — web card parity ──

    private var cashflowCard: some View {
        let cf = vm.report?.cashflow
        return VStack(alignment: .leading, spacing: 8) {
            Text("Cashflow (report)").font(.subheadline.weight(.bold))
            financeMoneyRow("Inflow", cf?.inflow)
            financeMoneyRow("Outflow", cf?.outflow)
            Divider().overlay(AlmaSwiftTheme.separator(colorScheme))
            HStack {
                Text("Net")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(FinancePalette.accentText(colorScheme))
                Spacer()
                Text(fullTaka(cf?.net))
                    .font(.footnote.monospaced().weight(.bold))
                    .foregroundStyle(FinancePalette.accentText(colorScheme))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .financeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    // ── Payroll snapshot — web card parity ──

    private var payrollSnapshotCard: some View {
        let k = vm.kpis
        return VStack(alignment: .leading, spacing: 8) {
            Text("Payroll snapshot").font(.subheadline.weight(.bold))
            financeMoneyRow("Period salary paid", k?.periodSalaryPaid)
            financeMoneyRow("Period advances", k?.periodAdvances)
            Divider().overlay(AlmaSwiftTheme.separator(colorScheme))
            HStack {
                Text("Ledger expenses").font(.footnote).foregroundStyle(.secondary)
                Spacer()
                Text(fullTaka(k?.totalExpenses))
                    .font(.footnote.monospaced().weight(.bold))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .financeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func financeMoneyRow(_ label: String, _ amount: Int?) -> some View {
        HStack {
            Text(label).font(.footnote).foregroundStyle(.secondary)
            Spacer()
            Text(fullTaka(amount)).font(.footnote.monospaced())
        }
    }

    private func fullTaka(_ amount: Int?) -> String {
        guard let amount else { return "—" }
        return (amount < 0 ? "-৳" : "৳") + abs(amount).formatted()
    }

    // ── Quick links (web header actions — all mutating flows live on the web) ──

    private var quickLinks: some View {
        VStack(spacing: 8) {
            quickLinkRow("Expenses", subtitle: "খরচ যোগ ও তালিকা — ওয়েবে",
                         icon: "banknote", path: "/expenses")
            quickLinkRow("Office Fund", subtitle: "অফিস ফান্ড — ওয়েবে",
                         icon: "building.columns", path: "/finance/office-fund")
            quickLinkRow("Payroll", subtitle: "বেতন ও অ্যাডভান্স — ওয়েবে",
                         icon: "person.2", path: "/payroll")
        }
    }

    private func quickLinkRow(_ title: String, subtitle: String, icon: String,
                              path: String) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            openWeb(path, title)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 34, height: 34)
                    .background(
                        LinearGradient(colors: [FinancePalette.coral, AlmaSwiftTheme.violet],
                                       startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .shadow(color: FinancePalette.coral.opacity(0.35), radius: 5, y: 2)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.primary)
                    Text(subtitle).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            .padding(12)
            .financeGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
        .buttonStyle(.plain)
    }

    // ── Shared bits ──

    private func financeChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? FinancePalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? FinancePalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? FinancePalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(FinancePalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).financeGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .financeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 110)
                .financeGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .financeShimmer()
        }
    }

    private var webEscape: some View {
        Button {
            openWeb("/finance", "Finance")
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

// MARK: - Trend bars (native re-set of the web MonthlyRevenueChart)

@available(iOS 17.0, *)
private struct FinanceTrendBars: View {
    let points: [FinanceMonthlyPoint]
    let onSelect: (FinanceMonthlyPoint) -> Void
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

    private func bar(_ p: FinanceMonthlyPoint) -> some View {
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
                    .fill(LinearGradient(colors: [FinancePalette.goldLt, FinancePalette.coral],
                                         startPoint: .top, endPoint: .bottom))
                    .frame(width: 26, height: h)
                if ph > 0 {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(FinancePalette.positive(colorScheme).opacity(0.9))
                        .frame(width: 10, height: ph)
                        .padding(.bottom, 0)
                }
            }
            .frame(height: 124, alignment: .bottom)
            Text(FinanceFormat.monthShort(p.month))
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .onTapGesture { onSelect(p) }
    }
}

// MARK: - Month detail sheet (tap a trend bar — view-only breakdown)

@available(iOS 17.0, *)
private struct FinanceMonthDetailSheet: View {
    let point: FinanceMonthlyPoint
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss

    private var margin: Int {
        point.revenue > 0 ? Int((Double(point.profit) / Double(point.revenue) * 100).rounded()) : 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text(FinanceFormat.monthLong(point.month)).font(.headline)
                Text("মাসিক আয়-ব্যয়ের বিবরণ").font(.caption).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 10) {
                detailRow("Revenue", point.revenue, .primary)
                detailRow("Expenses", point.expenses, .primary)
                detailRow("Profit", point.profit, FinancePalette.signed(point.profit, colorScheme))
                Divider().overlay(AlmaSwiftTheme.separator(colorScheme))
                HStack {
                    Text("MARGIN").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                    Spacer()
                    Text("\(margin)%")
                        .font(.footnote.monospaced().weight(.bold))
                        .foregroundStyle(FinancePalette.accentText(colorScheme))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .financeGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            Button {
                dismiss()
            } label: {
                Text("ঠিক আছে")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(FinancePalette.coral)
            Spacer(minLength: 0)
        }
        .padding(18)
        .presentationBackground { FinanceAurora() }
    }

    private func detailRow(_ label: String, _ amount: Int, _ tint: Color) -> some View {
        HStack {
            Text(label.uppercased()).font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
            Spacer()
            Text((amount < 0 ? "-৳" : "৳") + abs(amount).formatted())
                .font(.footnote.monospaced().weight(.semibold))
                .foregroundStyle(tint)
        }
    }
}

// MARK: - Formatting helpers

private enum FinanceFormat {
    private static let shortNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    private static let longNames = ["January", "February", "March", "April", "May", "June",
                                    "July", "August", "September", "October", "November", "December"]

    /// "2026-03" → "Mar" (with the year attached when it isn't the current one).
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

// MARK: - Aurora background + glass (Finance-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct FinanceAurora: View {
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
    func financeGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct FinanceShimmer: ViewModifier {
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
    func financeShimmer() -> some View { modifier(FinanceShimmer()) }
}

// MARK: - Bento components (Finance-owned copies of the Dashboard board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func finMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct FinCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        FinCountUpText(value: shown, format: format)
            .animation(finMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if finMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct FinCountUpText: View, Animatable {
    var value: Double
    var format: (Int) -> String
    var animatableData: Double {
        get { value }
        set { value = newValue }
    }
    var body: some View {
        Text(format(Int(value.rounded())))
    }
}

/// Shared tile backdrop: frosted glass + a soft diagonal accent wash.
@available(iOS 17.0, *)
private func finBentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
    ZStack {
        RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous).fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .fill(Color.white.opacity(scheme == .dark ? 0.04 : 0.35))
        LinearGradient(colors: [accent.opacity(scheme == .dark ? 0.14 : 0.10), .clear],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
}

/// Small glass stat tile — count-up value + sub line over a soft accent wash.
/// `target == nil` renders the old "—" placeholder (same fallback the KPI cards had).
@available(iOS 17.0, *)
private struct FinBentoStatTile: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let target: Int?
    let format: (Int) -> String
    let sub: String
    let tint: Color
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.75)
            if let target {
                FinCountUp(target: target, format: format)
                    .font(.system(size: 17, weight: .heavy)).monospacedDigit()
                    .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.55)
            } else {
                Text("—").font(.system(size: 17, weight: .heavy)).foregroundStyle(tint)
            }
            Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background { finBentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
/// deep indigo base + violet/coral washes + a sage hint). Range revenue count-up plus
/// the Net profit / Expenses / Margin split — the web's first KPI row, same numbers,
/// same nil "—" fallbacks, same signed tint on net profit.
@available(iOS 17.0, *)
private struct FinBentoHeroCard: View {
    let revenue: Int?
    let expenses: Int?
    let netProfit: Int?
    let marginPct: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("মোট আয় · REVENUE (RANGE)").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(FinancePalette.goldLt)
            Group {
                if let revenue {
                    FinCountUp(target: revenue, format: { AlmaSwiftTheme.takaShort($0) })
                } else {
                    Text("—")
                }
            }
            .font(.system(size: 40, weight: .heavy)).monospacedDigit()
            .foregroundStyle(.white)
            .lineLimit(1).minimumScaleFactor(0.6)
            .padding(.top, 8)
            Text("এই রেঞ্জের বিক্রি")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Net profit", target: netProfit,
                         format: { AlmaSwiftTheme.takaShort($0) },
                         tint: (netProfit ?? 0) < 0 ? FinancePalette.red500 : FinancePalette.green400,
                         sub: "খরচ বাদে")
                heroDivider
                heroStat(label: "Expenses", target: expenses,
                         format: { AlmaSwiftTheme.takaShort($0) },
                         tint: .white, sub: "এই রেঞ্জে")
                heroDivider
                heroStat(label: "Margin", target: marginPct,
                         format: { "\($0)%" },
                         tint: .white, sub: "মুনাফার হার")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.094, green: 0.082, blue: 0.157))
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.32), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.coral.opacity(0.30), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [AlmaSwiftTheme.sage.opacity(0.14), .clear],
                               center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 220)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(.white.opacity(0.16), lineWidth: 1))
        // Always the board's dark anchor — force dark traits inside the card.
        .environment(\.colorScheme, .dark)
    }

    private var heroDivider: some View {
        Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
            .padding(.vertical, 2).padding(.horizontal, 12)
    }

    private func heroStat(label: String, target: Int?, format: @escaping (Int) -> String,
                          tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            Group {
                if let target {
                    FinCountUp(target: target, format: format)
                } else {
                    Text("—")
                }
            }
            .font(.system(size: 17, weight: .heavy)).monospacedDigit()
            .foregroundStyle(tint)
            .lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Finance — Light") {
    FinanceScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
