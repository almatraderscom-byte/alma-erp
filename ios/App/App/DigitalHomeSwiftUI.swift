//
//  DigitalHomeSwiftUI.swift
//  ALMA ERP — the CDIT Agency Dashboard as a native SwiftUI screen (web /digital parity).
//
//  Mirrors the web /digital page — same endpoint, same colours, same blocks:
//    GET /api/digital/dashboard?business_id=CREATIVE_DIGITAL_IT  → CditDashboardData
//  Web-parity blocks: hero (Total receivable warn + Collected-this-month pos +
//  Recurring revenue gold) · 6 KPI tiles (Unpaid invoices / Partial projects warn /
//  Clients / Active Projects info / Revenue / Net Profit pos) · Project Status donut ·
//  Services Mix donut (web StatusPieChart colours: STATUS_COLORS map + the
//  coral/goldDim/goldLt fallback cycle) · web empty states ("No projects yet" /
//  "No service data"). Mutations (clients/projects/invoices CRUD) stay on the web
//  escape hatch — this screen is read-only.
//  Carried lessons: lenient decoding, shimmer skeletons, no global overlays.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / charts/index.tsx tokens)

private enum DigitalHomePalette {
    static var coral: Color { AlmaSwiftTheme.coral }
    static var goldLt: Color { AlmaSwiftTheme.accentLt }
    static var goldDim: Color { AlmaSwiftTheme.accentDim }
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    static let blue500 = Color(red: 0.231, green: 0.510, blue: 0.965)        // #3B82F6
    static let blue400 = Color(red: 0.376, green: 0.647, blue: 0.980)        // #60A5FA
    static let slate400 = Color(red: 0.580, green: 0.639, blue: 0.722)       // #94A3B8

    /// CDIT business accent — the blue the business switcher wears for
    /// Creative Digital IT. The hero anchor is washed with this instead of coral.
    static let cditBlue = Color(red: 0.42, green: 0.56, blue: 0.88)

    /// Web txt-accent: gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ s: ColorScheme) -> Color { s == .dark ? goldLt : goldDim }
    /// Web txt-pos.
    static func positive(_ s: ColorScheme) -> Color { s == .dark ? green400 : emerald600 }
    /// Web txt-warn.
    static func warning(_ s: ColorScheme) -> Color { s == .dark ? amber500 : amber600 }
    /// Web txt-info.
    static func info(_ s: ColorScheme) -> Color { s == .dark ? blue400 : blue500 }

    /// Web StatusPieChart STATUS_COLORS (charts/index.tsx) — named statuses first…
    private static let statusColors: [String: Color] = [
        "Pending": Color(red: 0.961, green: 0.620, blue: 0.043),   // #f59e0b
        "Confirmed": Color(red: 0.231, green: 0.510, blue: 0.965), // #3b82f6
        "Packed": Color(red: 0.545, green: 0.361, blue: 0.965),    // #8b5cf6
        "Shipped": Color(red: 0.055, green: 0.647, blue: 0.914),   // #0ea5e9
        "Delivered": Color(red: 0.133, green: 0.773, blue: 0.369), // #22c55e
        "Returned": Color(red: 0.937, green: 0.267, blue: 0.267),  // #ef4444
        "Cancelled": Color(red: 0.580, green: 0.639, blue: 0.722), // #94a3b8
    ]
    /// …then the web fallback cycle ['#E07A5F', '#C45A3C', '#F4A28C'][i % 3]
    /// (which is what CDIT project statuses like Lead/Active/Completed hit).
    private static let fallbackCycle: [Color] = [coral, goldDim, goldLt]

    static func slice(_ name: String, index: Int) -> Color {
        statusColors[name] ?? fallbackCycle[index % fallbackCycle.count]
    }
}

// MARK: - Models (web CditDashboardData — snake_case wire, decoded defensively)

private struct DigitalHomeKpis {
    var totalClients = 0
    var activeProjects = 0
    var mrr = 0
    var recurringRevenue = 0
    var totalRevenue = 0
    var netProfit = 0
    var totalReceivable = 0
    var collectedThisMonth = 0
    var unpaidInvoices = 0
    var partiallyPaidProjects = 0
}

/// One donut slice — Object.entries(by_status / by_service) on the web.
private struct DigitalHomeSlice: Identifiable, Equatable {
    let name: String
    let value: Int
    var id: String { name }
}

