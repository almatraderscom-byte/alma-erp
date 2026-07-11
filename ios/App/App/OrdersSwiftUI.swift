//
//  OrdersSwiftUI.swift
//  ALMA ERP — S6: the Orders tab as a fully native SwiftUI screen.
//
//  Talks to the SAME Next.js endpoints the web Orders page uses (via AlmaAPI's
//  cookie bridge — no new server routes):
//    GET  /api/orders/orders?business_id=…&status=…&search=…   → list + summary
//    POST /api/orders/orders/status  {id, status, reason?}     → status change
//  v2 (owner request 2026-07-09): FULL web-drawer parity in the detail sheet —
//  profit/margin stats, courier timeline + tracking copy, invoice generate/open/
//  copy/share, edit order, delete request (Super Admin approval), returns with
//  loss preview, role-gated exactly like src/lib/order-access.ts. The web
//  escape hatch stays as a fallback.
//

import SwiftUI

// MARK: - Model (snake_case API fields → explicit CodingKeys)

struct AlmaOrder: Decodable, Identifiable, Equatable {
    let id: String
    let date: String?
    let customer: String?
    let phone: String?
    let address: String?
    var status: String
    let product: String?
    let category: String?
    let size: String?
    let qty: Int?
    let unitPrice: Int?
    let sellPrice: Int?
    let shippingFee: Int?
    let discount: Int?
    let payment: String?
    let source: String?
    let courier: String?
    let trackingId: String?
    let notes: String?
    let profit: Int?
    // Detail-drawer parity fields (all optional — legacy rows may omit any of them).
    let businessId: String?
    let handledBy: String?
    let slaStatus: String?
    let invoiceNum: String?
    let courierCharge: Int?
    let netProfit: Int?
    let returnNetProfit: Int?
    let estimatedProfit: Int?
    let stockRestored: Bool?
    let stockRestoredAt: String?

    enum CodingKeys: String, CodingKey {
        case id, date, customer, phone, address, status, product, category, size, qty
        case unitPrice = "unit_price"
        case sellPrice = "sell_price"
        case shippingFee = "shipping_fee"
        case discount, payment, source, courier
        case trackingId = "tracking_id"
        case notes, profit
        case businessId = "business_id"
        case handledBy = "handled_by"
        case slaStatus = "sla_status"
        case invoiceNum = "invoice_num"
        case courierCharge = "courier_charge"
        case netProfit = "net_profit"
        case returnNetProfit = "return_net_profit"
        case estimatedProfit
        case stockRestored, stockRestoredAt
    }

    /// Some legacy rows carry ints in string fields and vice-versa — decode defensively
    /// so ONE bad row can't kill the whole list.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        date = try? c.decodeIfPresent(String.self, forKey: .date)
        customer = try? c.decodeIfPresent(String.self, forKey: .customer)
        phone = try? c.decodeIfPresent(String.self, forKey: .phone)
        address = try? c.decodeIfPresent(String.self, forKey: .address)
        status = (try? c.decode(String.self, forKey: .status)) ?? "Pending"
        product = try? c.decodeIfPresent(String.self, forKey: .product)
        category = try? c.decodeIfPresent(String.self, forKey: .category)
        size = try? c.decodeIfPresent(String.self, forKey: .size)
        qty = Self.flexInt(c, .qty)
        unitPrice = Self.flexInt(c, .unitPrice)
        sellPrice = Self.flexInt(c, .sellPrice)
        shippingFee = Self.flexInt(c, .shippingFee)
        discount = Self.flexInt(c, .discount)
        payment = try? c.decodeIfPresent(String.self, forKey: .payment)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        courier = try? c.decodeIfPresent(String.self, forKey: .courier)
        trackingId = try? c.decodeIfPresent(String.self, forKey: .trackingId)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        profit = Self.flexInt(c, .profit)
        businessId = try? c.decodeIfPresent(String.self, forKey: .businessId)
        handledBy = try? c.decodeIfPresent(String.self, forKey: .handledBy)
        slaStatus = try? c.decodeIfPresent(String.self, forKey: .slaStatus)
        invoiceNum = try? c.decodeIfPresent(String.self, forKey: .invoiceNum)
        courierCharge = Self.flexInt(c, .courierCharge)
        netProfit = Self.flexInt(c, .netProfit)
        returnNetProfit = Self.flexInt(c, .returnNetProfit)
        estimatedProfit = Self.flexInt(c, .estimatedProfit)
        stockRestored = Self.flexBool(c, .stockRestored)
        stockRestoredAt = try? c.decodeIfPresent(String.self, forKey: .stockRestoredAt)
    }

    private static func flexInt(_ c: KeyedDecodingContainer<CodingKeys>, _ k: CodingKeys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }

    private static func flexBool(_ c: KeyedDecodingContainer<CodingKeys>, _ k: CodingKeys) -> Bool? {
        if let b = try? c.decodeIfPresent(Bool.self, forKey: k) { return b }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return s == "true" || s == "TRUE" || s == "1" }
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i != 0 }
        return nil
    }
}

struct OrdersListResponse: Decodable {
    let orders: [AlmaOrder]
    let summary: Summary?
    struct Summary: Decodable {
        let total: Int?
        let totalRevenue: Int?
        let totalProfit: Int?
        let byStatus: [String: Int]?
        enum CodingKeys: String, CodingKey {
            case total
            case totalRevenue = "total_revenue"
            case totalProfit = "total_profit"
            case byStatus = "by_status"
        }
    }
}

/// The web page's date chips, replicated exactly (server-side startDate/endDate,
/// dates in Asia/Dhaka — the business day the whole ERP runs on).
enum OrdersDateFilter: Equatable {
    case last30, today, yesterday, last7, thisMonth, lastMonth
    case custom(start: Date, end: Date)

    static let presets: [OrdersDateFilter] = [.today, .yesterday, .last7, .last30, .thisMonth, .lastMonth]

    var label: String {
        switch self {
        case .today: return "Today"
        case .yesterday: return "Yesterday"
        case .last7: return "Last 7 days"
        case .last30: return "Last 30 days"
        case .thisMonth: return "This month"
        case .lastMonth: return "Last month"
        case .custom: return "কাস্টম"
        }
    }

    /// (startDate, endDate) as YYYY-MM-DD in Asia/Dhaka.
    var range: (String, String) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd"
        fmt.timeZone = cal.timeZone
        let now = Date()
        let today = cal.startOfDay(for: now)
        func d(_ x: Date) -> String { fmt.string(from: x) }
        switch self {
        case .today: return (d(today), d(today))
        case .yesterday:
            let y = cal.date(byAdding: .day, value: -1, to: today)!
            return (d(y), d(y))
        case .last7: return (d(cal.date(byAdding: .day, value: -6, to: today)!), d(today))
        case .last30: return (d(cal.date(byAdding: .day, value: -29, to: today)!), d(today))
        case .thisMonth:
            let first = cal.date(from: cal.dateComponents([.year, .month], from: today))!
            return (d(first), d(today))
        case .lastMonth:
            let firstThis = cal.date(from: cal.dateComponents([.year, .month], from: today))!
            let firstLast = cal.date(byAdding: .month, value: -1, to: firstThis)!
            let endLast = cal.date(byAdding: .day, value: -1, to: firstThis)!
            return (d(firstLast), d(endLast))
        case .custom(let s, let e): return (d(min(s, e)), d(max(s, e)))
        }
    }
}

