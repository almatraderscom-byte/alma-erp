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
    private let openWeb: (_ path: String, _ title: String) -> Void
    private var assistiveNav: AgentAssistiveNav?
    private var dockBuilt = false

    init(capacitor: UIViewController, openWeb: @escaping (_ path: String, _ title: String) -> Void) {
        self.capacitor = capacitor
        self.openWeb = openWeb
        self.host = UIHostingController(rootView: DashboardScreen(openWeb: openWeb))
        super.init(nibName: nil, bundle: nil)
        title = "Dashboard"
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Immediate touch feedback: by default a UIScrollView withholds a control's pressed state
        // ~0.15s to disambiguate scrolling, so a quick tap on a dashboard card read as dead. Turn
        // it off so `dashPress` (a Button) highlights the instant the finger lands. App-wide, but
        // benign — it only makes every button feel snappier; scrolling is unaffected.
        UIScrollView.appearance().delaysContentTouches = false
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

    /// Assistive-touch dock (owner-liked, 2026-07-07): a draggable floating shortcut button
    /// (reuses AgentAssistiveNav) laid full-bleed over the native dashboard — its hitTest passes
    /// touches through except the FAB, so the scroll stays interactive. Built in viewDidAppear
    /// (NOT viewDidLoad) so it latches its rest position against the FINAL bounds + safe-area —
    /// otherwise it snaps to an early, too-high mid-screen spot. Items = the owner's chosen
    /// shortcuts (max 5, persisted) + Edit; the pickable catalog is role-gated via an owner probe
    /// (the same 403 signal the To-Do chip uses).
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !dockBuilt else { return }
        dockBuilt = true
        Task { @MainActor [weak self] in
            let owner = await Self.probeOwner()
            self?.buildDock(owner: owner)
        }
    }

    /// The Capacitor WKWebView re-asserts itself to the front when its content loads or
    /// scrolls; without this it would cover the native dashboard as the owner scrolls down.
    /// Re-pin the native host (then the floating dock) on top on every layout pass.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if host.view.superview === view { view.bringSubviewToFront(host.view) }
        if let nav = assistiveNav, nav.superview === view { view.bringSubviewToFront(nav) }
    }

    /// Owner probe — the To-Do route (SUPER_ADMIN-only) answers 403 for everyone else, so a
    /// clean fetch means the owner. Same signal the dashboard's To-Do chip already trusts.
    private static func probeOwner() async -> Bool {
        do { let _: TodosEnvelope = try await AlmaAPI.shared.get("/api/assistant/todos"); return true }
        catch { return false }
    }

    /// (Re)build the floating shortcut dock from the persisted selection, role-gated.
    private func buildDock(owner: Bool) {
        assistiveNav?.removeFromSuperview()
        let available = DashShortcutCatalog.available(owner: owner)
        let byPath = Dictionary(available.map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
        let chosen = DashShortcutStore.load().compactMap { byPath[$0] }.prefix(5)
        var items: [AgentAssistiveNav.Item] = chosen.map { sc in
            AgentAssistiveNav.Item(title: sc.title, icon: sc.icon) { [weak self] in
                self?.openWeb(sc.path, sc.title)
            }
        }
        items.append(AgentAssistiveNav.Item(title: "এডিট", icon: "slider.horizontal.3") { [weak self] in
            self?.presentShortcutEditor(owner: owner)
        })
        let nav = AgentAssistiveNav(items: items)
        view.addSubview(nav)
        nav.attach(to: view, tabBarHeight: 49)
        assistiveNav = nav
        view.setNeedsLayout()
    }

    /// Present the shortcut editor (choose up to 5 from the role-available catalog).
    private func presentShortcutEditor(owner: Bool) {
        let editor = ShortcutEditorView(
            available: DashShortcutCatalog.available(owner: owner),
            initial: DashShortcutStore.load(),
            onSave: { [weak self] chosen in
                DashShortcutStore.save(chosen)
                self?.dismiss(animated: true)
                self?.buildDock(owner: owner)
            },
            onCancel: { [weak self] in self?.dismiss(animated: true) })
        present(UIHostingController(rootView: editor), animated: true)
    }
}

// MARK: - Assistive-touch shortcut dock (owner-liked — draggable, Edit, max 5, role-based)

/// One dock shortcut → an ERP route opened via `openWeb`. `icon` is an SF Symbol name.
private struct DashShortcut { let path: String; let title: String; let icon: String }

