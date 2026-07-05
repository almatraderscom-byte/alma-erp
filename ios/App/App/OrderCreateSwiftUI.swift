//
//  OrderCreateSwiftUI.swift
//  ALMA ERP — S6: native "নতুন অর্ডার" form (the web drawer's create flow, native).
//
//  Mirrors src/components/orders/new-order/* exactly:
//    POST /api/orders/orders  — required: customer, phone, payment, source, ≥1 item.
//    Catalog preloaded once (GET /api/products + GET /api/stock) and searched LOCALLY —
//    the web has no per-keystroke autocomplete API. Every line item must be connected
//    to inventory (a picked stock row supplies sku / size / cogs / availability), the
//    same rule the web validator enforces.
//  Money is whole-taka Ints everywhere (roundMoney parity):
//    payable = max(0, subtotal − discount + shipping) · order sell_price excludes shipping.
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

// MARK: - Create payload (aliases duplicated exactly like normalizeCreateOrderPayload)

private struct CreateOrderPayload: Encodable {
    struct Item: Encodable {
        let line_no: Int
        let product_code: String
        let product: String
        let category: String
        let size: String
        let qty: Int
        let unit_price: Int
        let sell_price: Int
        let subtotal: Int
        let sku: String
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

// MARK: - Form line item

@available(iOS 17.0, *)
private struct FormItem: Identifiable {
    let id = UUID()
    var stock: AlmaStockItem
    var qty = 1
    var sellPrice: Int

    var subtotal: Int { qty * sellPrice }
    var cogsTotal: Int { qty * (stock.buyingPrice ?? 0) }
}

// MARK: - Sheet

@available(iOS 17.0, *)
struct OrderCreateSheet: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dismiss) private var dismiss
    let onCreated: () -> Void
    let openWeb: (_ path: String, _ title: String) -> Void

    // Customer
    @State private var customer = ""
    @State private var phone = ""
    @State private var address = ""
    @State private var source = "Facebook"
    // Items + catalog
    @State private var items: [FormItem] = []
    @State private var stock: [AlmaStockItem] = []
    @State private var priceBySku: [String: Int] = [:]
    @State private var catalogLoading = true
    @State private var query = ""
    // Totals
    @State private var shipping = 0
    @State private var discount = 0
    @State private var paidNow = 0
    @State private var courierCost = 80          // web default (internal)
    // Delivery
    @State private var payment = "COD"
    @State private var courier = "Pathao"
    @State private var status = "Pending"
    @State private var notes = ""
    // Submission
    @State private var submitting = false
    @State private var errorMsg: String? = nil
    @State private var successId: String? = nil

    private let sources = ["Facebook", "WhatsApp", "Instagram", "Website"]
    private let payments = ["COD", "bKash", "Nagad", "Rocket", "Bank Transfer", "Card"]
    private let couriers = ["Pathao", "Redx", "Steadfast", "Paperfly", "E-courier", "Sundarban", "SA Paribahan"]
    private let statuses = ["Pending", "Confirmed", "Packed", "Shipped", "Delivered"]

    // ── Money math (web parity: calculate-totals.ts) ──
    private var subtotal: Int { items.reduce(0) { $0 + $1.subtotal } }
    private var payable: Int { max(0, subtotal - discount + shipping) }
    private var due: Int { payable - min(paidNow, payable) }
    private var orderSellPrice: Int { max(0, subtotal - discount) }   // shipping excluded
    private var inventoryCost: Int { items.reduce(0) { $0 + $1.cogsTotal } }
    private var estimatedProfit: Int { (orderSellPrice - inventoryCost) + shipping - courierCost }
    private var totalQty: Int { items.reduce(0) { $0 + $1.qty } }

    private var phoneValid: Bool {
        let digits = phone.filter(\.isNumber)
        return digits.range(of: "^01[3-9][0-9]{8}$", options: .regularExpression) != nil
    }
    private var canSubmit: Bool {
        !customer.trimmingCharacters(in: .whitespaces).isEmpty && phoneValid && !items.isEmpty
            && items.allSatisfy { $0.qty >= 1 && $0.sellPrice > 0 } && !submitting
    }