struct StatusChangeResponse: Decodable {
    let ok: Bool?
    let newStatus: String?
    enum CodingKeys: String, CodingKey {
        case ok
        case newStatus = "new_status"
    }
}

// MARK: - Status presentation (exact wire values from the API spec)

enum OrderStatusMeta {
    /// Order of the filter chips — the web page's chip row order.
    static let filterable = ["Pending", "Confirmed", "Packed", "Shipped", "Delivered",
                             "RETURNED_PAID", "RETURNED_UNPAID", "CANCELLED"]
    /// Forward transitions offered as the primary action (terminal states offer none).
    static func nextSteps(from status: String) -> [String] {
        switch status {
        case "Pending":   return ["Confirmed", "Packed"]
        case "Confirmed": return ["Packed", "Shipped"]
        case "Packed":    return ["Shipped", "Delivered"]
        case "Shipped":   return ["Delivered", "RETURNED_UNPAID"]
        default:           return []
        }
    }
    static func isTerminal(_ s: String) -> Bool {
        ["Delivered", "CANCELLED", "RETURNED", "RETURNED_PAID", "RETURNED_UNPAID",
         "Cancelled", "Returned"].contains(s)
    }
    static func label(_ s: String) -> String {
        switch s {
        case "RETURNED_PAID": return "Returned (paid)"
        case "RETURNED_UNPAID": return "Returned (unpaid)"
        case "RETURNED": return "Returned"
        case "CANCELLED", "Cancelled": return "Cancelled"
        default: return s
        }
    }
    /// EXACT web pill dot colours (globals.css tone-*) — owner rule: the native screen
    /// wears the SAME theme, not SwiftUI stock colours.
    static func tint(_ s: String) -> Color {
        switch s {
        case "Pending":   return Color(red: 0.961, green: 0.620, blue: 0.043) // amber  #F59E0B
        case "Confirmed": return Color(red: 0.659, green: 0.333, blue: 0.969) // purple #A855F7
        case "Packed":    return Color(red: 0.024, green: 0.714, blue: 0.831) // cyan   #06B6D4
        case "Shipped":   return Color(red: 0.231, green: 0.510, blue: 0.965) // blue   #3B82F6
        case "Delivered": return Color(red: 0.133, green: 0.773, blue: 0.369) // green  #22C55E
        case "CANCELLED", "Cancelled":
            return Color(red: 0.580, green: 0.639, blue: 0.722)               // slate  #94A3B8
        case "RETURNED_PAID":
            return Color(red: 0.961, green: 0.620, blue: 0.043)               // amber (web: paid=amber)
        default:          return Color(red: 0.937, green: 0.267, blue: 0.267) // red    #EF4444
        }
    }

    /// Payment tag colours (web: bKash pink, Nagad orange, COD amber).
    static func paymentTint(_ p: String) -> Color {
        switch p {
        case "bKash": return Color(red: 0.925, green: 0.286, blue: 0.600)     // #EC4899
        case "Nagad": return Color(red: 0.976, green: 0.451, blue: 0.086)     // #F97316
        case "COD":   return Color(red: 0.961, green: 0.620, blue: 0.043)     // #F59E0B
        default:       return Color(red: 0.231, green: 0.510, blue: 0.965)    // bank/card blue
        }
    }

    /// Courier progress timeline — port of the web's COURIER_STEPS (utils.ts).
    /// (label, done, active) per step for the given status.
    static func courierSteps(_ status: String) -> [(String, Bool, Bool)] {
        switch status {
        case "Pending":   return [("Placed", true, false), ("Confirmed", false, true), ("Packed", false, false), ("Shipped", false, false), ("Delivered", false, false)]
        case "Confirmed": return [("Placed", true, false), ("Confirmed", true, false), ("Packed", false, true), ("Shipped", false, false), ("Delivered", false, false)]
        case "Packed":    return [("Placed", true, false), ("Confirmed", true, false), ("Packed", true, false), ("Shipped", false, true), ("Delivered", false, false)]
        case "Shipped":   return [("Placed", true, false), ("Confirmed", true, false), ("Packed", true, false), ("Shipped", true, true), ("Delivered", false, false)]
        case "Delivered": return [("Placed", true, false), ("Confirmed", true, false), ("Packed", true, false), ("Shipped", true, false), ("Delivered", true, false)]
        case "Returned", "RETURNED": return [("Placed", true, false), ("Shipped", true, false), ("Returned", true, false)]
        case "RETURNED_PAID":   return [("Placed", true, false), ("Shipped", true, false), ("Returned (paid)", true, false)]
        case "RETURNED_UNPAID": return [("Placed", true, false), ("Shipped", true, false), ("Returned (refused)", true, false)]
        case "CANCELLED", "Cancelled": return [("Placed", true, false), ("Cancelled", true, false)]
        default: return [("Placed", true, false), ("Confirmed", false, true), ("Packed", false, false), ("Shipped", false, false), ("Delivered", false, false)]
        }
    }

    /// Destructive-status confirm copy — port of the web's DESTRUCTIVE_STATUS_META.
    static func destructiveMeta(_ s: String) -> (title: String, body: String) {
        switch s {
        case "RETURNED_PAID":
            return ("Mark returned (paid delivery)?",
                    "Customer refused the product but paid delivery. Inventory will be marked for restock.")
        case "RETURNED_UNPAID":
            return ("Mark returned (refused)?",
                    "Customer refused everything. Inventory will be marked for restock.")
        default:
            return ("Cancel order?",
                    "This excludes the order from revenue and prevents commission generation.")
        }
    }
}

// MARK: - Current user identity (role gating — same rules as the web drawer)

/// GET /api/users/me → { user: { id, role } }, cached for the app run. The web drawer
/// gates Edit / Request-delete / Invoice / status buttons by role (src/lib/order-access.ts)
/// — the native sheet applies the SAME rules so both surfaces agree.
@available(iOS 17.0, *)
enum OrdIdentity {
    struct Me: Decodable {
        let id: String?
        let role: String?
    }
    private struct MeResponse: Decodable { let user: Me? }

    private(set) static var cached: Me? = nil
    private static var inflight: Task<Me?, Never>? = nil

    static func load() async -> Me? {
        if let cached { return cached }
        if let inflight { return await inflight.value }
        let t = Task<Me?, Never> {
            let me: MeResponse? = try? await AlmaAPI.shared.get("/api/users/me")
            return me?.user
        }
        inflight = t
        let v = await t.value
        if v != nil { cached = v }
        inflight = nil
        return v
    }