private enum DashShortcutCatalog {
    /// Full catalog (owner / admin). Titles Bangla, icons SF Symbols.
    static let all: [DashShortcut] = [
        DashShortcut(path: "/orders",     title: "অর্ডার",        icon: "shippingbox"),
        DashShortcut(path: "/invoice",    title: "ইনভয়েস",       icon: "doc.text"),
        DashShortcut(path: "/payroll",    title: "পেরোল",         icon: "banknote"),
        DashShortcut(path: "/analytics",  title: "অ্যানালিটিক্স", icon: "chart.bar.xaxis"),
        DashShortcut(path: "/inventory",  title: "ইনভেন্টরি",     icon: "archivebox"),
        DashShortcut(path: "/expenses",   title: "খরচ",           icon: "creditcard"),
        DashShortcut(path: "/finance",    title: "ফাইন্যান্স",    icon: "dollarsign.circle"),
        DashShortcut(path: "/attendance", title: "হাজিরা",        icon: "clock"),
        DashShortcut(path: "/employees",  title: "কর্মী",         icon: "person.2"),
        DashShortcut(path: "/crm",        title: "সিআরএম",        icon: "person.crop.circle"),
        DashShortcut(path: "/briefing",   title: "ব্রিফিং",       icon: "newspaper"),
        DashShortcut(path: "/portal",     title: "আমার ডেস্ক",    icon: "person.text.rectangle"),
    ]
    /// Pages a non-owner (staff) may open. Everything else is owner-only.
    static let staffPaths: Set<String> = ["/orders", "/invoice", "/attendance", "/portal"]
    static func available(owner: Bool) -> [DashShortcut] {
        owner ? all : all.filter { staffPaths.contains($0.path) }
    }
    static let defaultPaths = ["/orders", "/invoice", "/payroll", "/analytics"]
}

private enum DashShortcutStore {
    private static let key = "alma.dashboard.assistive.shortcuts.v1"
    static func load() -> [String] {
        (UserDefaults.standard.array(forKey: key) as? [String]) ?? DashShortcutCatalog.defaultPaths
    }
    static func save(_ paths: [String]) {
        UserDefaults.standard.set(Array(paths.prefix(5)), forKey: key)
    }
}

/// The Edit sheet — pick up to 5 shortcuts from the role-available catalog.
@available(iOS 17.0, *)
private struct ShortcutEditorView: View {
    let available: [DashShortcut]
    let onSave: ([String]) -> Void
    let onCancel: () -> Void
    @State private var chosen: [String]