    var body: some View {
        NavigationStack {
            Form {
                customerSection
                itemsSection
                totalsSection
                deliverySection
                submitSection
            }
            .navigationTitle("নতুন অর্ডার")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("বাতিল") { dismiss() } }
            }
            .task { await loadCatalog() }
            .alert("অর্ডার তৈরি হয়েছে ✅", isPresented: Binding(
                get: { successId != nil }, set: { if !$0 { successId = nil } })) {
                Button("ঠিক আছে") { dismiss(); onCreated() }
            } message: {
                Text(successId ?? "")
            }
        }
        .preferredColorScheme(colorScheme)   // follow the app theme inside the sheet
    }

    // ── Sections ──

    private var customerSection: some View {
        Section("গ্রাহক") {
            TextField("নাম *", text: $customer)
            TextField("ফোন (01XXXXXXXXX) *", text: $phone)
                .keyboardType(.phonePad)
                .foregroundStyle(phone.isEmpty || phoneValid ? .primary : Color.red)
            TextField("ঠিকানা (জেলা + এলাকা)", text: $address)
            Picker("সোর্স", selection: $source) {
                ForEach(sources, id: \.self) { Text($0) }
            }
        }
    }

    private var itemsSection: some View {
        Section("পণ্য") {
            if catalogLoading {
                HStack { ProgressView(); Text("স্টক লোড হচ্ছে…").foregroundStyle(.secondary) }
            } else {
                TextField("কোড / SKU / নাম লিখে খুঁজুন", text: $query)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if !query.isEmpty {
                    ForEach(matches.prefix(6)) { s in
                        Button { addItem(s) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(s.product ?? s.sku ?? "—").font(.subheadline)
                                    Text("\(s.sku ?? "") · Size \(s.size ?? "—") · স্টক \(s.available ?? 0)")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "plus.circle.fill")
                                    .foregroundStyle(AlmaSwiftTheme.coral)
                            }
                        }
                        .disabled((s.available ?? 0) < 1)
                    }
                    if matches.isEmpty {
                        Text("মিল পাওয়া যায়নি").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            ForEach($items) { $item in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.stock.product ?? "—").font(.subheadline.weight(.semibold))
                            Text("\(item.stock.sku ?? "") · Size \(item.stock.size ?? "—") · স্টক \(item.stock.available ?? 0)")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(role: .destructive) {
                            items.removeAll { $0.id == item.id }
                        } label: { Image(systemName: "trash") }
                            .buttonStyle(.borderless)
                    }
                    HStack {
                        Stepper("Qty \(item.qty)", value: $item.qty,
                                in: 1...max(1, item.stock.available ?? 1))
                        Spacer()
                    }
                    HStack {
                        Text("দাম ৳")
                        TextField("0", value: $item.sellPrice, format: .number)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.trailing)
                        Text("= ৳\(item.subtotal.formatted())").foregroundStyle(.secondary)
                    }
                    .font(.subheadline)
                }
                .padding(.vertical, 2)
            }
            if items.isEmpty && !catalogLoading {
                Text("উপরে খুঁজে পণ্য যোগ করুন — ইনভেন্টরির সাথে যুক্ত পণ্যই নেওয়া হয়")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var totalsSection: some View {
        Section("টাকার হিসাব") {
            moneyRow("শিপিং ৳", $shipping)
            moneyRow("ডিসকাউন্ট ৳", $discount)
            moneyRow("অগ্রিম পরিশোধ ৳", $paidNow)
            moneyRow("কুরিয়ার খরচ ৳ (ইন্টারনাল)", $courierCost)
            LabeledContent("সাবটোটাল", value: "৳\(subtotal.formatted())")
            LabeledContent("মোট পরিশোধ্য", value: "৳\(payable.formatted())")
                .font(.body.weight(.semibold))
            LabeledContent("বাকি", value: "৳\(due.formatted())")
            LabeledContent("আনুমানিক লাভ", value: "৳\(estimatedProfit.formatted())")
                .foregroundStyle(estimatedProfit >= 0 ? Color.green : Color.red)
        }
    }

    private var deliverySection: some View {
        Section("ডেলিভারি ও পেমেন্ট") {
            Picker("পেমেন্ট", selection: $payment) { ForEach(payments, id: \.self) { Text($0) } }
            Picker("কুরিয়ার", selection: $courier) { ForEach(couriers, id: \.self) { Text($0) } }
            Picker("স্ট্যাটাস", selection: $status) { ForEach(statuses, id: \.self) { Text($0) } }
            TextField("নোট", text: $notes, axis: .vertical).lineLimit(2...4)
        }
    }

    private var submitSection: some View {
        Section {
            if let e = errorMsg {
                Text(e).font(.footnote).foregroundStyle(.red)
            }
            Button {
                Task { await submit() }
            } label: {
                HStack {
                    Spacer()
                    if submitting { ProgressView().tint(.white) }
                    else { Text("অর্ডার তৈরি করুন").font(.body.weight(.semibold)) }
                    Spacer()
                }
                .padding(.vertical, 6)
            }
            .listRowBackground(canSubmit ? AlmaSwiftTheme.coral : Color.gray.opacity(0.4))
            .foregroundStyle(.white)
            .disabled(!canSubmit)
            Button("ওয়েব ফর্মে খুলুন") { dismiss(); openWeb("/orders/new", "নতুন অর্ডার") }
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func moneyRow(_ label: String, _ value: Binding<Int>) -> some View {
        HStack {
            Text(label)
            Spacer()
            TextField("0", value: value, format: .number)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .frame(width: 110)
        }
    }

    // ── Catalog / matching ──

    private var matches: [AlmaStockItem] {
        let q = query.lowercased()
        return stock.filter { s in
            (s.sku?.lowercased().contains(q) ?? false)
                || (s.collectionCode?.lowercased().contains(q) ?? false)
                || (s.product?.lowercased().contains(q) ?? false)
        }
    }

    private func addItem(_ s: AlmaStockItem) {
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        // Prefill the selling price from the catalog's default_price (web parity);
        // fall back to buying price so the field is never a blind zero.
        let price = priceBySku[s.sku ?? ""] ?? s.buyingPrice ?? 0
        items.append(FormItem(stock: s, sellPrice: price))
        query = ""
    }

    private func loadCatalog() async {
        catalogLoading = true
        defer { catalogLoading = false }
        async let productsTask: ProductsResponse? = try? AlmaAPI.shared.get("/api/products")
        async let stockTask: StockResponse? = try? AlmaAPI.shared.get("/api/stock")
        let (products, stockResp) = await (productsTask, stockTask)
        stock = (stockResp?.items ?? []).filter { ($0.available ?? 0) > 0 || $0.sku != nil }
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
                CreateOrderPayload.Item(
                    line_no: i + 1,
                    product_code: it.stock.collectionCode ?? it.stock.sku ?? "",
                    product: it.stock.product ?? "",
                    category: it.stock.category ?? "",
                    size: it.stock.size ?? "",
                    qty: it.qty,
                    unit_price: it.sellPrice,
                    sell_price: it.sellPrice,
                    subtotal: it.subtotal,
                    sku: it.stock.sku ?? "",
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

@available(iOS 17.0, *)
#Preview("New order — Light") {
    OrderCreateSheet(onCreated: {}, openWeb: { _, _ in }).preferredColorScheme(.light)
}