    // ── Role rules (port of src/lib/roles.ts + order-access.ts) ──
    static func mayAdvance(_ role: String?) -> Bool {
        role == "SUPER_ADMIN" || role == "ADMIN"   // ordersAdvanceStatus
    }
    static func mayInvoice(_ role: String?) -> Bool {
        role == "SUPER_ADMIN" || role == "ADMIN"   // ordersGenerateInvoice
    }
    static func mayRequestDelete(_ role: String?) -> Bool {
        guard let role else { return false }
        return role != "VIEWER"
    }
    /// Staff may edit their own order while it is still early in fulfillment.
    static func mayEdit(_ role: String?, userId: String?, order: AlmaOrder) -> Bool {
        guard let role else { return false }
        if OrderStatusMeta.isTerminal(order.status) { return false }
        if role == "SUPER_ADMIN" || role == "ADMIN" { return true }  // ordersEditField
        if role == "VIEWER" { return false }
        guard let userId, let handledBy = order.handledBy else { return false }
        // handled_by convention: "Name (uuid)" — creator match on the trailing id.
        guard let open = handledBy.lastIndex(of: "("),
              let close = handledBy.lastIndex(of: ")"), open < close else { return false }
        let creator = String(handledBy[handledBy.index(after: open)..<close])
        guard creator.caseInsensitiveCompare(userId) == .orderedSame else { return false }
        return ["Pending", "Confirmed", "Packed"].contains(order.status)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class OrdersVM {
    /// The FULL window (all statuses), exactly as the server returns it — already
    /// archive-stripped. Every chip count + KPI is derived from THIS, so the numbers
    /// can never disagree with the cards on screen (the server's summary counts archived
    /// rows the list omits, so we never trust it — owner bug 2026-07-06).
    var allOrders: [AlmaOrder] = []
    var orders: [AlmaOrder] = []       // the visible slice = allOrders filtered by statusFilter
    var byStatus: [String: Int] = [:]  // per-status counts over the whole window (chip counts)
    var windowCount = 0                // all orders in the window (the "All" chip)
    var total = 0                      // KPI ORDERS = what's actually shown for the active filter
    var revenue = 0
    var profit = 0
    var statusFilter: String? = nil
    var dateFilter: OrdersDateFilter = .last30   // the web's default window
    var payment: String? = nil                   // COD | bKash | Nagad
    var source: String? = nil                    // Facebook | WhatsApp | Instagram | Website
    var sort = "newest"                          // newest | oldest | price | profit (web parity)
    var search = ""

    /// Sentinel for the web's "All Returns" chip (no single server value — the family
    /// is fetched unfiltered and narrowed client-side, same as the web page does).
    static let returnsSentinel = "__RETURNS__"
    static let returnStatuses: Set<String> = ["RETURNED", "RETURNED_PAID", "RETURNED_UNPAID"]
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let (start, end) = dateFilter.range
            // ALWAYS fetch the whole window (no server status filter) so the chip counts
            // and the visible list come from ONE source of truth. The status filter is
            // applied client-side in applyFilter() — this makes chip taps instant AND
            // keeps every count exactly equal to the cards you see when you tap it.
            let resp: OrdersListResponse = try await AlmaAPI.shared.get(
                "/api/orders/orders",
                query: ["business_id": "ALMA_LIFESTYLE",
                        "payment": payment,
                        "source": source,
                        "startDate": start,
                        "endDate": end,
                        "search": search.isEmpty ? nil : search,
                        "limit": "500"])
            var list = resp.orders
            switch sort {   // web sort options: newest (server order) / oldest / price / profit
            case "oldest": list.reverse()
            case "price": list.sort { ($0.sellPrice ?? 0) > ($1.sellPrice ?? 0) }
            case "profit": list.sort { ($0.profit ?? 0) > ($1.profit ?? 0) }
            default: break
            }
            allOrders = list
            applyFilter()
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Re-derive the visible list + all counts from `allOrders` for the active status
    /// filter. Pure/local — no network — so tapping a status chip is instant and the
    /// numbers are guaranteed to match the rows shown.
    func applyFilter() {
        // Chip counts: per-status over the whole window (independent of the active chip,
        // exactly like the web header — each chip shows what you'd get if you tapped it).
        var counts: [String: Int] = [:]
        for o in allOrders { counts[o.status, default: 0] += 1 }
        byStatus = counts
        windowCount = allOrders.count

        // Visible slice for the active filter.
        let visible: [AlmaOrder]
        if statusFilter == Self.returnsSentinel {
            visible = allOrders.filter { Self.returnStatuses.contains($0.status) }
        } else if let s = statusFilter {
            visible = allOrders.filter { $0.status == s }
        } else {
            visible = allOrders
        }
        orders = visible
        total = visible.count
        // KPIs reflect exactly what's on screen (self-consistent with ordersSummaryFromSlice:
        // revenue = Delivered sell price, profit = realized profit on Delivered rows).
        revenue = visible.reduce(0) { $0 + ($1.status == "Delivered" ? ($1.sellPrice ?? 0) : 0) }
        profit  = visible.reduce(0) { $0 + ($1.status == "Delivered" ? ($1.profit ?? 0) : 0) }
    }

    /// Optimistic status change with rollback — same behavior the web drawer has.
    func setStatus(_ order: AlmaOrder, to status: String, reason: String? = nil) async -> Bool {
        let old = order.status
        // Optimistic: update the source of truth (allOrders) and re-derive everything.
        if let i = allOrders.firstIndex(where: { $0.id == order.id }) { allOrders[i].status = status }
        applyFilter()
        do {
            var body: [String: String] = ["id": order.id, "status": status]
            if let reason { body["reason"] = reason }
            let _: StatusChangeResponse = try await AlmaAPI.shared.send("POST", "/api/orders/orders/status", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load() // refresh counts + row (server may cascade fields)
            return true
        } catch {
            if let i = allOrders.firstIndex(where: { $0.id == order.id }) { allOrders[i].status = old }
            applyFilter()
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            return false
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct OrdersScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = OrdersVM()
    @State private var selected: AlmaOrder? = nil
    @State private var searchDebounce: Task<Void, Never>? = nil
    @State private var showCustomDates = false
    @State private var customStart = Date()
    @State private var customEnd = Date()
    @State private var showCreate = false

    /// Escape hatches into the proven web screens (full drawer, login).
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10, pinnedViews: []) {
                dateRow
                statsRow
                chipsRow
                HStack(spacing: 8) {
                    searchRow
                    filterMenu
                }
                if vm.authExpired { authExpiredCard }
                if let err = vm.error { errorCard(err) }
                if vm.loading && vm.orders.isEmpty { loadingRows }
                ForEach(vm.orders) { order in
                    OrderCard(order: order, onView: { selected = order })
                        .onTapGesture {
                            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                            selected = order
                        }
                }
                if !vm.loading && vm.orders.isEmpty && vm.error == nil && !vm.authExpired {
                    Text("কোনো অর্ডার নেই")
                        .foregroundStyle(.secondary)
                        .padding(.top, 60)
                }
                Color.clear.frame(height: 8) // breathing room above the tab bar inset
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(OrdersAurora()) // the owner's aurora — cards float on it in glass
        // MANUAL masked-blur path, permanently: our header is a UIKit nav bar (not a
        // SwiftUI .toolbar), so the native scrollEdgeEffectStyle path paints ~nothing
        // here — wiring confirmed with the owner's crank test 2026-07-06.
        .claudeTopFade(useNativeEdgeEffect: false)
        .refreshable { await vm.load() }
        .scrollDismissesKeyboard(.immediately)
        .dismissKeyboardOnTap()   // tap empty space to close the search keyboard
        .task { await vm.load() }
        .sheet(item: $selected) { order in
            OrderDetailSheet(order: order, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showCustomDates) { customDateSheet }
        .sheet(isPresented: $showCreate) {
            OrderCreateSheet(onCreated: { Task { await vm.load() } }, openWeb: openWeb)
        }
        .overlay(alignment: .bottomTrailing) { newOrderFAB }
    }

    // ── Date chips (the web's Today / Yesterday / 7 / 30 / This month + custom) ──

    private var dateRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(OrdersDateFilter.presets.enumerated()), id: \.offset) { _, f in
                    let active = vm.dateFilter == f
                    themeChip(f.label, active: active, tint: AlmaSwiftTheme.coral) {
                        vm.dateFilter = f
                        Task { await vm.load() }
                    }
                }
                // Custom range → native date-picker sheet; active shows the range itself.
                themeChip(customLabel, active: isCustomActive, tint: AlmaSwiftTheme.violet) {
                    showCustomDates = true
                }
            }
            .padding(.horizontal, 2)
        }
        .padding(.top, 4)
    }

    private var isCustomActive: Bool {
        if case .custom = vm.dateFilter { return true }
        return false
    }
    private var customLabel: String {
        if case .custom = vm.dateFilter {
            let (s, e) = vm.dateFilter.range
            return "\(s) → \(e)"
        }
        return "কাস্টম তারিখ"
    }

    private var customDateSheet: some View {
        NavigationStack {
            Form {
                DatePicker("শুরু", selection: $customStart, displayedComponents: .date)
                DatePicker("শেষ", selection: $customEnd, displayedComponents: .date)
            }
            .navigationTitle("কাস্টম তারিখ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("দেখাও") {
                        vm.dateFilter = .custom(start: customStart, end: customEnd)
                        showCustomDates = false
                        Task { await vm.load() }
                    }
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("বাতিল") { showCustomDates = false }
                }
            }
        }
        .presentationDetents([.height(320)])
    }

    // ── Stats (ORDERS / REVENUE / PROFIT — same numbers the web header shows), now as
    //    the bento dark hero anchor (Dashboard board language, owner spec 2026-07-08) ──

    private var statsRow: some View {
        OrdBentoHeroCard(revenue: vm.revenue, profit: vm.profit, orders: vm.total)
    }

    // ── Channel / payment / sort (the web header's dropdowns, as one native menu) ──

    private var filterMenu: some View {
        Menu {
            Picker("Channel", selection: Binding(get: { vm.source ?? "" }, set: { v in
                vm.source = v.isEmpty ? nil : v
                Task { await vm.load() }
            })) {
                Text("All channels").tag("")
                ForEach(["Facebook", "WhatsApp", "Instagram", "Website"], id: \.self) { Text($0).tag($0) }
            }
            Picker("Payment", selection: Binding(get: { vm.payment ?? "" }, set: { v in
                vm.payment = v.isEmpty ? nil : v
                Task { await vm.load() }
            })) {
                Text("All payments").tag("")
                ForEach(["COD", "bKash", "Nagad"], id: \.self) { Text($0).tag($0) }
            }
            Picker("Sort", selection: Binding(get: { vm.sort }, set: { v in
                vm.sort = v
                Task { await vm.load() }
            })) {
                Text("Newest").tag("newest")
                Text("Oldest").tag("oldest")
                Text("Price").tag("price")
                Text("Profit").tag("profit")
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle" +
                  ((vm.source != nil || vm.payment != nil) ? ".fill" : ""))
                .font(.title3)
                .foregroundStyle(AlmaSwiftTheme.violet)
                .frame(width: 42, height: 42)
                .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    /// Theme chip — the web's pill look on the app's own card surface (never material grey).
    private func themeChip(_ label: String, active: Bool, tint: Color,
                           action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? tint : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? tint.opacity(colorScheme == .dark ? 0.28 : 0.16)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? tint.opacity(0.55) : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // Status chips — single edge-to-edge scrollable row, like the web (build 33 look).
    private var chipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(nil, label: "All", count: vm.windowCount)
                chip(OrdersVM.returnsSentinel, label: "All Returns",
                     count: OrdersVM.returnStatuses.reduce(0) { $0 + (vm.byStatus[$1] ?? 0) })
                ForEach(OrderStatusMeta.filterable, id: \.self) { s in
                    chip(s, label: OrderStatusMeta.label(s), count: vm.byStatus[s] ?? 0)
                }
            }
            .padding(.horizontal, 2)
        }
        .padding(.top, 4)
    }

    private func chip(_ status: String?, label: String, count: Int) -> some View {
        let active = vm.statusFilter == status
        let tint = status.map(OrderStatusMeta.tint) ?? AlmaSwiftTheme.coral
        return Button {
            UISelectionFeedbackGenerator().selectionChanged()
            vm.statusFilter = status
            vm.applyFilter()   // instant, local — counts stay perfectly in sync with the rows
        } label: {
            HStack(spacing: 5) {
                if let status { Circle().fill(OrderStatusMeta.tint(status)).frame(width: 7, height: 7) }
                Text(label).font(.footnote.weight(active ? .semibold : .regular))
                    .foregroundStyle(active ? tint : .secondary)
                if count > 0 {
                    Text("\(count)").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(active ? tint.opacity(colorScheme == .dark ? 0.28 : 0.16)
                               : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                        in: Capsule())
            .overlay(Capsule().strokeBorder(
                active ? tint.opacity(0.55) : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private var searchRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search orders, customers…", text: Binding(
                get: { vm.search },
                set: { newValue in
                    vm.search = newValue
                    searchDebounce?.cancel()
                    searchDebounce = Task { // server-side search, debounced
                        try? await Task.sleep(nanoseconds: 450_000_000)
                        if !Task.isCancelled { await vm.load() }
                    }
                }))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var newOrderFAB: some View {
        Button {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            showCreate = true   // NATIVE order form (web form stays reachable inside it)
        } label: {
            Label("নতুন অর্ডার", systemImage: "plus")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(AlmaSwiftTheme.coral, in: Capsule())
                .shadow(color: AlmaSwiftTheme.coral.opacity(0.35), radius: 8, y: 3)
        }
        .padding(.trailing, 16)
        .padding(.bottom, 12)
    }

    private var authExpiredCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন")
                .font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(AlmaSwiftTheme.ios27Red(colorScheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .ordersGlass(colorScheme, corner: 12)
    }

    private var loadingRows: some View {
        ForEach(0..<6, id: \.self) { _ in
            Color.clear
                .frame(height: 92)
                .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .shimmering()
        }
    }
}

// MARK: - Row card

@available(iOS 17.0, *)
private struct OrderCard: View {
    let order: AlmaOrder
    /// Long-press "বিস্তারিত" — opens the detail sheet, same as a tap.
    var onView: (() -> Void)? = nil
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(order.id)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color(red: 0.878, green: 0.478, blue: 0.373))
                if let d = order.date, !d.isEmpty {
                    Text(d).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                statusPill
            }
            HStack(alignment: .firstTextBaseline) {
                Text(order.customer ?? "—").font(.subheadline.weight(.semibold))
                Spacer()
                if let amount = order.sellPrice {
                    Text("৳\(amount.formatted())").font(.subheadline.weight(.bold))
                }
            }
            HStack(spacing: 6) {
                Text(productLine).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer()
                if let p = order.payment, !p.isEmpty {
                    Text(p).font(.caption2.weight(.semibold))
                        .foregroundStyle(OrderStatusMeta.paymentTint(p))
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(OrderStatusMeta.paymentTint(p).opacity(0.13), in: Capsule())
                }
                if let c = order.courier, !c.isEmpty {
                    Text(c).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        // Web parity: orderRowAccentClass (orders/page.tsx) — returned rows carry a
        // coloured left border + faint wash (amber = paid, red = unpaid/returned).
        .overlay {
            if let accent = returnAccent {
                RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
                    .fill(accent.wash)
                    .allowsHitTesting(false)
            }
        }
        .overlay(alignment: .leading) {
            if let accent = returnAccent {
                Capsule()
                    .fill(accent.bar.opacity(0.8))
                    .frame(width: 3)
                    .padding(.vertical, 6)
                    .allowsHitTesting(false)
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        // Web parity: long-press quick actions (mobile context menu on orders/page.tsx) —
        // view / copy order-# / WhatsApp the customer.
        .contextMenu {
            Button {
                onView?()
            } label: {
                Label("বিস্তারিত", systemImage: "doc.text.magnifyingglass")
            }
            Button {
                UIPasteboard.general.string = order.id
            } label: {
                Label("অর্ডার নম্বর কপি", systemImage: "doc.on.doc")
            }
            if let phone = order.phone, let wa = Self.whatsAppURL(for: phone) {
                Button {
                    UIApplication.shared.open(wa)
                } label: {
                    Label("WhatsApp", systemImage: "message.fill")
                }
            }
        }
    }

    /// Same phone normalization as the detail sheet's WhatsApp button:
    /// local 0XXXXXXXXXX → wa.me/880XXXXXXXXXX.
    private static func whatsAppURL(for phone: String) -> URL? {
        let trimmed = phone.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let msisdn = trimmed.hasPrefix("0") ? "880\(trimmed.dropFirst())" : trimmed
        return URL(string: "https://wa.me/\(msisdn)")
    }

    /// Port of the web's orderRowAccentClass: amber for RETURNED_PAID,
    /// red for RETURNED_UNPAID / RETURNED, nothing otherwise.
    private var returnAccent: (bar: Color, wash: Color)? {
        let key = order.status
            .trimmingCharacters(in: .whitespaces)
            .uppercased()
            .replacingOccurrences(of: " ", with: "_")
        let amber = Color(red: 0.961, green: 0.620, blue: 0.043) // #F59E0B (palette tone-amber)
        let red = Color(red: 0.937, green: 0.267, blue: 0.267)   // #EF4444 (palette tone-red)
        if key == "RETURNED_PAID" { return (amber, amber.opacity(0.04)) }
        if key == "RETURNED_UNPAID" || key == "RETURNED" { return (red, red.opacity(0.05)) }
        return nil
    }

    private var productLine: String {
        var bits: [String] = []
        if let p = order.product, !p.isEmpty { bits.append(p) }
        if let s = order.size, !s.isEmpty { bits.append("Size \(s)") }
        if let q = order.qty, q > 1 { bits.append("×\(q)") }
        return bits.isEmpty ? "—" : bits.joined(separator: " · ")
    }

    private var statusPill: some View {
        HStack(spacing: 4) {
            Circle().fill(OrderStatusMeta.tint(order.status)).frame(width: 6, height: 6)
            Text(OrderStatusMeta.label(order.status)).font(.caption2.weight(.semibold))
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(OrderStatusMeta.tint(order.status).opacity(0.14), in: Capsule())
    }
}

// MARK: - Detail sheet

@available(iOS 17.0, *)
private struct OrderDetailSheet: View {
    let order: AlmaOrder
    let vm: OrdersVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var busy = false

    // Role gating (same rules as the web drawer — src/lib/order-access.ts).
    @State private var role: String? = OrdIdentity.cached?.role
    @State private var userId: String? = OrdIdentity.cached?.id

    // Destructive-status confirm (CANCELLED / RETURNED_PAID / RETURNED_UNPAID) + reason.
    @State private var confirmStatus: String? = nil
    @State private var returnReason = ""

    // Edit / delete-request sub-sheets.
    @State private var showEdit = false
    @State private var showDeleteRequest = false

    // Invoice generation state.
    @State private var invBusy = false
    @State private var invoiceReady = false      // link section visible
    @State private var invoiceToast: String? = nil
    @State private var copied = false

    /// Live copy — vm.orders is refreshed after actions; fall back to the passed order.
    private var live: AlmaOrder { vm.orders.first(where: { $0.id == order.id }) ?? order }

    private var isReturnTerminal: Bool {
        ["RETURNED", "RETURNED_PAID", "RETURNED_UNPAID", "Returned"].contains(live.status)
    }
    private var isCancelled: Bool { ["CANCELLED", "Cancelled"].contains(live.status) }
    private var mayAdvance: Bool { OrdIdentity.mayAdvance(role) }
    private var mayEdit: Bool { OrdIdentity.mayEdit(role, userId: userId, order: live) }
    private var mayRequestDelete: Bool { OrdIdentity.mayRequestDelete(role) }
    private var mayInvoice: Bool { OrdIdentity.mayInvoice(role) }
    private var canCancel: Bool { mayAdvance && !OrderStatusMeta.isTerminal(live.status) }
    private var canReturn: Bool {
        mayAdvance && !isReturnTerminal && !isCancelled
            && ["Delivered", "Shipped"].contains(live.status)
    }
    private var invoiceShareURL: String { "/invoice/share/alma-\(live.id)" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                statsRow
                if isReturnTerminal { restockBanner }
                infoGrid
                if let sla = live.slaStatus, !sla.isEmpty { slaBanner(sla) }
                courierSection
                invoiceSection
                if let t = invoiceToast { toastCard(t) }
                actionButtons
                contactButtons
                webEscape
            }
            .padding(18)
        }
        .presentationBackground { OrdersAurora() }   // sheet floats on the aurora too
        .task {
            if role == nil, let me = await OrdIdentity.load() {
                role = me.role; userId = me.id
            }
            invoiceReady = (live.invoiceNum?.isEmpty == false)
        }
        .sheet(isPresented: $showEdit) {
            OrdEditSheet(order: live, vm: vm)
        }
        .sheet(isPresented: $showDeleteRequest) {
            OrdDeleteRequestSheet(order: live)
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(live.id).font(.headline)
                if let d = live.date { Text(d).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            HStack(spacing: 4) {
                Circle().fill(OrderStatusMeta.tint(live.status)).frame(width: 7, height: 7)
                Text(OrderStatusMeta.label(live.status)).font(.caption.weight(.semibold))
            }
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(OrderStatusMeta.tint(live.status).opacity(0.15), in: Capsule())
        }
    }

    // ── Total / Profit / Margin (port of the web drawer's profitDisplay) ──

    private struct OrdProfitDisplay {
        let label: String
        let amount: Int
        let detail: String
        let tone: Color
        let marginLabel: String
        let marginValue: String
    }

    private var profitDisplay: OrdProfitDisplay {
        let sell = live.sellPrice ?? 0
        let shipping = live.shippingFee ?? 0
        let roundTrip = 2 * (live.courierCharge ?? 0)
        let green = Color(red: 0.133, green: 0.773, blue: 0.369)
        let amber = Color(red: 0.961, green: 0.620, blue: 0.043)
        let red = Color(red: 0.937, green: 0.267, blue: 0.267)
        switch live.status {
        case "Delivered":
            let amount = live.netProfit ?? live.profit ?? 0
            let margin = sell > 0 ? Int((Double(amount) / Double(sell) * 100).rounded()) : 0
            return .init(label: "Profit", amount: amount, detail: "Margin \(margin)% (incl. shipping)",
                         tone: green, marginLabel: "Margin", marginValue: "\(margin)%")
        case "RETURNED_PAID":
            let net = live.returnNetProfit ?? (shipping - roundTrip)
            let loss = net < 0 ? abs(net) : 0
            return .init(label: "Return loss", amount: -loss,
                         detail: "Customer paid ৳\(shipping.formatted()), courier round-trip ৳\(roundTrip.formatted())",
                         tone: amber, marginLabel: "Net", marginValue: "৳\(net.formatted())")
        case "RETURNED_UNPAID", "RETURNED", "Returned":
            let net = live.returnNetProfit ?? -roundTrip
            return .init(label: "Return loss", amount: net, detail: "Refused: full courier loss",
                         tone: red, marginLabel: "Net", marginValue: "৳\(net.formatted())")
        case "CANCELLED", "Cancelled":
            return .init(label: "Profit", amount: 0, detail: "No financial impact",
                         tone: .secondary, marginLabel: "Margin", marginValue: "—")
        default:
            let est = live.estimatedProfit ?? live.profit ?? 0
            let margin = sell > 0 ? "\(Int((Double(est) / Double(sell) * 100).rounded()))%" : "—"
            return .init(label: "Est. profit", amount: est, detail: "Estimated",
                         tone: amber, marginLabel: "Margin", marginValue: margin)
        }
    }

    private var statsRow: some View {
        let p = profitDisplay
        return HStack(spacing: 8) {
            statTile("Total", "৳\((live.sellPrice ?? 0).formatted())", .primary)
            statTile(p.label, "৳\(p.amount.formatted())", p.tone, caption: p.detail)
            statTile(p.marginLabel, p.marginValue, p.tone)
        }
    }

    private func statTile(_ label: String, _ value: String, _ tone: Color, caption: String? = nil) -> some View {
        VStack(spacing: 3) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.subheadline.weight(.bold)).foregroundStyle(tone)
                .lineLimit(1).minimumScaleFactor(0.6)
            if let caption {
                Text(caption).font(.system(size: 9)).foregroundStyle(.secondary)
                    .lineLimit(2).multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10).padding(.horizontal, 6)
        .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var restockBanner: some View {
        let restored = live.stockRestored == true
        let when = (live.stockRestoredAt?.prefix(10)).map(String.init) ?? ""
        let text = restored
            ? (when.isEmpty ? "✓ Inventory restored" : "✓ Inventory restored on \(when)")
            : "⚠ Inventory not restored"
        let tone: Color = restored
            ? Color(red: 0.133, green: 0.773, blue: 0.369)
            : Color(red: 0.961, green: 0.620, blue: 0.043)
        return Text(text)
            .font(.caption.weight(.semibold)).foregroundStyle(tone)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(tone.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl).stroke(tone.opacity(0.25), lineWidth: 1))
    }

    private func slaBanner(_ sla: String) -> some View {
        let amber = Color(red: 0.961, green: 0.620, blue: 0.043)
        return HStack(spacing: 10) {
            Image(systemName: "bolt.fill").font(.caption).foregroundStyle(amber)
            Text(sla).font(.caption.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(amber.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl).stroke(amber.opacity(0.25), lineWidth: 1))
    }

    private var infoGrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            row("person", live.customer)
            row("phone", live.phone)
            row("mappin.and.ellipse", live.address)
            row("shippingbox", [live.product, live.size.map { "Size \($0)" },
                                live.qty.map { "×\($0)" }].compactMap { $0 }.joined(separator: " · "))
            if let cat = live.category, !cat.isEmpty { row("tag", cat) }
            if let q = live.qty, let u = live.unitPrice { row("multiply", "\(q) × ৳\(u.formatted())") }
            if let amt = live.sellPrice { row("banknote", "৳\(amt.formatted())  (\(live.payment ?? "—"))") }
            if let src = live.source, !src.isEmpty { row("antenna.radiowaves.left.and.right", src) }
            if let hb = live.handledBy, !hb.isEmpty { row("person.badge.shield.checkmark", hb) }
            // Multi-item orders carry machine JSON in notes (ORDER_ITEMS_JSON…) — that's
            // internal bookkeeping, never show it. Only human-written notes render.
            if let n = live.notes, !n.isEmpty,
               !n.hasPrefix("ORDER_ITEMS_JSON"), !n.hasPrefix("{") {
                row("note.text", n)
            }
        }
        .padding(14)
        .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func row(_ icon: String, _ text: String?) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).frame(width: 18).foregroundStyle(.secondary)
            Text((text?.isEmpty == false ? text! : "—")).font(.subheadline)
        }
    }

    // ── Courier timeline (web drawer's COURIER_STEPS list) ──

    private var courierSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("COURIER — \((live.courier?.isEmpty == false ? live.courier! : "Not assigned").uppercased())")
                .font(.caption2.weight(.bold)).foregroundStyle(.secondary).kerning(0.8)
            if let t = live.trackingId, !t.isEmpty {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Tracking ID").font(.caption2).foregroundStyle(.secondary)
                        Text(t).font(.caption.monospaced().weight(.semibold))
                    }
                    Spacer()
                    Button {
                        UIPasteboard.general.string = t
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    } label: { Image(systemName: "doc.on.doc") }
                        .buttonStyle(.bordered)
                }
                .padding(12)
                .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            }
            let steps = OrderStatusMeta.courierSteps(live.status)
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    let (label, done, active) = step
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: done ? "checkmark.circle.fill" : active ? "circle.inset.filled" : "circle")
                            .font(.footnote)
                            .foregroundStyle(done ? Color(red: 0.133, green: 0.773, blue: 0.369)
                                             : active ? Color(red: 0.231, green: 0.510, blue: 0.965)
                                             : .secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(label).font(.caption.weight(done || active ? .semibold : .regular))
                                .foregroundStyle(done || active ? .primary : .secondary)
                            if active { Text("In progress").font(.system(size: 9)).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
            .padding(14)
            .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    // ── Invoice (generate + open/copy/share — web drawer parity) ──

    @ViewBuilder private var invoiceSection: some View {
        let hasInvoice = live.invoiceNum?.isEmpty == false
        VStack(alignment: .leading, spacing: 8) {
            if hasInvoice {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Invoice").font(.caption2).foregroundStyle(.secondary)
                        Text(live.invoiceNum ?? "").font(.caption.monospaced().weight(.semibold))
                    }
                    Spacer()
                    Text("✓ Generated").font(.caption2.weight(.semibold))
                        .foregroundStyle(Color(red: 0.133, green: 0.773, blue: 0.369))
                }
                .padding(12)
                .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            } else if mayInvoice {
                Button {
                    Task { await generateInvoice() }
                } label: {
                    Label(invBusy ? "Generating…" : "Generate Invoice", systemImage: "doc.badge.plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(invBusy || busy)
            }
            if invoiceReady || hasInvoice {
                HStack(spacing: 8) {
                    Button {
                        UIPasteboard.general.string = AlmaAPI.baseURL.absoluteString + invoiceShareURL
                        copied = true
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    } label: {
                        Label(copied ? "Copied ✓" : "Copy link", systemImage: "link")
                            .font(.footnote).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button {
                        dismiss()
                        openWeb(invoiceShareURL, "Invoice")
                    } label: {
                        Label("Open PDF", systemImage: "doc.text")
                            .font(.footnote).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button {
                        let full = AlmaAPI.baseURL.absoluteString + invoiceShareURL
                        let text = "Invoice PDF (\(live.id)): \(full)"
                        let enc = text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? text
                        if let url = URL(string: "https://wa.me/?text=\(enc)") { UIApplication.shared.open(url) }
                    } label: {
                        Label("Share", systemImage: "square.and.arrow.up")
                            .font(.footnote).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }

    private struct OrdInvoiceResponse: Decodable {
        let ok: Bool?
        let invoiceNumber: String?
        let duplicate: Bool?
        enum CodingKeys: String, CodingKey {
            case ok, duplicate
            case invoiceNumber = "invoice_number"
        }
    }

    private func generateInvoice() async {
        invBusy = true
        defer { invBusy = false }
        do {
            struct Body: Encodable { let id: String; let allow_regenerate: Bool }
            let r: OrdInvoiceResponse = try await AlmaAPI.shared.send(
                "POST", "/api/invoice", body: Body(id: live.id, allow_regenerate: false))
            if r.ok != false {
                invoiceReady = true
                invoiceToast = r.duplicate == true
                    ? "Invoice \(r.invoiceNumber ?? "") already on file — link ready"
                    : "Invoice \(r.invoiceNumber ?? "") saved — link ready"
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                await vm.load()   // picks up invoice_num on the row
            } else {
                invoiceToast = "Invoice was not created"
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            }
        } catch {
            invoiceToast = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }

    private func toastCard(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .ordersGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Actions (status advance / cancel / returns / edit / delete-request) ──

    @ViewBuilder private var actionButtons: some View {
        VStack(spacing: 8) {
            if mayEdit || mayRequestDelete {
                HStack(spacing: 8) {
                    if mayEdit {
                        Button { showEdit = true } label: {
                            Label("Edit order", systemImage: "pencil").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .disabled(busy)
                    }
                    if mayRequestDelete {
                        Button(role: .destructive) { showDeleteRequest = true } label: {
                            Label("Request delete", systemImage: "trash").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .disabled(busy)
                    }
                }
            }
            if mayEdit && role == "STAFF" {
                Text("You can edit your own orders while Pending, Confirmed, or Packed. Wrong totals need Super Admin delete approval.")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if mayAdvance {
                ForEach(OrderStatusMeta.nextSteps(from: live.status), id: \.self) { next in
                    Button {
                        if next == "RETURNED_UNPAID" {
                            returnReason = ""; confirmStatus = next
                        } else {
                            Task { busy = true; _ = await vm.setStatus(live, to: next); busy = false }
                        }
                    } label: {
                        Label(OrderStatusMeta.label(next), systemImage: "arrow.right.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(OrderStatusMeta.tint(next))
                    .disabled(busy)
                }
            }
            if canCancel {
                Button(role: .destructive) { returnReason = ""; confirmStatus = "CANCELLED" } label: {
                    Label("Cancel order", systemImage: "xmark.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(busy)
            }
            if canReturn {
                Button(role: .destructive) { returnReason = ""; confirmStatus = "RETURNED_PAID" } label: {
                    Label("Returned (paid delivery)", systemImage: "arrow.uturn.left.circle")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(busy)
                Button(role: .destructive) { returnReason = ""; confirmStatus = "RETURNED_UNPAID" } label: {
                    Label("Returned (refused)", systemImage: "arrow.uturn.left.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(busy)
            }
        }
        .alert(OrderStatusMeta.destructiveMeta(confirmStatus ?? "CANCELLED").title,
               isPresented: Binding(get: { confirmStatus != nil }, set: { if !$0 { confirmStatus = nil } })) {
            if confirmStatus != "CANCELLED" {
                TextField("কারণ (ঐচ্ছিক)", text: $returnReason)
            }
            Button("নিশ্চিত", role: .destructive) {
                if let target = confirmStatus {
                    let reason = returnReason.trimmingCharacters(in: .whitespacesAndNewlines)
                    Task {
                        busy = true
                        _ = await vm.setStatus(live, to: target, reason: reason.isEmpty ? nil : reason)
                        busy = false
                    }
                }
                confirmStatus = nil
            }
            Button("না", role: .cancel) { confirmStatus = nil }
        } message: {
            Text(confirmMessage)
        }
    }

    /// Confirm body + projected-loss preview (port of the web's returnLossPreview).
    private var confirmMessage: String {
        guard let s = confirmStatus else { return "" }
        var text = OrderStatusMeta.destructiveMeta(s).body
        let shipping = live.shippingFee ?? 0
        let roundTrip = 2 * (live.courierCharge ?? 0)
        if s == "RETURNED_UNPAID" {
            text += "\n\nThis will record a loss of ৳\(roundTrip.formatted()) (round-trip courier)."
        } else if s == "RETURNED_PAID" {
            let net = shipping - roundTrip
            if net >= 0 {
                text += "\n\nShipping collected covers courier round-trip — minimal or no loss."
            } else {
                text += "\n\nThis will record a loss of ৳\(abs(net).formatted()) (customer paid ৳\(shipping.formatted()) shipping; courier round-trip ৳\(roundTrip.formatted()))."
            }
        }
        return text
    }

    private var contactButtons: some View {
        HStack(spacing: 10) {
            if let phone = live.phone, !phone.isEmpty {
                Link(destination: URL(string: "tel://\(phone)")!) {
                    Label("Call", systemImage: "phone.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                // WhatsApp: strip the leading 0, prefix country code (spec note #5) — with
                // the web drawer's prefilled order-update text.
                if phone.hasPrefix("0") {
                    let base = "https://wa.me/880\(phone.dropFirst())"
                    let msg = "Hi \(live.customer ?? ""), your order \(live.id) update: "
                    let enc = msg.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
                    if let wa = URL(string: "\(base)?text=\(enc)") {
                        Link(destination: wa) {
                            Label("WhatsApp", systemImage: "message.fill").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
    }

    private var webEscape: some View {
        Button {
            dismiss()
            openWeb("/orders", "Orders") // full drawer lives on the web list
        } label: {
            Label("ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Edit-order sheet (POST /api/orders/orders/edit — web drawer parity)

@available(iOS 17.0, *)
private struct OrdEditSheet: View {
    let order: AlmaOrder
    let vm: OrdersVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var customer: String
    @State private var phone: String
    @State private var address: String
    @State private var product: String
    @State private var qty: String
    @State private var unitPrice: String
    @State private var payment: String
    @State private var notes: String
    @State private var busy = false
    @State private var error: String? = nil

    init(order: AlmaOrder, vm: OrdersVM) {
        self.order = order
        self.vm = vm
        _customer = State(initialValue: order.customer ?? "")
        _phone = State(initialValue: order.phone ?? "")
        _address = State(initialValue: order.address ?? "")
        _product = State(initialValue: order.product ?? "")
        _qty = State(initialValue: String(order.qty ?? 1))
        _unitPrice = State(initialValue: String(order.unitPrice ?? 0))
        _payment = State(initialValue: order.payment ?? "")
        _notes = State(initialValue: order.notes ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Updates sync to the orders sheet. Sell price and profit recalculate automatically.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Customer") {
                    TextField("Customer", text: $customer)
                    TextField("Phone", text: $phone).keyboardType(.phonePad)
                    TextField("Address", text: $address, axis: .vertical).lineLimit(2...4)
                }
                Section("Order") {
                    TextField("Product", text: $product)
                    TextField("Qty", text: $qty).keyboardType(.numberPad)
                    TextField("Unit price", text: $unitPrice).keyboardType(.numberPad)
                    TextField("Payment", text: $payment)
                    TextField("Notes", text: $notes, axis: .vertical).lineLimit(2...5)
                }
                if let e = error {
                    Section { Text(e).font(.caption).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Edit \(order.id)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("বাতিল") { dismiss() }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Saving…" : "Save") { Task { await save() } }.disabled(busy)
                }
            }
        }
    }

    private func save() async {
        guard let qtyNum = Int(qty.trimmingCharacters(in: .whitespaces)), qtyNum > 0 else {
            error = "Quantity must be a positive number"; return
        }
        guard let priceNum = Int(unitPrice.trimmingCharacters(in: .whitespaces)), priceNum >= 0 else {
            error = "Unit price must be a valid number"; return
        }
        busy = true
        defer { busy = false }
        struct Fields: Encodable {
            let customer, phone, address, product, payment, notes: String
            let qty, unit_price: Int
        }
        struct Body: Encodable {
            let order_id, business_id: String
            let fields: Fields
        }
        struct FailedField: Decodable { let field: String?; let error: String? }
        struct Resp: Decodable { let ok: Bool?; let failed: [FailedField]? }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/orders/orders/edit",
                body: Body(order_id: order.id,
                           business_id: order.businessId ?? "ALMA_LIFESTYLE",
                           fields: Fields(customer: customer, phone: phone, address: address,
                                          product: product, payment: payment, notes: notes,
                                          qty: qtyNum, unit_price: priceNum)))
            if let failed = r.failed, !failed.isEmpty {
                error = failed.compactMap { $0.error ?? $0.field }.joined(separator: "; ")
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            } else {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                await vm.load()
                dismiss()
            }
        } catch {
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

// MARK: - Delete-request sheet (POST /api/orders/orders/delete-request)

@available(iOS 17.0, *)
private struct OrdDeleteRequestSheet: View {
    let order: AlmaOrder
    @Environment(\.dismiss) private var dismiss

    @State private var reason = ""
    @State private var busy = false
    @State private var error: String? = nil
    @State private var done: String? = nil

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Super Admin must approve in Approvals. The order is hidden from lists after approval (sheet row kept for audit).")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Reason") {
                    TextField("Why should this order be removed? (min 5 characters)",
                              text: $reason, axis: .vertical)
                        .lineLimit(3...6)
                }
                if let e = error {
                    Section { Text(e).font(.caption).foregroundStyle(.red) }
                }
                if let d = done {
                    Section { Text(d).font(.caption).foregroundStyle(.green) }
                }
            }
            .navigationTitle("Request delete — \(order.id)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("বাতিল") { dismiss() }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Submitting…" : "Submit") { Task { await submit() } }
                        .disabled(busy || done != nil)
                }
            }
        }
    }

    private func submit() async {
        let trimmed = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 5 else {
            error = "Enter a delete reason (at least 5 characters)"; return
        }
        busy = true
        defer { busy = false }
        struct Body: Encodable { let order_id, business_id, reason: String }
        struct Resp: Decodable { let ok: Bool?; let message: String? }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/orders/orders/delete-request",
                body: Body(order_id: order.id,
                           business_id: order.businessId ?? "ALMA_LIFESTYLE",
                           reason: trimmed))
            error = nil
            done = r.message ?? "Delete request sent for Super Admin approval"
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            dismiss()
        } catch {
            self.error = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

// MARK: - Aurora background + glass card (the owner's theme — Orders-owned copies)

/// The ALMA aurora: deep indigo → violet → magenta wash (dark) / cream with soft coral,
/// violet and pink washes (light) — the same ambient the Assistant surface and the web
/// dashboard wear. Owner reference screenshot 2026-07-06. Lives in the Orders files (not
/// the shared shell) so parallel page sessions can't collide on it.
@available(iOS 17.0, *)
struct OrdersAurora: View {
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

/// Frosted glass card over the aurora — translucent surface + hairline ring, so the
/// gradient glows through (the Assistant-surface card look, per the owner's reference).
@available(iOS 17.0, *)
struct OrdersGlassCard<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    var title: String? = nil
    var icon: String? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title {
                HStack(spacing: 7) {
                    if let icon {
                        Image(systemName: icon)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(AlmaSwiftTheme.coral)
                    }
                    Text(title)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                }
                .padding(.bottom, 2)
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.12 : 0.5), lineWidth: 1))
    }
}

/// Small glass surface for chips / fields / row cards (same recipe, tighter radius).
@available(iOS 17.0, *)
extension View {
    func ordersGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

// MARK: - Shimmer (loading skeleton)

@available(iOS 17.0, *)
private struct Shimmer: ViewModifier {
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
extension View {
    fileprivate func shimmering() -> some View { modifier(Shimmer()) }
}

// MARK: - Bento components (Orders-owned copies of the Dashboard board language —
// per-file copies are this repo's parallel-session convention, no cross-file imports)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func ordMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct OrdCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    let format: (Int) -> String
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        OrdCountUpText(value: shown, format: format)
            .animation(ordMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if ordMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct OrdCountUpText: View, Animatable {
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

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
/// deep indigo base + violet/coral washes + a sage hint). Revenue count-up headline
/// plus the PROFIT / ORDERS split — the exact three numbers the old stat strip showed
/// (revenue/profit = Delivered rows in the active filter, orders = visible rows).
@available(iOS 17.0, *)
private struct OrdBentoHeroCard: View {
    let revenue: Int
    let profit: Int
    let orders: Int

    private static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)  // #F4A28C
    private static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502) // #4ADE80
    private static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)   // #EF4444

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("মোট আয় · REVENUE").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(Self.goldLt)
            OrdCountUp(target: revenue, format: { AlmaSwiftTheme.takaShort($0) })
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            Text("ডেলিভারড বিক্রি — এই ফিল্টারে")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Profit",
                         value: OrdCountUp(target: profit, format: { AlmaSwiftTheme.takaShort($0) }),
                         tint: profit >= 0 ? Self.green400 : Self.red500,
                         sub: "ডেলিভারড মুনাফা")
                Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
                    .padding(.vertical, 2).padding(.horizontal, 14)
                heroStat(label: "Orders",
                         value: OrdCountUp(target: orders, format: { "\($0)" }),
                         tint: .white, sub: "এই ফিল্টারে")
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

    private func heroStat(label: String, value: OrdCountUp, tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            value
                .font(.system(size: 20, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.6)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Orders — Light") {
    OrdersScreen(openWeb: { _, _ in })
        .preferredColorScheme(.light)
}