    init(available: [DashShortcut], initial: [String],
         onSave: @escaping ([String]) -> Void, onCancel: @escaping () -> Void) {
        self.available = available
        self.onSave = onSave
        self.onCancel = onCancel
        let valid = Set(available.map(\.path))
        _chosen = State(initialValue: initial.filter { valid.contains($0) })
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(available, id: \.path) { sc in
                        Button { toggle(sc.path) } label: {
                            HStack(spacing: 12) {
                                Image(systemName: sc.icon).frame(width: 26).foregroundStyle(DashPalette.coral)
                                Text(sc.title).foregroundStyle(.primary)
                                Spacer()
                                if chosen.contains(sc.path) {
                                    Image(systemName: "checkmark").font(.body.weight(.bold))
                                        .foregroundStyle(DashPalette.coral)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!chosen.contains(sc.path) && chosen.count >= 5)
                    }
                } header: {
                    Text("শর্টকাট বেছে নিন")
                } footer: {
                    Text("সর্বোচ্চ ৫টি · এখন \(bnN(chosen.count))টি বেছে নেওয়া হয়েছে")
                }
            }
            .navigationTitle("ডক এডিট")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("বাতিল") { onCancel() } }
                ToolbarItem(placement: .confirmationAction) { Button("সেভ") { onSave(chosen) }.fontWeight(.bold) }
            }
        }
    }

    private func toggle(_ p: String) {
        if let i = chosen.firstIndex(of: p) { chosen.remove(at: i) }
        else if chosen.count < 5 { chosen.append(p) }
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

/// Short Bengali month names (index 0 = January) for the hero x-axis.
private let dashBnMonths = ["জানু", "ফেব", "মার্চ", "এপ্রি", "মে", "জুন",
                            "জুলা", "আগ", "সেপ", "অক্টো", "নভে", "ডিসে"]
/// "2026-06-08" → "৮ জুন" (Bangla day + short Bengali month). Empty on a bad string.
private func bnDayMonth(_ iso: String) -> String {
    let p = iso.split(separator: "-")
    guard p.count >= 3, let m = Int(p[1]), (1...12).contains(m), let d = Int(p[2]) else { return "" }
    return bnD(String(d)) + " " + dashBnMonths[m - 1]
}

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
            // IOSP-0 baseline: launch.didFinishLaunching → dashboard.contentReady
            // is the launch-to-useful-content metric (first occurrence per launch).
            AlmaPerfLog.event("dashboard.contentReady")
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
@MainActor
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
            // view=owner (owner rule 2026-07-12): only the owner's own todos
            // (persist until he finishes) + agent-raised owner_action items
            // (today only, reset at day end). Agent duties never show here.
            let env: TodosEnvelope = try await AlmaAPI.shared.get(
                "/api/assistant/todos", query: ["view": "owner"])
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
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
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
                        // ── Bento Widget Board (owner spec 2026-07-08): premium glassy mixed-size
                        //    tiles on a 2-column rhythm — one DARK hero KPI card (count-up numbers +
                        //    delta badges + slow shimmer), square ring tiles, a wide gradient
                        //    bar-chart card, donut breakdowns, compact sparkline trend rows and
                        //    comparison lists with mini progress bars. Same content as the web page —
                        //    only the composition is elevated. All figures pure Bangla; theme = the
                        //    app aura tokens (coral / violet / sage over the aurora).
                        bentoHero(d.kpis, daily: d.dailyTrend, monthly: d.monthlyTrend)
                        ringTiles(d.kpis)
                        statTiles(d.kpis, byStatus: d.byStatus)
                        sectionLabel("বিশ্লেষণ")
                        monthlyRevenueCard(d.monthlyTrend).id("charts")
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                                  spacing: 12) {
                            orderStatusCompact(d.byStatus)
                            categoryMixCompact(d.byCategory)
                        }
                        trendRowsCard(daily: d.dailyTrend, monthly: d.monthlyTrend).id("charts2")
                        channelCompareCard(d.bySource)
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
        let extra = breaches.count > 3 ? " +\(bnN(breaches.count - 3)) আরও" : ""
        return Button {
            openWeb("/orders?status=sla", "Orders")
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "bolt.fill").foregroundStyle(DashPalette.warning(scheme))
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(bnN(breaches.count))টি অর্ডারে মনোযোগ দরকার")
                        .font(.footnote.weight(.bold)).foregroundStyle(DashPalette.warning(scheme))
                    Text(ids + extra).font(.caption2).foregroundStyle(DashPalette.warning(scheme).opacity(0.85))
                        .lineLimit(1)
                }
                Spacer()
                Text("সব দেখুন →").font(.caption2.weight(.bold)).foregroundStyle(DashPalette.warning(scheme))
            }
            .padding(12)
            .background(DashPalette.amber500.opacity(scheme == .dark ? 0.16 : 0.12),
                        in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(DashPalette.amber500.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(DashPressStyle())
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

    // ── Bento widget board: dark hero + ring tiles + stat tiles ──

    /// The DARK hero KPI widget — revenue count-up + MoM delta badge, net-profit and
    /// total-orders secondary numbers (own tints + badges), avg-order meta, and the
    /// integrated daily area chart with a Bangla date axis.
    @ViewBuilder
    private func bentoHero(_ k: DashKpis, daily: [DashDailyPoint], monthly: [DashMonthlyPoint]) -> some View {
        let avg = k.totalOrders > 0 ? k.totalRevenue / k.totalOrders : 0
        BentoHeroCard(kpis: k, avgOrder: avg, ordersMeta: ordersSub(k),
                      spark: daily.map(\.revenue), dates: daily.map(\.date),
                      revenueTrend: Self.trend(monthly.map(\.revenue)),
                      profitTrend: Self.trend(monthly.map(\.profit)))
            .dashPress()
    }

    /// Two square bento tiles with sweeping progress RINGS — delivery rate + return rate.
    private func ringTiles(_ k: DashKpis) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                  spacing: 12) {
            BentoRingTile(label: "ডেলিভারড", target: k.deliveredCount, format: bnN,
                          suffix: "/\(bnN(k.totalOrders))",
                          sub: "\(bnPct(k.deliveryRate)) ডেলিভারি রেট",
                          percent: k.deliveryRate,
                          tint: DashPalette.violet, accent: DashPalette.violet)
                .dashPress()
            BentoRingTile(label: "রিটার্ন রেট", target: k.returnRate, format: bnPct,
                          suffix: nil,
                          sub: "রিফিউজড \(bnPct(k.returnRateRefused))",
                          percent: k.returnRate,
                          tint: returnTint(k.returnRate), accent: returnTint(k.returnRate))
                .dashPress()
        }
    }

    /// Return-rate severity tint (same thresholds the old spec panel used).
    private func returnTint(_ rate: Int) -> Color {
        rate > 20 ? DashPalette.red500 : rate > 10 ? DashPalette.warning(scheme) : DashPalette.sage
    }

    /// Four small glass stat tiles (2×2) — realized profit / return loss / pending / avg order.
    private func statTiles(_ k: DashKpis, byStatus: [String: Int]) -> some View {
        let avg = k.totalOrders > 0 ? k.totalRevenue / k.totalOrders : 0
        // Pending: prefer the KPI field; fall back to the status breakdown so the tile shows a
        // real number even before the additive `pending_count` server field is deployed.
        let pending = k.pendingCount ?? byStatus.first { $0.key.lowercased() == "pending" }?.value
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                         spacing: 12) {
            BentoStatTile(label: "রিয়েলাইজড মুনাফা", target: k.realizedProfit, format: bnTk,
                          sub: "ডেলিভারড অর্ডার",
                          tint: DashPalette.positive(scheme), accent: DashPalette.positive(scheme))
                .dashPress()
            BentoStatTile(label: "রিটার্ন লস", target: k.totalReturnsLoss, format: bnTk,
                          sub: "\(bnN(k.returnedUnpaidCount)) রিফিউজড",
                          tint: DashPalette.red500, accent: DashPalette.red500)
                .dashPress()
            BentoStatTile(label: "পেন্ডিং", target: pending, format: bnN,
                          sub: "অ্যাকশন বাকি",
                          tint: DashPalette.warning(scheme), accent: DashPalette.amber500)
                .dashPress()
            BentoStatTile(label: "গড় অর্ডার", target: avg, format: bnTk,
                          sub: "প্রতি অর্ডার",
                          tint: DashPalette.accentText(scheme), accent: DashPalette.coral)
                .dashPress()
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

    private func sectionLabel(_ text: String, trailing: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text.uppercased()).font(.system(size: 11, weight: .bold)).tracking(0.9)
                .foregroundStyle(.secondary)
            Spacer()
            if let trailing {
                Text(trailing).font(.caption.weight(.bold)).foregroundStyle(DashPalette.accentText(scheme))
            }
        }
        .padding(.horizontal, 4).padding(.top, 2)
    }

    // Compact sparkline / trend rows (bento) — the daily-sales series + the monthly revenue
    // and profit trend series (the old wide dual-line card), recomposed as sparkline rows.

    private func trendRowsCard(daily: [DashDailyPoint], monthly: [DashMonthlyPoint]) -> some View {
        ListCard(title: "ট্রেন্ড", subtitle: "দৈনিক ও মাসিক") {
            if daily.isEmpty && monthly.isEmpty {
                emptyChart("◈", "নেই", "অর্ডার এলে ট্রেন্ড দেখাবে")
            } else {
                VStack(spacing: 0) {
                    if !daily.isEmpty {
                        trendRow(title: "দৈনিক বিক্রি", sub: vm.preset.label,
                                 values: daily.map(\.revenue), color: DashPalette.coral,
                                 value: bnTk(daily.last?.revenue ?? 0), valueSub: "শেষ দিন",
                                 trend: nil)
                    }
                    if !monthly.isEmpty {
                        if !daily.isEmpty { Divider().opacity(0.3) }
                        trendRow(title: "মাসিক আয়", sub: "শেষ ৬ মাস",
                                 values: monthly.map(\.revenue), color: DashPalette.coral,
                                 value: bnTk(monthly.last?.revenue ?? 0), valueSub: nil,
                                 trend: Self.trend(monthly.map(\.revenue)))
                        Divider().opacity(0.3)
                        trendRow(title: "মাসিক মুনাফা", sub: "শেষ ৬ মাস",
                                 values: monthly.map(\.profit), color: DashPalette.positive(scheme),
                                 value: bnTk(monthly.last?.profit ?? 0), valueSub: nil,
                                 trend: Self.trend(monthly.map(\.profit)))
                    }
                }
            }
        }
    }

    private func trendRow(title: String, sub: String, values: [Int], color: Color,
                          value: String, valueSub: String?, trend: Double?) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption.weight(.semibold))
                Text(sub).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 6)
            DashLineChart(values: values, color: color, height: 30)
                .frame(width: 92)
            VStack(alignment: .trailing, spacing: 2) {
                Text(value).font(.caption.weight(.bold).monospacedDigit())
                if let trend {
                    TrendChip(pct: trend)
                } else if let valueSub {
                    Text(valueSub).font(.system(size: 8.5)).foregroundStyle(.secondary)
                }
            }
            .frame(width: 76, alignment: .trailing)
        }
        .padding(.vertical, 10)
        .dashPress()
    }

    private func orderStatusCompact(_ byStatus: [String: Int]) -> some View {
        let slices = byStatus
            .filter { !["Cancelled", "CANCELLED"].contains($0.key) }
            .sorted { $0.value > $1.value }
        let total = slices.reduce(0) { $0 + $1.value }
        let coloured = slices.enumerated().map { ($1.key, $1.value, DashPalette.chart[$0 % DashPalette.chart.count]) }
        return ChartCard(title: "অর্ডার স্ট্যাটাস", subtitle: nil) {
            if coloured.isEmpty {
                emptyChart("◫", "নেই", "ফিল্টার বদলান")
            } else {
                VStack(spacing: 10) {
                    DashDonut(slices: coloured, size: 104, lineWidth: 15,
                              centerTop: bnN(total), centerBottom: "মোট")
                    donutLegend(coloured)
                }
                .padding(.top, 2)
            }
        }
        .dashPress()
    }

    private func categoryMixCompact(_ byCategory: [String: DashCategoryStat]) -> some View {
        let top = byCategory.sorted { $0.value.orders > $1.value.orders }.prefix(5)
        let coloured = top.enumerated().map { ($1.key, $1.value.orders, DashPalette.chart[$0 % DashPalette.chart.count]) }
        return ChartCard(title: "ক্যাটাগরি", subtitle: nil) {
            if coloured.isEmpty {
                emptyChart("◧", "নেই", "অর্ডার এলে দেখাবে")
            } else {
                VStack(spacing: 10) {
                    DashDonut(slices: coloured, size: 104, lineWidth: 15,
                              centerTop: bnN(coloured.count), centerBottom: "টাইপ")
                    donutLegend(coloured)
                }
                .padding(.top, 2)
            }
        }
        .dashPress()
    }

    /// Channel comparison list — one row per source with a soft gradient mini progress bar
    /// (sweeps in), the order count and the channel's revenue.
    private func channelCompareCard(_ bySource: [String: DashSourceStat]) -> some View {
        let rows = bySource.sorted { $0.value.orders > $1.value.orders }
        let maxV = max(rows.map { $0.value.orders }.max() ?? 1, 1)
        return ListCard(title: "চ্যানেল", subtitle: "অর্ডার তুলনা") {
            if rows.isEmpty {
                emptyChart("◩", "নেই", "ফিল্টার বদলান")
            } else {
                VStack(spacing: 12) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, r in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack(spacing: 6) {
                                Text(r.key).font(.caption.weight(.semibold)).lineLimit(1)
                                Spacer(minLength: 4)
                                Text(bnTk(r.value.revenue)).font(.caption2.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                Text(bnN(r.value.orders)).font(.caption.weight(.bold)).monospacedDigit()
                            }
                            DashMiniBar(fraction: CGFloat(r.value.orders) / CGFloat(maxV),
                                        color: DashPalette.chart[i % DashPalette.chart.count],
                                        delay: Double(i) * 0.05)
                        }
                        .dashPress()
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    /// Two-column swatch legend under a compact donut (status / category breakdowns).
    private func donutLegend(_ items: [(String, Int, Color)]) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)],
                  alignment: .leading, spacing: 5) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2).fill(it.2).frame(width: 7, height: 7)
                    Text(it.0).font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 2)
                    Text(bnN(it.1)).font(.system(size: 9, weight: .bold))
                }
            }
        }
    }

    // ── Monthly Revenue (web MonthlyRevenueChart — native bars + profit overlay) ──

    private func monthlyRevenueCard(_ points: [DashMonthlyPoint]) -> some View {
        ChartCard(title: "মাসিক আয়", subtitle: "শেষ ৬ মাস",
                  legend: [("আয়", DashPalette.coral), ("মুনাফা", DashPalette.positive(scheme))]) {
            if points.isEmpty {
                emptyChart("◈", "নেই", "অর্ডার এলে মাসিক হিসাব দেখাবে")
            } else {
                DashMonthlyBars(points: points).padding(.top, 8)
            }
        }
    }

    // ── Top Products (web list — bento comparison rows with mini revenue bars) ──

    private func topProductsCard(_ products: [DashTopProduct]) -> some View {
        let top = Array(products.prefix(5))
        let maxRev = max(top.map(\.revenue).max() ?? 1, 1)
        return ListCard(title: "টপ প্রোডাক্ট", subtitle: nil) {
            if top.isEmpty {
                emptyChart("◧", "নেই", "অর্ডার এলে টপ প্রোডাক্ট দেখাবে")
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(top.enumerated()), id: \.element.id) { i, p in
                        if i > 0 { Divider().opacity(0.3) }
                        topProductRow(rank: i + 1, p,
                                      fraction: CGFloat(p.revenue) / CGFloat(maxRev),
                                      delay: Double(i) * 0.05)
                            .dashPress()
                    }
                }
            }
        }
    }

    private func topProductRow(rank: Int, _ p: DashTopProduct,
                               fraction: CGFloat, delay: Double) -> some View {
        HStack(spacing: 12) {
            Text(bnN(rank))
                .font(.caption.weight(.bold)).foregroundStyle(DashPalette.accentText(scheme))
                .frame(width: 26, height: 26)
                .background(DashPalette.coral.opacity(scheme == .dark ? 0.18 : 0.12),
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(p.product).font(.caption.weight(.semibold)).lineLimit(1)
                Text("\(bnN(p.orders)) অর্ডার" + (p.pieces > 0 ? " · \(bnN(p.pieces)) পিস" : ""))
                    .font(.caption2).foregroundStyle(.secondary)
                if let firstGroup = p.groupDetails.first {
                    Text(p.groupDetails.prefix(2).map(\.line).joined(separator: " | "))
                        .font(.caption2).foregroundStyle(DashPalette.positive(scheme)).lineLimit(1)
                        .id(firstGroup.group)
                } else if let ts = p.topSize {
                    Text("টপ: \(ts.label) · \(bnN(ts.pieces)) পিস")
                        .font(.caption2).foregroundStyle(DashPalette.positive(scheme)).lineLimit(1)
                }
                // Revenue share vs the #1 product — the bento comparison bar.
                DashMiniBar(fraction: fraction, color: DashPalette.coral, delay: delay, height: 4)
                    .padding(.top, 4)
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
        return ListCard(title: "সাম্প্রতিক অর্ডার", subtitle: nil,
                        action: ("সব দেখুন →", { openWeb("/orders", "Orders") })) {
            if recent.isEmpty {
                emptyChart("◫", "নেই", "এই রেঞ্জে কোনো অর্ডার নেই")
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
                        .buttonStyle(DashPressStyle())
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
                Text("SLA অ্যালার্ট — \(bnN(breaches.count))টি অর্ডার")
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
                .dashPress()
            }
        }
        .padding(14)
        .dashGlass(scheme, corner: AlmaSwiftTheme.rCard)
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
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
        .buttonStyle(DashPressStyle())
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
        .frame(maxWidth: .infinity).padding(20).dashGlass(scheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 96).dashGlass(scheme, corner: AlmaSwiftTheme.rCard).dashShimmer()
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

// MARK: - Bento components (dark hero + ring tiles + stat tiles + count-up + mini bars)

/// Central motion gate for the bento animations — count-ups, ring/bar/donut sweeps and the
/// hero shimmer ALL freeze to their final state when the owner limits motion: Reduce Motion
/// or Low Power Mode (the same guard pattern DashAurora.updateDrift uses).
@available(iOS 17.0, *)
private func dashMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number: animates 0 → target on first appear (and old → new on refresh), in the
/// owner's Bangla formatting. A single Animatable interpolation drives the digits — no
/// timers. Snaps straight to the final value under Reduce Motion / Low Power Mode.
@available(iOS 17.0, *)
private struct DashCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        DashCountUpText(value: shown, format: format)
            .animation(dashMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if dashMotionOK(reduceMotion) {
                    appeared = true          // the implicit spring above interpolates the digits
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

/// Animatable text body for DashCountUp — SwiftUI interpolates `value` frame-to-frame.
@available(iOS 17.0, *)
private struct DashCountUpText: View, Animatable {
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

/// Soft gradient mini progress bar (comparison lists) — sweeps to its fraction on appear,
/// frozen under Reduce Motion / Low Power Mode.
@available(iOS 17.0, *)
private struct DashMiniBar: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let fraction: CGFloat
    let color: Color
    var delay: Double = 0
    var height: CGFloat = 7
    @State private var grow = false

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(scheme == .dark ? 0.10 : 0.06))
                Capsule()
                    .fill(LinearGradient(colors: [color.opacity(0.55), color],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(geo.size.width * min(max(fraction, 0), 1), height) * (grow ? 1 : 0.001))
            }
        }
        .frame(height: height)
        .onAppear {
            if dashMotionOK(reduceMotion) {
                withAnimation(.spring(duration: 0.6, bounce: 0.18).delay(delay)) { grow = true }
            } else {
                var tx = Transaction(); tx.disablesAnimations = true
                withTransaction(tx) { grow = true }
            }
        }
    }
}

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

/// Circular progress ring (delivery / return rates) — sweeps in with a spring on appear,
/// snaps to the final arc under Reduce Motion / Low Power Mode.
@available(iOS 17.0, *)
private struct DashRing: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let percent: Int
    let color: Color
    var size: CGFloat = 50
    var lineWidth: CGFloat = 5
    @State private var animate = false
    var body: some View {
        ZStack {
            Circle().stroke(Color.primary.opacity(scheme == .dark ? 0.14 : 0.08), lineWidth: lineWidth)
            Circle().trim(from: 0, to: animate ? CGFloat(min(max(percent, 0), 100)) / 100 : 0)
                .stroke(LinearGradient(colors: [color.opacity(0.55), color],
                                       startPoint: .top, endPoint: .bottom),
                        style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(bnPct(percent)).font(.system(size: max(size * 0.24, 11), weight: .heavy)).monospacedDigit()
        }
        .frame(width: size, height: size)
        .onAppear {
            if dashMotionOK(reduceMotion) {
                withAnimation(.spring(duration: 0.8, bounce: 0.12)) { animate = true }
            } else {
                var tx = Transaction(); tx.disablesAnimations = true
                withTransaction(tx) { animate = true }
            }
        }
    }
}

/// Square bento tile with a sweeping progress RING — count-up headline + severity tint,
/// frosted glass with a soft accent wash.
@available(iOS 17.0, *)
private struct BentoRingTile: View {
    @Environment(\.colorScheme) private var scheme
    let label: String
    let target: Int
    let format: (Int) -> String
    let suffix: String?
    let sub: String
    let percent: Int
    let tint: Color
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(label.uppercased()).font(.system(size: 9.5, weight: .bold)).tracking(0.5)
                .foregroundStyle(.secondary).lineLimit(1).minimumScaleFactor(0.75)
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 1) {
                        DashCountUp(target: target, format: format)
                            .font(.system(size: 22, weight: .heavy)).monospacedDigit()
                            .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.55)
                        if let suffix {
                            Text(suffix).font(.caption2).foregroundStyle(.secondary)
                                .lineLimit(1).minimumScaleFactor(0.7)
                        }
                    }
                    Text(sub).font(.system(size: 9)).foregroundStyle(.secondary)
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
                Spacer(minLength: 4)
                DashRing(percent: percent, color: accent, size: 56, lineWidth: 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background { bentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// Small glass stat tile — count-up value + sub line, soft accent wash. `target == nil`
/// renders the "—" placeholder (pending before the server field ships).
@available(iOS 17.0, *)
private struct BentoStatTile: View {
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
                DashCountUp(target: target, format: format)
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
        .background { bentoWash(accent, scheme: scheme) }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

/// Shared bento tile backdrop: frosted glass + a soft diagonal accent wash.
@available(iOS 17.0, *)
private func bentoWash(_ accent: Color, scheme: ColorScheme) -> some View {
    ZStack {
        RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous).fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .fill(Color.white.opacity(scheme == .dark ? 0.04 : 0.35))
        LinearGradient(colors: [accent.opacity(scheme == .dark ? 0.14 : 0.10), .clear],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
}

// MARK: - Bento hero (the one DARK anchoring widget of the board)

/// The dark hero KPI card — deliberately dark in BOTH schemes (the board's anchor tile):
/// revenue count-up + real MoM delta badge, net-profit and total-orders secondary numbers
/// (own tints + badges), avg-order meta, and the integrated daily area chart with a Bangla
/// date axis. A slow diagonal light sheen shimmers across the glass — frozen under Reduce
/// Motion / Low Power Mode (same guard as DashAurora).
@available(iOS 17.0, *)
private struct BentoHeroCard: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let kpis: DashKpis
    let avgOrder: Int
    let ordersMeta: String
    let spark: [Int]
    let dates: [String]
    let revenueTrend: Double?
    let profitTrend: Double?
    @State private var shimmer = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("মোট আয় · REVENUE").font(.system(size: 10, weight: .bold)).tracking(0.8)
                    .foregroundStyle(DashPalette.goldLt)
                Spacer()
                if let revenueTrend { TrendChip(pct: revenueTrend) }
            }
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text("৳").font(.title.weight(.bold)).foregroundStyle(.white.opacity(0.55))
                DashCountUp(target: kpis.totalRevenue,
                            format: { bnD(dashGrouped(abs($0))).prependingMinus($0 < 0) })
                    .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                    .foregroundStyle(.white)
                    .lineLimit(1).minimumScaleFactor(0.6)
            }
            .padding(.top, 8)
            Text("গড় অর্ডার \(bnTk(avgOrder)) · \(ordersMeta)")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "নিট মুনাফা", target: kpis.netProfit, format: bnTk,
                         tint: kpis.netProfit < 0 ? DashPalette.red500 : DashPalette.green400,
                         badge: profitTrend, sub: "রিটার্ন লস বাদে")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "মোট অর্ডার", target: kpis.totalOrders, format: bnN,
                         tint: .white, badge: nil, sub: "এই রেঞ্জে")
                Spacer(minLength: 0)
            }
            .padding(.top, 14)

            if !spark.isEmpty {
                DashLineChart(values: spark, color: DashPalette.coral, height: 96).padding(.top, 12)
                if let axis = axisLabels {
                    HStack(spacing: 0) {
                        ForEach(Array(axis.enumerated()), id: \.offset) { i, t in
                            Text(t).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
                            if i < axis.count - 1 { Spacer(minLength: 0) }
                        }
                    }
                    .padding(.top, 4)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background {
            ZStack {
                // Deep indigo base + brand washes: violet from the top, coral from the
                // bottom, a sage hint top-right — ALMA palette, never the ref's blue/teal.
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(Color(red: 0.094, green: 0.082, blue: 0.157))
                LinearGradient(colors: [DashPalette.violet.opacity(0.32), .clear],
                               startPoint: .topLeading, endPoint: .center)
                LinearGradient(colors: [DashPalette.coral.opacity(0.30), .clear],
                               startPoint: .bottomTrailing, endPoint: .center)
                RadialGradient(colors: [DashPalette.sage.opacity(0.14), .clear],
                               center: .init(x: 0.85, y: 0.05), startRadius: 0, endRadius: 220)
                // Slow diagonal light sweep — the premium glass sheen (gated in updateShimmer).
                LinearGradient(colors: [.clear, .white.opacity(0.09), .clear],
                               startPoint: .leading, endPoint: .trailing)
                    .frame(width: 140)
                    .blur(radius: 6)
                    .rotationEffect(.degrees(16))
                    .scaleEffect(1.6)
                    .offset(x: shimmer ? 340 : -340)
            }
            .clipShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        }
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(.white.opacity(0.16), lineWidth: 1))
        // Force dark inside the card so .primary/materials/TrendChip read the dark palette
        // regardless of the system scheme — this tile is always the board's dark anchor.
        .environment(\.colorScheme, .dark)
        .onAppear { updateShimmer() }
        .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
            .receive(on: DispatchQueue.main)) { _ in updateShimmer() }
    }

    private func heroStat(label: String, target: Int, format: @escaping (Int) -> String,
                          tint: Color, badge: Double?, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Text(label).font(.system(size: 9, weight: .bold)).tracking(0.4)
                    .foregroundStyle(.white.opacity(0.55))
                if let badge { TrendChip(pct: badge) }
            }
            DashCountUp(target: target, format: format)
                .font(.system(size: 19, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint).lineLimit(1).minimumScaleFactor(0.6)
            Text(sub).font(.system(size: 8.5)).foregroundStyle(.white.opacity(0.5))
        }
    }

    /// Battery guard (DashAurora pattern): the sheen sweeps only when the owner allows
    /// motion — Reduce Motion and Low Power Mode both freeze it off-card.
    private func updateShimmer() {
        if reduceMotion || ProcessInfo.processInfo.isLowPowerModeEnabled {
            var tx = Transaction(); tx.disablesAnimations = true
            withTransaction(tx) { shimmer = false }
        } else if !shimmer {
            withAnimation(.easeInOut(duration: 7.5).repeatForever(autoreverses: true)) { shimmer = true }
        }
    }

    /// 4 evenly-spaced Bangla date ticks (last = "আজ"); nil when there are too few dates.
    private var axisLabels: [String]? {
        let valid = dates.filter { !$0.isEmpty }
        guard valid.count >= 4 else { return nil }
        let n = valid.count - 1
        var out = [0, n / 3, (2 * n) / 3, n].map { bnDayMonth(valid[$0]) }
        if out.contains(where: { $0.isEmpty }) { return nil }
        out[out.count - 1] = "আজ"
        return out
    }
}