/// GET /api/digital/dashboard answers the flat CditDashboardData object; tolerate
/// an apiDataSuccess `{ ok, data: {…} }` wrap too, like the CRM decoder does.
/// Sheet-backfilled numbers arrive as strings sometimes — every number is flex-decoded
/// so ONE bad field can't blank the whole board.
private struct DigitalHomeDashboard: Decodable {
    let kpis: DigitalHomeKpis
    let byStatus: [DigitalHomeSlice]
    let byService: [DigitalHomeSlice]

    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
        init(_ s: String) { stringValue = s }
    }

    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: AnyKey.self)
        let c = (try? root.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("data"))) ?? root

        var k = DigitalHomeKpis()
        if let kc = try? c.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("kpis")) {
            k.totalClients = Self.flexInt(kc, "total_clients")
            k.activeProjects = Self.flexInt(kc, "active_projects")
            k.mrr = Self.flexInt(kc, "mrr")
            k.recurringRevenue = Self.flexInt(kc, "recurring_revenue")
            k.totalRevenue = Self.flexInt(kc, "total_revenue")
            k.netProfit = Self.flexInt(kc, "net_profit")
            k.totalReceivable = Self.flexInt(kc, "total_receivable")
            k.collectedThisMonth = Self.flexInt(kc, "collected_this_month")
            k.unpaidInvoices = Self.flexInt(kc, "unpaid_invoices")
            k.partiallyPaidProjects = Self.flexInt(kc, "partially_paid_projects")
        }
        kpis = k
        byStatus = Self.slices(c, "by_status")
        byService = Self.slices(c, "by_service")
    }

    /// Record<string, number> → slices. JSON dictionaries lose their key order in
    /// Swift, so sort by value descending (biggest slice first) then name — a stable
    /// order that reads the same on every refresh.
    private static func slices(_ c: KeyedDecodingContainer<AnyKey>, _ key: String) -> [DigitalHomeSlice] {
        let dict = ((try? c.decodeIfPresent([String: FlexNumber].self, forKey: AnyKey(key))) ?? nil) ?? [:]
        return dict
            .map { DigitalHomeSlice(name: $0.key, value: $0.value.int) }
            .filter { $0.value > 0 }
            .sorted { $0.value != $1.value ? $0.value > $1.value : $0.name < $1.name }
    }

    private static func flexInt(_ c: KeyedDecodingContainer<AnyKey>, _ key: String) -> Int {
        let k = AnyKey(key)
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(Double(s)?.rounded() ?? 0) }
        return 0
    }

    /// A number that might arrive as Int, Double or String on the wire.
    private struct FlexNumber: Decodable {
        let int: Int
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let i = try? c.decode(Int.self) { int = i }
            else if let d = try? c.decode(Double.self) { int = Int(d.rounded()) }
            else if let s = try? c.decode(String.self) { int = Int(Double(s)?.rounded() ?? 0) }
            else { int = 0 }
        }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
