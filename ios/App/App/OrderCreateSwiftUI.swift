//
//  OrderCreateSwiftUI.swift
//  ALMA ERP — S6: native "নতুন অর্ডার" form, FULL web parity + the owner's aurora theme.
//
//  Flow (same as the web drawer / /orders/new):
//    গ্রাহক → পণ্য (collection code/SKU/নাম → SIZE/VARIANT chips with live stock →
//    multi-item cart, per-item size switch + qty + price) → টাকার হিসাব → ডেলিভারি → submit.
//    POST /api/orders/orders with the exact web payload (+ aliases + items[]).
//  Catalog preloaded once (GET /api/products + /api/stock), searched locally and GROUPED
//  by collection code — each stock row of a group is one size/variant option, so every
//  item is inventory-connected (the web validator's hard rule) without reimplementing
//  the collection engine. Money = whole-taka Ints, calculate-totals.ts parity.
//  Look: the app's aurora gradient + frosted glass cards (owner reference: the Assistant
//  surface). All visual helpers live in OrdersSwiftUI.swift (Orders-owned files only).
//

import SwiftUI

// MARK: - Catalog models (tolerant of both flat and {ok,data:{…}} wrappers)

struct AlmaProduct: Decodable {
    let sku: String?
    let name: String?
    let category: String?
    let defaultPrice: Int?
    let defaultCogs: Int?
    enum CodingKeys: String, CodingKey {
        case sku, name, category
        case defaultPrice = "default_price"
        case defaultCogs = "default_cogs"
    }
}

struct AlmaStockItem: Decodable, Identifiable {
    let sku: String?
    let product: String?
    let category: String?
    let size: String?
    let available: Int?
    let buyingPrice: Int?
    let collectionCode: String?
    var id: String { sku ?? UUID().uuidString }

    enum CodingKeys: String, CodingKey {
        case sku, product, category, size, available
        case buyingPrice, collectionCode
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sku = try? c.decodeIfPresent(String.self, forKey: .sku)
        product = try? c.decodeIfPresent(String.self, forKey: .product)
        category = try? c.decodeIfPresent(String.self, forKey: .category)
        size = (try? c.decodeIfPresent(String.self, forKey: .size))
            ?? (try? c.decodeIfPresent(Int.self, forKey: .size)).map(String.init)
        available = (try? c.decodeIfPresent(Int.self, forKey: .available))
            ?? (try? c.decodeIfPresent(Double.self, forKey: .available)).map { Int($0) }
        buyingPrice = (try? c.decodeIfPresent(Int.self, forKey: .buyingPrice))
            ?? (try? c.decodeIfPresent(Double.self, forKey: .buyingPrice)).map { Int($0.rounded()) }
        collectionCode = try? c.decodeIfPresent(String.self, forKey: .collectionCode)
    }
}

private struct ProductsResponse: Decodable {
    let products: [AlmaProduct]
    private enum Keys: String, CodingKey { case data, products }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        products = (try? c.decode([AlmaProduct].self, forKey: .products)) ?? []
    }
}

private struct StockResponse: Decodable {
    let items: [AlmaStockItem]
    private enum Keys: String, CodingKey { case data, items }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        items = (try? c.decode([AlmaStockItem].self, forKey: .items)) ?? []
    }
}

/// One collection (e.g. code "133") = one product with many size/variant rows in stock.
/// Grouping the REAL stock rows gives the web's code→size chip flow for free, and every
/// choice is automatically inventory-connected.
struct StockGroup: Identifiable {
    let key: String            // collection code (falls back to sku)
    let product: String
    let category: String
    var options: [AlmaStockItem]
    var id: String { key }

    var totalAvailable: Int { options.reduce(0) { $0 + ($1.available ?? 0) } }

    /// MEN sizes are numeric (16…54) — sort numerically; WOMEN variants alphabetically.
    var sortedOptions: [AlmaStockItem] {
        options.sorted {
            let a = Int($0.size ?? ""), b = Int($1.size ?? "")
            if let a, let b { return a < b }
            return ($0.size ?? "") < ($1.size ?? "")
        }
    }
}

