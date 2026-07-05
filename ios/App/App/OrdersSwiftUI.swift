//
//  OrdersSwiftUI.swift
//  ALMA ERP — S6: the Orders tab as a fully native SwiftUI screen.
//
//  Talks to the SAME Next.js endpoints the web Orders page uses (via AlmaAPI's
//  cookie bridge — no new server routes):
//    GET  /api/orders/orders?business_id=…&status=…&search=…   → list + summary
//    POST /api/orders/orders/status  {id, status, reason?}     → status change
//  v1 scope (owner-approved S6 kickoff): list + status chips + search + detail +
//  status actions + call/WhatsApp. Creating/editing an order stays on the web —
//  the detail sheet has an "ওয়েবে খুলুন" escape hatch, so nothing is ever lost.
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
    let size: String?
    let qty: Int?
    let sellPrice: Int?
    let shippingFee: Int?
    let discount: Int?
    let payment: String?
    let source: String?
    let courier: String?
    let trackingId: String?
    let notes: String?
    let profit: Int?

    enum CodingKeys: String, CodingKey {
        case id, date, customer, phone, address, status, product, size, qty
        case sellPrice = "sell_price"
        case shippingFee = "shipping_fee"
        case discount, payment, source, courier
        case trackingId = "tracking_id"
        case notes, profit
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
        size = try? c.decodeIfPresent(String.self, forKey: .size)
        qty = Self.flexInt(c, .qty)
        sellPrice = Self.flexInt(c, .sellPrice)
        shippingFee = Self.flexInt(c, .shippingFee)
        discount = Self.flexInt(c, .discount)
        payment = try? c.decodeIfPresent(String.self, forKey: .payment)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        courier = try? c.decodeIfPresent(String.self, forKey: .courier)
        trackingId = try? c.decodeIfPresent(String.self, forKey: .trackingId)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        profit = Self.flexInt(c, .profit)
    }

    private static func flexInt(_ c: KeyedDecodingContainer<CodingKeys>, _ k: CodingKeys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
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
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class OrdersVM {
    var orders: [AlmaOrder] = []
    var byStatus: [String: Int] = [:]
    var total = 0
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
            let isReturns = statusFilter == Self.returnsSentinel
            let resp: OrdersListResponse = try await AlmaAPI.shared.get(
                "/api/orders/orders",
                query: ["business_id": "ALMA_LIFESTYLE",
                        "status": isReturns ? nil : statusFilter,
                        "payment": payment,
                        "source": source,
                        "startDate": start,
                        "endDate": end,
                        "search": search.isEmpty ? nil : search,
                        "limit": "500"])
            var list = resp.orders
            if isReturns { list = list.filter { Self.returnStatuses.contains($0.status) } }
            switch sort {   // web sort options: newest (server order) / oldest / price / profit
            case "oldest": list.reverse()
            case "price": list.sort { ($0.sellPrice ?? 0) > ($1.sellPrice ?? 0) }
            case "profit": list.sort { ($0.profit ?? 0) > ($1.profit ?? 0) }
            default: break
            }
            orders = list
            byStatus = resp.summary?.byStatus ?? [:]
            total = resp.summary?.total ?? resp.orders.count
            revenue = resp.summary?.totalRevenue ?? 0
            profit = resp.summary?.totalProfit ?? 0
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Optimistic status change with rollback — same behavior the web drawer has.
    func setStatus(_ order: AlmaOrder, to status: String, reason: String? = nil) async -> Bool {
        let old = order.status
        if let i = orders.firstIndex(where: { $0.id == order.id }) { orders[i].status = status }
        do {
            var body: [String: String] = ["id": order.id, "status": status]
            if let reason { body["reason"] = reason }
            let _: StatusChangeResponse = try await AlmaAPI.shared.send("POST", "/api/orders/orders/status", body: body)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            await load() // refresh counts + row (server may cascade fields)
            return true
        } catch {
            if let i = orders.firstIndex(where: { $0.id == order.id }) { orders[i].status = old }
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
                    OrderCard(order: order)
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
        .background(AlmaSwiftTheme.rootBg(colorScheme).ignoresSafeArea())
        .claudeTopFade() // Claude-style top dissolve under the glass nav bar
        .refreshable { await vm.load() }
        .scrollDismissesKeyboard(.immediately)
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

    // ── Stats cards (ORDERS / REVENUE / PROFIT — same numbers the web header shows) ──

    private var statsRow: some View {
        HStack(spacing: 10) {
            statCard("ORDERS", "\(vm.total)", .primary)
            statCard("REVENUE", AlmaSwiftTheme.takaShort(vm.revenue), AlmaSwiftTheme.coral)
            statCard("PROFIT", AlmaSwiftTheme.takaShort(vm.profit),
                     vm.profit >= 0 ? Color.green : Color.red)
        }
    }

    private func statCard(_ title: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.headline.weight(.bold)).foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(AlmaSwiftTheme.cardBg(colorScheme),
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: AlmaSwiftTheme.cardShadow(colorScheme), radius: 6, y: 2)
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
                .background(AlmaSwiftTheme.cardBg(colorScheme),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .shadow(color: AlmaSwiftTheme.cardShadow(colorScheme), radius: 6, y: 2)
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
                .background(active ? tint.opacity(colorScheme == .dark ? 0.18 : 0.12)
                                   : AlmaSwiftTheme.cardBg(colorScheme),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(active ? tint.opacity(0.5) : .clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // Status chips — single edge-to-edge scrollable row, like the web (build 33 look).
    private var chipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(nil, label: "All", count: vm.total)
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
            Task { await vm.load() }
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
            .background(active ? tint.opacity(colorScheme == .dark ? 0.18 : 0.12)
                               : AlmaSwiftTheme.cardBg(colorScheme),
                        in: Capsule())
            .overlay(Capsule().strokeBorder(active ? tint.opacity(0.5) : .clear, lineWidth: 1))
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
        .background(AlmaSwiftTheme.cardBg(colorScheme),
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: AlmaSwiftTheme.cardShadow(colorScheme), radius: 6, y: 2)
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
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private var loadingRows: some View {
        ForEach(0..<6, id: \.self) { _ in
            RoundedRectangle(cornerRadius: 16)
                .fill(.thinMaterial)
                .frame(height: 92)
                .shimmering()
        }
    }
}

// MARK: - Row card

@available(iOS 17.0, *)
private struct OrderCard: View {
    let order: AlmaOrder
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
        .background(AlmaSwiftTheme.cardBg(colorScheme),
                    in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: AlmaSwiftTheme.cardShadow(colorScheme), radius: 6, y: 2)
        .contentShape(RoundedRectangle(cornerRadius: 16))
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
    @State private var confirmCancel = false
    @State private var busy = false

    /// Live copy — vm.orders is refreshed after actions; fall back to the passed order.
    private var live: AlmaOrder { vm.orders.first(where: { $0.id == order.id }) ?? order }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                infoGrid
                if !OrderStatusMeta.isTerminal(live.status) { actionButtons }
                contactButtons
                webEscape
            }
            .padding(18)
        }
        .presentationBackground(.thinMaterial)
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

    private var infoGrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            row("person", live.customer)
            row("phone", live.phone)
            row("mappin.and.ellipse", live.address)
            row("shippingbox", [live.product, live.size.map { "Size \($0)" },
                                live.qty.map { "×\($0)" }].compactMap { $0 }.joined(separator: " · "))
            if let amt = live.sellPrice { row("banknote", "৳\(amt.formatted())  (\(live.payment ?? "—"))") }
            if let c = live.courier, !c.isEmpty { row("truck.box", "\(c)  \(live.trackingId ?? "")") }
            // Multi-item orders carry machine JSON in notes (ORDER_ITEMS_JSON…) — that's
            // internal bookkeeping, never show it. Only human-written notes render.
            if let n = live.notes, !n.isEmpty,
               !n.hasPrefix("ORDER_ITEMS_JSON"), !n.hasPrefix("{") {
                row("note.text", n)
            }
        }
        .padding(14)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    private func row(_ icon: String, _ text: String?) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).frame(width: 18).foregroundStyle(.secondary)
            Text((text?.isEmpty == false ? text! : "—")).font(.subheadline)
        }
    }

    private var actionButtons: some View {
        VStack(spacing: 8) {
            ForEach(OrderStatusMeta.nextSteps(from: live.status), id: \.self) { next in
                Button {
                    Task { busy = true; _ = await vm.setStatus(live, to: next); busy = false }
                } label: {
                    Label(OrderStatusMeta.label(next), systemImage: "arrow.right.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(OrderStatusMeta.tint(next))
                .disabled(busy)
            }
            Button(role: .destructive) { confirmCancel = true } label: {
                Label("Cancel order", systemImage: "xmark.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(busy)
            .confirmationDialog("অর্ডারটি ক্যানসেল করবেন?", isPresented: $confirmCancel, titleVisibility: .visible) {
                Button("হ্যাঁ, ক্যানসেল", role: .destructive) {
                    Task { busy = true; _ = await vm.setStatus(live, to: "CANCELLED"); busy = false }
                }
                Button("না", role: .cancel) {}
            }
        }
    }

    private var contactButtons: some View {
        HStack(spacing: 10) {
            if let phone = live.phone, !phone.isEmpty {
                Link(destination: URL(string: "tel://\(phone)")!) {
                    Label("Call", systemImage: "phone.fill").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                // WhatsApp: strip the leading 0, prefix country code (spec note #5).
                if phone.hasPrefix("0"), let wa = URL(string: "https://wa.me/880\(phone.dropFirst())") {
                    Link(destination: wa) {
                        Label("WhatsApp", systemImage: "message.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }

    private var webEscape: some View {
        Button {
            dismiss()
            openWeb("/orders", "Orders") // full drawer lives on the web list
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

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Orders — Light") {
    OrdersScreen(openWeb: { _, _ in })
        .preferredColorScheme(.light)
}