private final class DigitalHomeVM {
    var data: DigitalHomeDashboard? = nil
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            // Web bizParams(): every call carries business_id — this page is always
            // the CDIT business, exactly what the web BusinessProvider pins on /digital.
            let resp: DigitalHomeDashboard = try await AlmaAPI.shared.get(
                "/api/digital/dashboard",
                query: ["business_id": "CREATIVE_DIGITAL_IT"])
            data = resp
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
struct DigitalHomeScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = DigitalHomeVM()
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.data == nil {
                    loadingBoard
                } else if let data = vm.data {
                    board(data)
                    quickNav
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(DigitalHomeAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
    }

    // ── The board (web fade blocks 0-2: KPI grids + the two pie cards) ──

    @ViewBuilder private func board(_ data: DigitalHomeDashboard) -> some View {
        let k = data.kpis
        DigitalHomeHeroCard(receivable: k.totalReceivable,
                            collected: k.collectedThisMonth,
                            recurring: k.recurringRevenue == 0 ? k.mrr : k.recurringRevenue)
        kpiGrid(k)
        donutCard(title: "Project Status", slices: data.byStatus,
                  emptyIcon: "square.grid.2x2",
                  emptyTitle: "No projects yet",
                  emptyDesc: "Create a project to see status breakdown")
        donutCard(title: "Services Mix", slices: data.byService,
                  emptyIcon: "square.lefthalf.filled",
                  emptyTitle: "No service data",
                  emptyDesc: "Projects will populate this chart")
    }

    // ── KPI tiles (web KpiCard rows minus the three the hero carries):
    //    Unpaid invoices · Partial projects warn · Clients · Active Projects info ·
    //    Revenue · Net Profit pos — same numbers, same tints, bento presentation. ──

    private func kpiGrid(_ k: DigitalHomeKpis) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                DigitalHomeStatTile(label: "Unpaid invoices", value: k.unpaidInvoices,
                                    format: { "\($0)" }, sub: "বাকি ইনভয়েস",
                                    tint: .primary, accent: DigitalHomePalette.cditBlue)
                DigitalHomeStatTile(label: "Partial projects", value: k.partiallyPaidProjects,
                                    format: { "\($0)" }, sub: "আংশিক পেমেন্ট",
                                    tint: DigitalHomePalette.warning(colorScheme),
                                    accent: DigitalHomePalette.amber500)
            }
            HStack(spacing: 10) {
                DigitalHomeStatTile(label: "Clients", value: k.totalClients,
                                    format: { "\($0)" }, sub: "মোট ক্লায়েন্ট",
                                    tint: .primary, accent: DigitalHomePalette.cditBlue)
                DigitalHomeStatTile(label: "Active Projects", value: k.activeProjects,
                                    format: { "\($0)" }, sub: "চলমান প্রজেক্ট",
                                    tint: DigitalHomePalette.info(colorScheme),
                                    accent: DigitalHomePalette.blue500)
            }
            HStack(spacing: 10) {
                DigitalHomeStatTile(label: "Revenue", value: k.totalRevenue,
                                    format: { AlmaSwiftTheme.takaShort($0) }, sub: "মোট আয়",
                                    tint: .primary, accent: DigitalHomePalette.cditBlue)
                DigitalHomeStatTile(label: "Net Profit", value: k.netProfit,
                                    format: { AlmaSwiftTheme.takaShort($0) }, sub: "নিট লাভ",
                                    tint: k.netProfit < 0 ? DigitalHomePalette.red500
                                                          : DigitalHomePalette.positive(colorScheme),
                                    accent: DigitalHomePalette.green400)
            }
        }
    }

    // ── Donut cards (web Card + StatusPieChart / Empty) ──

    @ViewBuilder private func donutCard(title: String, slices: [DigitalHomeSlice],
                                        emptyIcon: String, emptyTitle: String,
                                        emptyDesc: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title.uppercased())
                .font(.caption2.weight(.heavy)).tracking(0.5)
                .foregroundStyle(.secondary)
            if slices.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: emptyIcon).font(.title2).foregroundStyle(.secondary)
                    Text(emptyTitle).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    Text(emptyDesc).font(.caption2).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 26)
            } else {
                let coloured = slices.enumerated().map { i, s in
                    (s.name, s.value, DigitalHomePalette.slice(s.name, index: i))
                }
                HStack(spacing: 16) {
                    DigitalHomeDonut(slices: coloured, size: 108, lineWidth: 15)
                    donutLegend(coloured)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .digitalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    /// Swatch legend beside the donut (dashboard's two-column legend language).
    private func donutLegend(_ items: [(String, Int, Color)]) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(spacing: 7) {
                    RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                        .fill(item.2).frame(width: 9, height: 9)
                    Text(item.0).font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1).minimumScaleFactor(0.7)
                    Spacer(minLength: 4)
                    Text("\(item.1)").font(.caption2.weight(.bold).monospacedDigit())
                }
            }
        }
        .frame(maxWidth: .infinity)
    }

    // ── Shared bits ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .digitalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(DigitalHomePalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).digitalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    /// Skeleton board — hero + tile rows + two chart cards (web Skeleton parity).
    @ViewBuilder private var loadingBoard: some View {
        Color.clear.frame(height: 150)
            .digitalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
            .digitalShimmer()
        ForEach(0..<3, id: \.self) { _ in
            HStack(spacing: 10) {
                ForEach(0..<2, id: \.self) { _ in
                    Color.clear.frame(height: 74)
                        .digitalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                        .digitalShimmer()
                }
            }
        }
        ForEach(0..<2, id: \.self) { _ in
            Color.clear.frame(height: 150)
                .digitalGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .digitalShimmer()
        }
    }

    // ── Quick nav — CDIT sub-pages as native chips. openWeb routes through
    //    pushSmart, so migrated targets open their NATIVE screens (S7 batch). ──
    private var quickNav: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                quickNavChip("Clients", "person.2", "/digital/clients", "CDIT clients")
                quickNavChip("Projects", "square.stack.3d.up", "/digital/projects", "CDIT projects")
                quickNavChip("Invoices", "doc.text", "/digital/invoices", "CDIT invoices")
                quickNavChip("Finance", "banknote", "/digital/finance", "Finance")
            }
            .padding(.horizontal, 2)
        }
    }

    private func quickNavChip(_ title: String, _ icon: String, _ path: String, _ navTitle: String) -> some View {
        Button {
            openWeb(path, navTitle)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.caption)
                Text(title).font(.footnote.weight(.medium))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .digitalGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var webEscape: some View {
        Button {
            openWeb("/digital", "CDIT")
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

// MARK: - Bento components (page-owned copies of the Dashboard board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups and sweeps freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func digitalHomeMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct DigitalHomeCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        DigitalHomeCountUpText(value: shown, format: format)
            .animation(digitalHomeMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if digitalHomeMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct DigitalHomeCountUpText: View, Animatable {
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
private func digitalHomeBentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
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
@available(iOS 17.0, *)
private struct DigitalHomeStatTile: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let value: Int
    let format: (Int) -> String
    let sub: String
    let tint: Color
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.4)
                .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.75)
            DigitalHomeCountUp(target: value, format: format)
                .font(.system(size: 17, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.55)
            Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
                .lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 13).padding(.vertical, 12)
        .background { digitalHomeBentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe,
/// re-washed with the CDIT business blue). Total-receivable count-up (the page's lead
/// warn metric) plus the Collected-this-month / Recurring-revenue split.
@available(iOS 17.0, *)
private struct DigitalHomeHeroCard: View {
    let receivable: Int
    let collected: Int
    let recurring: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("মোট বকেয়া · CDIT AGENCY").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(DigitalHomePalette.amber500)
            DigitalHomeCountUp(target: receivable, format: { AlmaSwiftTheme.takaShort($0) })
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            Text("ক্লায়েন্টদের কাছে পাওনা টাকা")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Collected (month)", value: collected,
                         format: { AlmaSwiftTheme.takaShort($0) },
                         tint: DigitalHomePalette.green400, sub: "এই মাসে আদায়")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Recurring revenue", value: recurring,
                         format: { AlmaSwiftTheme.takaShort($0) },
                         tint: DigitalHomePalette.goldLt, sub: "মাসিক রিকারিং")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.078, green: 0.094, blue: 0.157))
                LinearGradient(colors: [DigitalHomePalette.cditBlue.opacity(0.38), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [AlmaSwiftTheme.violet.opacity(0.26), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [DigitalHomePalette.goldLt.opacity(0.12), .clear],
                               center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 220)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(.white.opacity(0.16), lineWidth: 1))
        // Always the board's dark anchor — force dark traits inside the card.
        .environment(\.colorScheme, .dark)
    }

    private func heroStat(label: String, value: Int, format: @escaping (Int) -> String,
                          tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            DigitalHomeCountUp(target: value, format: format)
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Donut (web StatusPieChart parity — trimmed circles like the Dashboard/Expenses
// donuts; the ring sweeps in clockwise from 12 o'clock on appear, frozen under Reduce
// Motion / Low Power Mode)

@available(iOS 17.0, *)
private struct DigitalHomeDonut: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let slices: [(String, Int, Color)]
    var size: CGFloat = 150
    var lineWidth: CGFloat = 20
    @State private var sweep: CGFloat = 0
    private var total: Int { max(slices.reduce(0) { $0 + $1.1 }, 1) }

    var body: some View {
        ZStack {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, seg in
                Circle()
                    .trim(from: seg.start * sweep, to: seg.end * sweep)
                    .stroke(seg.color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .butt))
                    .rotationEffect(.degrees(-90))
            }
            VStack(spacing: 0) {
                Text("\(total)")
                    .font(.system(size: size < 120 ? 15 : 18, weight: .bold)).monospacedDigit()
                Text("total").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .padding(lineWidth / 2)
        .frame(width: size + lineWidth, height: size + lineWidth)
        .animation(.spring(duration: 0.6, bounce: 0.1), value: slices.map { $0.1 })
        .onAppear {
            if digitalHomeMotionOK(reduceMotion) {
                withAnimation(.spring(duration: 0.8, bounce: 0)) { sweep = 1 }
            } else {
                var tx = Transaction(); tx.disablesAnimations = true
                withTransaction(tx) { sweep = 1 }
            }
        }
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

// MARK: - Aurora background + glass + shimmer (page-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct DigitalHomeAurora: View {
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
    func digitalGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct DigitalHomeShimmer: ViewModifier {
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
    func digitalShimmer() -> some View { modifier(DigitalHomeShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("CDIT Dashboard — Light") {
    DigitalHomeScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