// MARK: - Create payload (aliases duplicated exactly like normalizeCreateOrderPayload)

private struct CreateOrderPayload: Encodable {
    struct Item: Encodable {
        let line_no: Int
        let product_code: String
        let product: String
        let category: String
        let size: String
        let variant: String
        let size_group: String
        let variant_group: String
        let qty: Int
        let unit_price: Int
        let sell_price: Int
        let subtotal: Int
        let sku: String
        let stock_sku: String
        let cogs: Int
    }
    let business_id = "ALMA_LIFESTYLE"
    let customer: String, customer_name: String
    let phone: String, customer_phone: String
    let address: String, customer_address: String
    let product: String, product_name: String
    let category: String
    let size: String
    let qty: Int
    let unit_price: Int
    let sell_price: Int
    let payment_method: String, payment: String
    let source: String
    let status: String
    let courier: String
    let notes: String
    let sku: String
    let cogs: Int
    let courier_charge: Int
    let shipping_fee: Int
    let discount: Int
    let paid_amount: Int
    let due_amount: Int
    let estimated_profit: Int
    let inventory_cost: Int
    let courier_cost: Int
    let items: [Item]
}

private struct CreateOrderResponse: Decodable {
    let ok: Bool?
    let orderId: String?
    let error: String?
    enum CodingKeys: String, CodingKey {
        case ok, error
        case orderId = "order_id"
    }
}

// MARK: - Cart line

@available(iOS 17.0, *)
private struct FormItem: Identifiable {
    let id = UUID()
    var groupKey: String
    var stock: AlmaStockItem       // the CHOSEN size/variant row (sku connected)
    var qty = 1
    var sellPrice: Int

    var subtotal: Int { qty * sellPrice }
    var cogsTotal: Int { qty * (stock.buyingPrice ?? 0) }
}

// MARK: - Sheet

