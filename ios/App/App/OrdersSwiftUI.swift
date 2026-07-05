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
        let byStatus: [String: Int]?
        enum CodingKeys: String, CodingKey {
            case total
            case byStatus = "by_status"
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
    static func tint(_ s: String) -> Color {
        switch s {
        case "Pending":   return .orange
        case "Confirmed": return .blue
        case "Packed":    return .indigo
        case "Shipped":   return .teal
        case "Delivered": return .green
        case "CANCELLED", "Cancelled": return .gray
        default:           return .red // returned family
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
    var statusFilter: String? = nil
    var search = ""
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: OrdersListResponse = try await AlmaAPI.shared.get(
                "/api/orders/orders",
                query: ["business_id": "ALMA_LIFESTYLE",
                        "status": statusFilter,
                        "search": search.isEmpty ? nil : search,
                        "limit": "300"])
            orders = resp.orders
            byStatus = resp.summary?.byStatus ?? [:]
            total = resp.summary?.total ?? resp.orders.count
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

    /// Escape hatches into the proven web screens (create order, full drawer, login).
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10, pinnedViews: []) {
                chipsRow
                searchRow
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
        .claudeTopFade() // Claude-style top dissolve under the glass nav bar
        .refreshable { await vm.load() }
        .scrollDismissesKeyboard(.immediately)
        .task { await vm.load() }
        .sheet(item: $selected) { order in
            OrderDetailSheet(order: order, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .overlay(alignment: .bottomTrailing) { newOrderFAB }
    }

    // Status chips — single edge-to-edge scrollable row, like the web (build 33 look).
    private var chipsRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(nil, label: "All", count: vm.total)
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
        return Button {
            UISelectionFeedbackGenerator().selectionChanged()
            vm.statusFilter = status
            Task { await vm.load() }
        } label: {
            HStack(spacing: 5) {
                if let status { Circle().fill(OrderStatusMeta.tint(status)).frame(width: 7, height: 7) }
                Text(label).font(.footnote.weight(active ? .semibold : .regular))
                if count > 0 {
                    Text("\(count)").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(active ? AnyShapeStyle(.thickMaterial) : AnyShapeStyle(.thinMaterial), in: Capsule())
            .overlay(Capsule().strokeBorder(active ? Color.accentColor.opacity(0.55) : .clear, lineWidth: 1))
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
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    private var newOrderFAB: some View {
        // Order CREATION stays on the proven web form — one tap away, nothing lost.
        Button {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            openWeb("/orders", "নতুন অর্ডার") // create stays on the proven web form
        } label: {
            Label("নতুন অর্ডার", systemImage: "plus")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background(Color(red: 0.878, green: 0.478, blue: 0.373), in: Capsule()) // ALMA coral
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
                        .padding(.horizontal, 7).padding(.vertical, 3)
                        .background(.quaternary, in: Capsule())
                }
                if let c = order.courier, !c.isEmpty {
                    Text(c).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(14)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
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