// MARK: - Press feedback (Apple-style tactile touch on the dashboard's tappable surfaces)

/// Subtle scale-down + soft haptic on touch, spring-back on release. A Button/ButtonStyle (not a
/// raw 0-distance drag gesture) so it never fights the ScrollView's pan.
@available(iOS 17.0, *)
private struct DashPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(.spring(response: 0.35, dampingFraction: 0.55), value: configuration.isPressed)
            .onChange(of: configuration.isPressed) { _, pressed in
                if pressed { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
            }
    }
}

@available(iOS 17.0, *)
private extension View {
    /// Press like an iOS cell — pronounced scale-down + dim + haptic (DashPressStyle), with an
    /// optional tap action. A Button (never fights the ScrollView's pan, unlike a raw drag
    /// gesture); `delaysContentTouches` is turned off app-wide in DashboardHostController so the
    /// press shows IMMEDIATELY on touch-down instead of the usual ~0.15s scroll-disambiguation lag.
    func dashPress(_ action: @escaping () -> Void = {}) -> some View {
        Button(action: action, label: { self }).buttonStyle(DashPressStyle())
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
        .padding(14).dashGlass(scheme, corner: AlmaSwiftTheme.rCard)
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
        .padding(14).dashGlass(scheme, corner: AlmaSwiftTheme.rCard)
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

/// Monthly revenue bars + profit overlay (web MonthlyRevenueChart) — soft gradient bars
/// that sweep up from the baseline with a staggered spring on appear (frozen under Reduce
/// Motion / Low Power Mode).
@available(iOS 17.0, *)
private struct DashMonthlyBars: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let points: [DashMonthlyPoint]
    @State private var grow = false
    private var maxRevenue: Int { max(points.map(\.revenue).max() ?? 1, 1) }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .bottom, spacing: 12) {
                ForEach(Array(points.enumerated()), id: \.element.id) { i, p in bar(p, index: i) }
            }
            .padding(.horizontal, 2)
        }
        .animation(.spring(duration: 0.5, bounce: 0.2), value: points)
        .onAppear {
            if dashMotionOK(reduceMotion) {
                grow = true            // each bar animates via its own staggered spring below
            } else {
                var tx = Transaction(); tx.disablesAnimations = true
                withTransaction(tx) { grow = true }
            }
        }
    }

    private func bar(_ p: DashMonthlyPoint, index: Int) -> some View {
        let h = max(CGFloat(p.revenue) / CGFloat(maxRevenue) * 120, 3)
        let ph = p.revenue > 0
            ? max(CGFloat(max(p.profit, 0)) / CGFloat(maxRevenue) * 120, p.profit > 0 ? 3 : 0) : 0
        return VStack(spacing: 4) {
            Text(bnTk(p.revenue))
                .font(.system(size: 8, weight: .semibold).monospacedDigit())
                .foregroundStyle(.secondary).fixedSize()
                .opacity(grow ? 1 : 0)
            ZStack(alignment: .bottom) {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(LinearGradient(colors: [DashPalette.goldLt.opacity(0.85), DashPalette.coral],
                                         startPoint: .top, endPoint: .bottom))
                    .frame(width: 26, height: h)
                if ph > 0 {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(DashPalette.positive(.light).opacity(0.9))
                        .frame(width: 10, height: ph)
                }
            }
            .scaleEffect(x: 1, y: grow ? 1 : 0.02, anchor: .bottom)
            .frame(height: 124, alignment: .bottom)
            Text(DashFormat.monthShort(p.month))
                .font(.system(size: 9, weight: .semibold)).foregroundStyle(.secondary)
        }
        .animation(.spring(duration: 0.55, bounce: 0.2).delay(Double(index) * 0.05), value: grow)
    }
}

/// Donut (web DonutChart / StatusPieChart) — segments from (label, value, colour). The
/// ring sweeps in clockwise from 12 o'clock on appear (frozen under Reduce Motion / Low
/// Power Mode).
@available(iOS 17.0, *)
private struct DashDonut: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let slices: [(String, Int, Color)]
    var size: CGFloat = 150
    var lineWidth: CGFloat = 20
    /// Centre label override — defaults to the total (web parity); the bento cards pass
    /// e.g. "২৮"/"মোট" (status) or "৫"/"টাইপ" (category).
    var centerTop: String? = nil
    var centerBottom: String = "total"
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
                Text(centerTop ?? bnN(total))
                    .font(.system(size: size < 120 ? 15 : 18, weight: .bold)).monospacedDigit()
                Text(centerBottom).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(width: size, height: size)
        .frame(maxWidth: .infinity)
        .animation(.spring(duration: 0.6, bounce: 0.1), value: slices.map { $0.1 })
        .onAppear {
            if dashMotionOK(reduceMotion) {
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