@available(iOS 17.0, *)
struct OrderCreateSheet: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    let onCreated: () -> Void
    let openWeb: (_ path: String, _ title: String) -> Void

    // Customer
    @State private var customer = ""
    @State private var phone = ""
    @State private var address = ""
    @State private var source = "Facebook"
    // Catalog / cart
    @State private var groups: [String: StockGroup] = [:]
    @State private var priceBySku: [String: Int] = [:]
    @State private var catalogLoading = true
    @State private var query = ""
    @State private var pickingGroup: StockGroup? = nil   // group awaiting a size choice
    @State private var items: [FormItem] = []
    // Totals
    @State private var shipping = 0
    @State private var discount = 0
    @State private var paidNow = 0
    @State private var courierCost = 80                  // web default (internal)
    // Delivery (full web option lists — constants.ts)
    @State private var payment = "COD"
    @State private var courier = "Pathao"
    @State private var status = "Pending"
    @State private var notes = ""
    // Submission
    @State private var submitting = false
    @State private var errorMsg: String? = nil
    @State private var successId: String? = nil

    private let sources = ["Facebook", "WhatsApp", "Instagram", "Website", "Walk-in", "Referral"]
    private let payments = ["COD", "bKash", "Nagad", "Rocket", "Bank Transfer", "Card"]
    private let couriers = ["Pathao", "Redx", "Steadfast", "Paperfly", "E-courier", "Sundarban", "SA Paribahan"]
    private let statuses = ["Pending", "Confirmed", "Packed", "Shipped", "Delivered"]

    // ── Money math (calculate-totals.ts parity) ──
    private var subtotal: Int { items.reduce(0) { $0 + $1.subtotal } }
    private var payable: Int { max(0, subtotal - discount + shipping) }
    private var due: Int { payable - min(paidNow, payable) }
    private var orderSellPrice: Int { max(0, subtotal - discount) }   // shipping excluded
    private var inventoryCost: Int { items.reduce(0) { $0 + $1.cogsTotal } }
    private var estimatedProfit: Int { (orderSellPrice - inventoryCost) + shipping - courierCost }
    private var totalQty: Int { items.reduce(0) { $0 + $1.qty } }

    private var phoneValid: Bool {
        phone.filter(\.isNumber).range(of: "^01[3-9][0-9]{8}$", options: .regularExpression) != nil
    }
    private var canSubmit: Bool {
        !customer.trimmingCharacters(in: .whitespaces).isEmpty && phoneValid && !items.isEmpty
            && items.allSatisfy { $0.qty >= 1 && $0.sellPrice > 0 } && !submitting
    }

    var body: some View {
        NavigationStack {
            ZStack {
                OrdersAurora()   // the owner's aurora — the form floats on it in glass cards
                ScrollView {
                    VStack(spacing: 14) {
                        customerCard
                        itemsCard
                        totalsCard
                        deliveryCard
                        submitCard
                        Color.clear.frame(height: 10)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle("নতুন অর্ডার")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("বাতিল") { dismiss() }.tint(AlmaSwiftTheme.coral)
                }
            }
            .task { await loadCatalog() }
            .alert("অর্ডার তৈরি হয়েছে ✅", isPresented: Binding(
                get: { successId != nil }, set: { if !$0 { successId = nil } })) {
                Button("ঠিক আছে") { dismiss(); onCreated() }
            } message: { Text(successId ?? "") }
        }
        .preferredColorScheme(scheme)
    }

    // ── গ্রাহক ──

    private var customerCard: some View {
        OrdersGlassCard(title: "গ্রাহক", icon: "person.fill") {
            glassField("নাম *", text: $customer)
            divider
            glassField("ফোন (01XXXXXXXXX) *", text: $phone, keyboard: .phonePad,
                       invalid: !phone.isEmpty && !phoneValid)
            divider
            glassField("ঠিকানা (জেলা + এলাকা)", text: $address)
            divider
            pickerRow("সোর্স", selection: $source, options: sources)
        }
    }

    // ── পণ্য (code → size chips → cart) ──

    private var itemsCard: some View {
        OrdersGlassCard(title: "পণ্য", icon: "shippingbox.fill") {
            if catalogLoading {
                HStack {
                    ProgressView().tint(AlmaSwiftTheme.coral)
                    Text("স্টক লোড হচ্ছে…").foregroundStyle(.secondary).font(.subheadline)
                }
                .padding(.vertical, 6)
            } else {
                glassField("কালেকশন কোড / SKU / নাম", text: $query)
                    .onChange(of: query) { pickingGroup = nil }
                if !query.isEmpty && pickingGroup == nil { groupResults }
                if let g = pickingGroup { sizePicker(g) }
            }
            ForEach($items) { $item in
                divider
                cartLine($item)
            }
            if items.isEmpty && !catalogLoading && query.isEmpty {
                Text("কোড লিখে খুঁজুন → সাইজ বাছুন → কার্টে যোগ হবে। একাধিক পণ্য যোগ করা যায়।")
                    .font(.caption).foregroundStyle(.secondary)
                    .padding(.top, 2)
            }
            if !items.isEmpty {
                divider
                Button {
                    query = ""
                    pickingGroup = nil
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                } label: {
                    Label("আরেকটা পণ্য যোগ করুন", systemImage: "plus.circle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AlmaSwiftTheme.coral)
                }
                .padding(.top, 2)
            }
        }
    }

    /// Collections matching the query (grouped stock) — like the web's code lookup.
    private var groupResults: some View {
        let q = query.lowercased()
        let hits = groups.values.filter {
            $0.key.lowercased().contains(q) || $0.product.lowercased().contains(q)
        }
        .sorted { $0.key < $1.key }
        .prefix(6)
        return VStack(spacing: 0) {
            ForEach(Array(hits)) { g in
                Button {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    pickingGroup = g
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(g.key) — \(g.product)")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                            Text("\(g.category) · \(g.options.count) সাইজ · মোট স্টক \(g.totalAvailable)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if hits.isEmpty {
                Text("মিল পাওয়া যায়নি").font(.caption).foregroundStyle(.secondary)
                    .padding(.vertical, 6)
            }
        }
    }

    /// The web's size/variant selector: one chip per stock row of the collection.
    private func sizePicker(_ g: StockGroup) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(g.key) — \(g.product): সাইজ বাছুন")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            FlowChips(items: g.sortedOptions.map { opt in
                (label: "\(opt.size ?? "?") · \(opt.available ?? 0)",
                 disabled: (opt.available ?? 0) < 1,
                 action: { addItem(group: g, option: opt) })
            })
        }
        .padding(.top, 4)
    }

    private func cartLine(_ item: Binding<FormItem>) -> some View {
        let it = item.wrappedValue
        let group = groups[it.groupKey]
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(it.stock.product ?? "—").font(.subheadline.weight(.semibold))
                    Text("\(it.stock.sku ?? "") · স্টক \(it.stock.available ?? 0)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                // Size switch — jumps to any other size of the SAME collection (web parity).
                if let group {
                    Menu {
                        ForEach(group.sortedOptions) { opt in
                            Button("\(opt.size ?? "?")  (স্টক \(opt.available ?? 0))") {
                                item.wrappedValue.stock = opt
                                item.wrappedValue.qty = min(it.qty, max(1, opt.available ?? 1))
                            }
                            .disabled((opt.available ?? 0) < 1)
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Text("Size \(it.stock.size ?? "—")")
                            Image(systemName: "chevron.up.chevron.down").font(.caption2)
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AlmaSwiftTheme.violet)
                        .padding(.horizontal, 9).padding(.vertical, 5)
                        .background(AlmaSwiftTheme.violet.opacity(0.15), in: Capsule())
                    }
                }
                Button(role: .destructive) {
                    items.removeAll { $0.id == it.id }
                } label: {
                    Image(systemName: "trash").font(.caption)
                }
                .buttonStyle(.borderless).tint(.red)
            }
            HStack(spacing: 14) {
                Stepper("Qty \(it.qty)", value: item.qty, in: 1...max(1, it.stock.available ?? 1))
                    .font(.subheadline)
                    .fixedSize()
                Spacer()
                Text("দাম ৳")
                    .font(.subheadline).foregroundStyle(.secondary)
                TextField("0", value: item.sellPrice, format: .number)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 70)
                    .padding(.vertical, 4).padding(.horizontal, 8)
                    .background(.white.opacity(scheme == .dark ? 0.08 : 0.55),
                                in: RoundedRectangle(cornerRadius: 8))
            }
            HStack {
                Spacer()
                Text("সাবটোটাল ৳\(it.subtotal.formatted())")
                    .font(.caption.weight(.semibold)).foregroundStyle(AlmaSwiftTheme.coral)
            }
        }
        .padding(.vertical, 6)
    }

    // ── টাকার হিসাব ──

    private var totalsCard: some View {
        OrdersGlassCard(title: "টাকার হিসাব", icon: "banknote.fill") {
            moneyRow("শিপিং ৳", $shipping)
            divider
            moneyRow("ডিসকাউন্ট ৳", $discount)
            divider
            moneyRow("অগ্রিম পরিশোধ ৳", $paidNow)
            divider
            moneyRow("কুরিয়ার খরচ ৳ (ইন্টারনাল)", $courierCost)
            divider
            summaryRow("সাবটোটাল", subtotal)
            summaryRow("মোট পরিশোধ্য", payable, bold: true)
            summaryRow("বাকি", due)
            HStack {
                Text("আনুমানিক লাভ").font(.subheadline)
                Spacer()
                Text("৳\(estimatedProfit.formatted())")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(estimatedProfit >= 0
                        ? Color(red: 0.133, green: 0.773, blue: 0.369) : .red)
            }
            .padding(.vertical, 3)
        }
    }

    private func summaryRow(_ label: String, _ value: Int, bold: Bool = false) -> some View {
        HStack {
            Text(label).font(.subheadline)
            Spacer()
            Text("৳\(value.formatted())")
                .font(bold ? .body.weight(.bold) : .subheadline.weight(.medium))
        }
        .padding(.vertical, 3)
    }

    // ── ডেলিভারি ──

    private var deliveryCard: some View {
        OrdersGlassCard(title: "ডেলিভারি ও পেমেন্ট", icon: "truck.box.fill") {
            pickerRow("পেমেন্ট", selection: $payment, options: payments)
            divider
            pickerRow("কুরিয়ার", selection: $courier, options: couriers)
            divider
            pickerRow("স্ট্যাটাস", selection: $status, options: statuses)
            divider
            TextField("নোট", text: $notes, axis: .vertical)
                .lineLimit(2...4)
                .padding(.vertical, 6)
        }
    }

    private var submitCard: some View {
        VStack(spacing: 10) {
            if let e = errorMsg {
                Text(e).font(.footnote).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button {
                Task { await submit() }
            } label: {
                HStack {
                    Spacer()
                    if submitting { ProgressView().tint(.white) }
                    else {
                        Label("অর্ডার তৈরি করুন", systemImage: "checkmark.circle.fill")
                            .font(.body.weight(.bold))
                    }
                    Spacer()
                }
                .padding(.vertical, 14)
                .background(canSubmit ? AlmaSwiftTheme.coral : Color.gray.opacity(0.4),
                            in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .foregroundStyle(.white)
                .shadow(color: canSubmit ? AlmaSwiftTheme.coral.opacity(0.35) : .clear,
                        radius: 10, y: 4)
            }
            .disabled(!canSubmit)
            Button("ওয়েব ফর্মে খুলুন") { dismiss(); openWeb("/orders/new", "নতুন অর্ডার") }
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    // ── Field helpers (glassy rows, not stock Form chrome) ──

    private var divider: some View {
        Divider().overlay(Color.primary.opacity(scheme == .dark ? 0.10 : 0.06))
    }

    private func glassField(_ placeholder: String, text: Binding<String>,
                            keyboard: UIKeyboardType = .default, invalid: Bool = false) -> some View {
        TextField(placeholder, text: text)
            .keyboardType(keyboard)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(.vertical, 9)
            .foregroundStyle(invalid ? Color.red : Color.primary)
    }

    private func pickerRow(_ label: String, selection: Binding<String>, options: [String]) -> some View {
        HStack {
            Text(label).font(.subheadline)
            Spacer()
            Picker(label, selection: selection) {
                ForEach(options, id: \.self) { Text($0) }
            }
            .pickerStyle(.menu)
            .tint(AlmaSwiftTheme.violet)
        }
        .padding(.vertical, 2)
    }

    private func moneyRow(_ label: String, _ value: Binding<Int>) -> some View {
        HStack {
            Text(label).font(.subheadline)
            Spacer()
            TextField("0", value: value, format: .number)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 100)
                .padding(.vertical, 5).padding(.horizontal, 8)
                .background(.white.opacity(scheme == .dark ? 0.08 : 0.55),
                            in: RoundedRectangle(cornerRadius: 8))
        }
        .padding(.vertical, 3)
    }

    // ── Catalog ──

    private func addItem(group: StockGroup, option: AlmaStockItem) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        let price = priceBySku[option.sku ?? ""] ?? priceBySku[group.key] ?? option.buyingPrice ?? 0
        items.append(FormItem(groupKey: group.key, stock: option, sellPrice: price))
        query = ""
        pickingGroup = nil
    }

    private func loadCatalog() async {
        catalogLoading = true
        defer { catalogLoading = false }
        async let productsTask: ProductsResponse? = try? AlmaAPI.shared.get("/api/products")
        async let stockTask: StockResponse? = try? AlmaAPI.shared.get("/api/stock")
        let (products, stockResp) = await (productsTask, stockTask)
        var g: [String: StockGroup] = [:]
        for row in stockResp?.items ?? [] {
            let key = (row.collectionCode?.isEmpty == false ? row.collectionCode! : (row.sku ?? "?"))
            if g[key] == nil {
                g[key] = StockGroup(key: key, product: row.product ?? key,
                                    category: row.category ?? "", options: [row])
            } else {
                g[key]?.options.append(row)
            }
        }
        groups = g
        var map: [String: Int] = [:]
        for p in products?.products ?? [] {
            if let sku = p.sku, let price = p.defaultPrice { map[sku] = price }
        }
        priceBySku = map
    }

    // ── Submit ──

    private func submit() async {
        guard canSubmit else { return }
        submitting = true
        errorMsg = nil
        defer { submitting = false }
        let first = items[0]
        let title = items.count > 1
            ? "\(first.stock.product ?? "") + \(items.count - 1) more"
            : (first.stock.product ?? "")
        /// KIDS 16–36 / ADULT 38–54 — the collection engine's MEN size grouping.
        func sizeGroup(_ size: String?) -> String {
            guard let n = Int(size ?? "") else { return "" }
            return n <= 36 ? "KIDS" : "ADULT"
        }
        let payload = CreateOrderPayload(
            customer: customer, customer_name: customer,
            phone: phone.filter(\.isNumber), customer_phone: phone.filter(\.isNumber),
            address: address, customer_address: address,
            product: title, product_name: title,
            category: first.stock.category ?? "",
            size: first.stock.size ?? "",
            qty: totalQty,
            unit_price: totalQty > 0 ? Int((Double(subtotal) / Double(totalQty)).rounded()) : 0,
            sell_price: orderSellPrice,
            payment_method: payment, payment: payment,
            source: source,
            status: status,
            courier: courier,
            notes: notes,
            sku: first.stock.sku ?? "",
            cogs: inventoryCost,
            courier_charge: courierCost,
            shipping_fee: shipping,
            discount: discount,
            paid_amount: paidNow,
            due_amount: due,
            estimated_profit: estimatedProfit,
            inventory_cost: inventoryCost,
            courier_cost: courierCost,
            items: items.enumerated().map { i, it in
                let numeric = Int(it.stock.size ?? "") != nil
                return CreateOrderPayload.Item(
                    line_no: i + 1,
                    product_code: it.groupKey,
                    product: it.stock.product ?? "",
                    category: it.stock.category ?? "",
                    size: it.stock.size ?? "",
                    variant: numeric ? "" : (it.stock.size ?? ""),
                    size_group: numeric ? sizeGroup(it.stock.size) : "",
                    variant_group: numeric ? "" : (it.stock.size ?? ""),
                    qty: it.qty,
                    unit_price: it.sellPrice,
                    sell_price: it.sellPrice,
                    subtotal: it.subtotal,
                    sku: it.stock.sku ?? "",
                    stock_sku: it.stock.sku ?? "",
                    cogs: it.stock.buyingPrice ?? 0)
            })
        do {
            let resp: CreateOrderResponse = try await AlmaAPI.shared.send(
                "POST", "/api/orders/orders", body: payload)
            if let err = resp.error {
                errorMsg = err
                UINotificationFeedbackGenerator().notificationOccurred(.error)
            } else {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                successId = resp.orderId ?? "সফল"
            }
        } catch {
            errorMsg = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

// MARK: - Flow layout for size chips

/// Simple wrapping chip row (sizes can be 10+ options — they must wrap, not overflow).
@available(iOS 17.0, *)
struct FlowChips: View {
    let items: [(label: String, disabled: Bool, action: () -> Void)]

    var body: some View {
        FlowLayout(spacing: 8) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, chip in
                Button(action: chip.action) {
                    Text(chip.label)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(chip.disabled ? Color.secondary : AlmaSwiftTheme.coral)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(
                            (chip.disabled ? Color.gray : AlmaSwiftTheme.coral)
                                .opacity(chip.disabled ? 0.10 : 0.16),
                            in: Capsule())
                        .overlay(Capsule().strokeBorder(
                            chip.disabled ? .clear : AlmaSwiftTheme.coral.opacity(0.45)))
                }
                .disabled(chip.disabled)
                .buttonStyle(.plain)
            }
        }
    }
}

@available(iOS 17.0, *)
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for sub in subviews {
            let s = sub.sizeThatFits(.unspecified)
            if x + s.width > width, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += s.width + spacing
            rowH = max(rowH, s.height)
        }
        return CGSize(width: width, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for sub in subviews {
            let s = sub.sizeThatFits(.unspecified)
            if x + s.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX; y += rowH + spacing; rowH = 0
            }
            sub.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += s.width + spacing
            rowH = max(rowH, s.height)
        }
    }
}

@available(iOS 17.0, *)
#Preview("New order — Dark") {
    OrderCreateSheet(onCreated: {}, openWeb: { _, _ in }).preferredColorScheme(.dark)
}
