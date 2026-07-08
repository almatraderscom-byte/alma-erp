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
    let collectionType: String?   // "MEN" | "WOMEN" | "SINGLE" | "CUSTOM"
    let sizeGroup: String?        // "KIDS" | "ADULT" | ""  (MEN pools)
    let variantGroup: String?     // "ORNA" | "TWO PIECE" | "THREE PIECE" | ""  (WOMEN pools)
    let active: Bool?
    let archived: Bool?
    var id: String { sku ?? UUID().uuidString }

    enum CodingKeys: String, CodingKey {
        case sku, product, category, size, available
        case buyingPrice, collectionCode, collectionType, sizeGroup, variantGroup
        case active, archived
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
        collectionType = try? c.decodeIfPresent(String.self, forKey: .collectionType)
        sizeGroup = try? c.decodeIfPresent(String.self, forKey: .sizeGroup)
        variantGroup = try? c.decodeIfPresent(String.self, forKey: .variantGroup)
        active = try? c.decodeIfPresent(Bool.self, forKey: .active)
        archived = try? c.decodeIfPresent(Bool.self, forKey: .archived)
    }

    /// A pool row is only offerable when it's active and not archived (web parity).
    var isSellable: Bool { (active ?? true) && !(archived ?? false) }
}

// MARK: - Size engine (faithful Swift port of collection-engine.ts)

/// The web's collection rules, verbatim: MEN collections use numeric sizes 16–54 that
/// deduct from a KIDS (16–36) or ADULT (38–54) pool; WOMEN collections use variant
/// groups that normalize to ORNA / TWO PIECE / THREE PIECE. Everything else falls back
/// to the raw stock rows. This is what makes the native picker match /orders/new.
enum SizeEngine {
    static let menSizes: [String] = (0..<20).map { String(16 + $0 * 2) }   // 16,18,…,54
    static let womenVariants: [String] = [
        "ORNA", "TWO PIECE (1-5)", "TWO PIECE (6Y-9Y)", "TWO PIECE (10Y-14Y)", "THREE PIECE",
    ]

    static func sizeGroup(for size: String) -> String? {
        guard let n = Int(size) else { return nil }
        if (16...36).contains(n) { return "KIDS" }
        if (38...54).contains(n) { return "ADULT" }
        return nil
    }

    static func normalizeWomenVariant(_ value: String?) -> String? {
        let v = (value ?? "").uppercased()
        if v.isEmpty { return nil }
        if v.contains("ORNA") { return "ORNA" }
        if v.contains("THREE") || v.contains("3 PIECE") || v.contains("3PC") { return "THREE PIECE" }
        let two = ["TWO", "2 PIECE", "2PC", "10Y", "14Y", "10-14", "6Y", "9Y", "6-9", "1Y", "5Y", "1-5", "2Y", "2-5"]
        if two.contains(where: { v.contains($0) }) { return "TWO PIECE" }
        return nil
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
    let collectionType: String // "MEN" | "WOMEN" | "SINGLE" | "CUSTOM" | ""
    var options: [AlmaStockItem]
    var id: String { key }

    var totalAvailable: Int { options.reduce(0) { $0 + ($1.available ?? 0) } }
    var sellableOptions: [AlmaStockItem] { options.filter { $0.isSellable } }
    var isMen: Bool { collectionType.uppercased() == "MEN" }
    var isWomen: Bool { collectionType.uppercased() == "WOMEN" }

    /// The KIDS / ADULT stock row that a numeric MEN size deducts from.
    func menPool(_ group: String) -> AlmaStockItem? {
        sellableOptions.first { ($0.sizeGroup ?? $0.size ?? "").uppercased() == group.uppercased() }
    }
    /// The ORNA / TWO PIECE / THREE PIECE stock row a WOMEN variant deducts from.
    func womenPool(_ variant: String) -> AlmaStockItem? {
        sellableOptions.first {
            (SizeEngine.normalizeWomenVariant($0.variantGroup ?? $0.size) ?? "") == variant
        }
    }

    /// CUSTOM/SINGLE fallback: the raw rows, numeric-aware sort.
    var sortedOptions: [AlmaStockItem] {
        sellableOptions.sorted {
            let a = Int($0.size ?? ""), b = Int($1.size ?? "")
            if let a, let b { return a < b }
            return ($0.size ?? "") < ($1.size ?? "")
        }
    }

    /// One-line subtitle for the search result row (type-aware, no misleading "সাইজ").
    var subtitle: String {
        if isMen { return "মেন্স · KIDS + ADULT · মোট স্টক \(totalAvailable)" }
        if isWomen { return "উইমেন্স · \(sellableOptions.count) ভ্যারিয়েন্ট · মোট স্টক \(totalAvailable)" }
        return "\(category) · \(sellableOptions.count) অপশন · মোট স্টক \(totalAvailable)"
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
    var collectionType: String
    var stock: AlmaStockItem       // the matched inventory POOL row (sku/available/cogs)
    var displaySize: String        // "42" (MEN) · "TWO PIECE (6Y-9Y)" (WOMEN) · size (CUSTOM)
    var sizeGroup: String          // "KIDS"/"ADULT" (MEN) else ""
    var variantGroup: String       // "TWO PIECE" etc (WOMEN) else ""
    var qty = 1
    var sellPrice: Int

    var subtotal: Int { qty * sellPrice }
    var cogsTotal: Int { qty * (stock.buyingPrice ?? 0) }
    var isWomen: Bool { collectionType.uppercased() == "WOMEN" }
    var isMen: Bool { collectionType.uppercased() == "MEN" }
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
    @State private var isAdding = false                  // "আরেকটা পণ্য যোগ করুন" flow open
    @FocusState private var searchFocused: Bool
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

    // ── Loss guard (owner rule) ── an order may NOT be created at a loss.
    /// Lines whose sell price is below their buying (raw inventory) cost.
    private var belowCostItems: [FormItem] {
        items.filter { ($0.stock.buyingPrice ?? 0) > 0 && $0.sellPrice < ($0.stock.buyingPrice ?? 0) }
    }
    /// The order is a loss if any line sells below cost OR the estimated profit is negative.
    private var isLossOrder: Bool { !belowCostItems.isEmpty || estimatedProfit < 0 }
    /// Plain-Bangla reason shown to the owner when the order is blocked for a loss.
    private var lossReason: String? {
        guard isLossOrder else { return nil }
        if let first = belowCostItems.first {
            return "\(first.groupKey) — বিক্রয়মূল্য কেনা দামের (৳\(first.stock.buyingPrice ?? 0)) নিচে। ক্ষতিতে অর্ডার তৈরি করা যাবে না।"
        }
        return "এই অর্ডারে ৳\(abs(estimatedProfit).formatted()) ক্ষতি হচ্ছে। বিক্রয়মূল্য বাড়ান বা খরচ কমান — ক্ষতিতে অর্ডার তৈরি করা যাবে না।"
    }

    private var canSubmit: Bool {
        !customer.trimmingCharacters(in: .whitespaces).isEmpty && phoneValid && !items.isEmpty
            && items.allSatisfy { $0.qty >= 1 && $0.sellPrice > 0 } && !isLossOrder && !submitting
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
            .dismissKeyboardOnTap()   // tap anywhere off a field closes the keyboard
            .navigationTitle("নতুন অর্ডার")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("বাতিল") { dismiss() }.tint(AlmaSwiftTheme.coral)
                }
                // number/phone pads have no return key — give every keyboard a Done.
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("সম্পন্ন") { hideKeyboard() }
                        .font(.subheadline.weight(.semibold))
                        .tint(AlmaSwiftTheme.coral)
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
                // Cart lines first (a normal cart reads top-to-bottom), then the add
                // controls. Each cartLine is its own glass card, so no divider between.
                ForEach($items) { $item in
                    cartLine($item).padding(.top, 8)
                }
                // Show the search/picker when the cart is empty OR the owner tapped "add
                // another"; otherwise show the button that reveals it. This is what makes a
                // 2nd, 3rd… product addable — the picker re-appears right where you act.
                if items.isEmpty || isAdding {
                    if !items.isEmpty { divider }
                    searchArea
                } else {
                    divider
                    addAnotherButton
                }
                if items.isEmpty && query.isEmpty {
                    Text("কোড লিখে খুঁজুন → সাইজ বাছুন → কার্টে যোগ হবে। একাধিক পণ্য যোগ করা যায়।")
                        .font(.caption).foregroundStyle(.secondary)
                        .padding(.top, 2)
                }
            }
        }
    }

    /// The collection search field + results + size/variant picker. Used both for the
    /// first product and (via "আরেকটা পণ্য যোগ করুন") every product after it.
    @ViewBuilder
    private var searchArea: some View {
        glassField("কালেকশন কোড / SKU / নাম", text: $query)
            .focused($searchFocused)
            .onChange(of: query) { pickingGroup = nil }
        if !query.isEmpty && pickingGroup == nil { groupResults }
        if let g = pickingGroup { sizePicker(g) }
        if !items.isEmpty {
            Button("বাতিল") {
                isAdding = false
                query = ""
                pickingGroup = nil
                searchFocused = false
            }
            .font(.caption).foregroundStyle(.secondary)
            .padding(.top, 4)
        }
    }

    private var addAnotherButton: some View {
        Button {
            isAdding = true
            query = ""
            pickingGroup = nil
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            searchFocused = true
        } label: {
            Label("আরেকটা পণ্য যোগ করুন", systemImage: "plus.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AlmaSwiftTheme.coral)
        }
        .padding(.top, 2)
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
                            Text(g.subtitle)
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

    /// Web-parity size/variant selector — branches on the collection TYPE exactly like
    /// /orders/new: MEN → numeric sizes grouped into KIDS/ADULT pools; WOMEN → variant
    /// groups; everything else → the raw stock rows.
    @ViewBuilder
    private func sizePicker(_ g: StockGroup) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text("\(g.key) — \(g.product)")
                    .font(.subheadline.weight(.bold))
                Spacer()
                Button {
                    pickingGroup = nil
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            Text(pickerHint(g)).font(.caption).foregroundStyle(.secondary)
            if g.isMen {
                menSizeGrid(g)
            } else if g.isWomen {
                womenVariantChips(g)
            } else {
                customChips(g)
            }
        }
        .padding(.top, 4)
    }

    private func pickerHint(_ g: StockGroup) -> String {
        if g.isMen { return "সাইজ বাছুন — ১৬–৩৬ শিশু (KIDS), ৩৮–৫৪ বড় (ADULT) স্টক থেকে কাটবে।" }
        if g.isWomen { return "ভ্যারিয়েন্ট বাছুন — বয়স ব্যান্ড অর্ডারে থাকবে, স্টক ORNA / TWO PIECE / THREE PIECE থেকে কাটবে।" }
        return "সাইজ / ভ্যারিয়েন্ট বাছুন।"
    }

    /// MEN: numeric sizes, split under their KIDS / ADULT pool with the pool's live stock
    /// shown ONCE (not repeated per size — the old bug showed "ADULT · 648" as a size).
    @ViewBuilder
    private func menSizeGrid(_ g: StockGroup) -> some View {
        ForEach(["KIDS", "ADULT"], id: \.self) { pool in
            if let row = g.menPool(pool) {
                let avail = row.available ?? 0
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        Text(pool == "KIDS" ? "শিশু · KIDS" : "বড় · ADULT")
                            .font(.caption.weight(.bold)).foregroundStyle(.primary)
                        Text("স্টক \(avail)")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(avail > 0 ? AlmaSwiftTheme.violet : AlmaSwiftTheme.ios27Red(scheme))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background((avail > 0 ? AlmaSwiftTheme.violet : AlmaSwiftTheme.ios27Red(scheme)).opacity(0.14),
                                        in: Capsule())
                    }
                    FlowChips(items: SizeEngine.menSizes
                        .filter { SizeEngine.sizeGroup(for: $0) == pool }
                        .map { size in
                            (label: size, disabled: avail < 1,
                             action: { addMenItem(group: g, size: size, pool: row) })
                        })
                }
            }
        }
    }

    /// WOMEN: every variant-group label the web offers, as long as this collection stocks
    /// that pool. Age bands (1-5 / 6Y-9Y / 10Y-14Y) all deduct the one TWO PIECE pool.
    private func womenVariantChips(_ g: StockGroup) -> some View {
        let chips: [(label: String, disabled: Bool, action: () -> Void)] =
            SizeEngine.womenVariants.compactMap { label in
                let norm = SizeEngine.normalizeWomenVariant(label) ?? label
                guard let row = g.womenPool(norm) else { return nil }
                let avail = row.available ?? 0
                return (label: "\(label) · \(avail)", disabled: avail < 1,
                        action: { addWomenItem(group: g, label: label, variant: norm, pool: row) })
            }
        return FlowChips(items: chips)
    }

    /// CUSTOM / SINGLE / unknown: the raw stock rows themselves (web's dynamic pool list).
    private func customChips(_ g: StockGroup) -> some View {
        FlowChips(items: g.sortedOptions.map { opt in
            (label: "\(opt.size ?? opt.variantGroup ?? "?") · \(opt.available ?? 0)",
             disabled: (opt.available ?? 0) < 1,
             action: { addCustomItem(group: g, option: opt) })
        })
    }

    private func cartLine(_ item: Binding<FormItem>) -> some View {
        let it = item.wrappedValue
        let group = groups[it.groupKey]
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(group?.product ?? it.stock.product ?? "—")
                        .font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text("\(it.groupKey) · \(it.stock.sku ?? "") · স্টক \(it.stock.available ?? 0)")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Button(role: .destructive) {
                    items.removeAll { $0.id == it.id }
                } label: {
                    Image(systemName: "trash").font(.footnote)
                }
                .buttonStyle(.borderless).tint(AlmaSwiftTheme.ios27Red(scheme))
            }
            HStack(spacing: 10) {
                if let group { sizeSwitchMenu(item, group) }
                Spacer()
                // Quantity: show the live count next to the −/+ stepper. (The stepper's own
                // label is hidden by SwiftUI, so without this explicit number the owner sees
                // no quantity when picking a product or tapping +.)
                Text("পরিমাণ").font(.caption).foregroundStyle(.secondary)
                Text("\(it.qty)")
                    .font(.callout.weight(.bold)).monospacedDigit()
                    .frame(minWidth: 24)
                    .foregroundStyle(AlmaSwiftTheme.coral)
                    .contentTransition(.numericText())
                Stepper(value: item.qty, in: 1...max(1, it.stock.available ?? 1)) {
                    EmptyView()
                }
                .labelsHidden()
                .fixedSize()
            }
            HStack(spacing: 8) {
                Text("দাম ৳").font(.caption).foregroundStyle(.secondary)
                TextField("0", value: item.sellPrice, format: .number)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.leading)
                    .frame(width: 86)
                    .padding(.vertical, 6).padding(.horizontal, 10)
                    .background(.white.opacity(scheme == .dark ? 0.08 : 0.6),
                                in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
                Spacer()
                Text("৳\(it.subtotal.formatted())")
                    .font(.subheadline.weight(.bold)).foregroundStyle(AlmaSwiftTheme.coral)
            }
            // Below-cost warning on the offending line (buying price is known only to the owner).
            if (it.stock.buyingPrice ?? 0) > 0, it.sellPrice < (it.stock.buyingPrice ?? 0) {
                Label("বিক্রয়মূল্য কেনা দামের (৳\(it.stock.buyingPrice ?? 0)) নিচে",
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2.weight(.semibold)).foregroundStyle(AlmaSwiftTheme.ios27Red(scheme))
            }
        }
        .padding(12)
        .background(.white.opacity(scheme == .dark ? 0.05 : 0.45),
                    in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
            .strokeBorder(Color.white.opacity(scheme == .dark ? 0.08 : 0.55), lineWidth: 1))
    }

    /// Switch an already-added line to another size/variant of the SAME collection,
    /// re-resolving the inventory pool row — type-aware, exactly like the picker.
    @ViewBuilder
    private func sizeSwitchMenu(_ item: Binding<FormItem>, _ group: StockGroup) -> some View {
        let it = item.wrappedValue
        Menu {
            if group.isMen {
                ForEach(SizeEngine.menSizes, id: \.self) { size in
                    if let pool = group.menPool(SizeEngine.sizeGroup(for: size) ?? "") {
                        Button("\(size)  (স্টক \(pool.available ?? 0))") {
                            item.wrappedValue.stock = pool
                            item.wrappedValue.displaySize = size
                            item.wrappedValue.sizeGroup = SizeEngine.sizeGroup(for: size) ?? ""
                            item.wrappedValue.variantGroup = ""
                            item.wrappedValue.qty = min(it.qty, max(1, pool.available ?? 1))
                        }
                        .disabled((pool.available ?? 0) < 1)
                    }
                }
            } else if group.isWomen {
                ForEach(SizeEngine.womenVariants, id: \.self) { label in
                    let norm = SizeEngine.normalizeWomenVariant(label) ?? label
                    if let pool = group.womenPool(norm) {
                        Button("\(label)  (স্টক \(pool.available ?? 0))") {
                            item.wrappedValue.stock = pool
                            item.wrappedValue.displaySize = label
                            item.wrappedValue.variantGroup = norm
                            item.wrappedValue.sizeGroup = ""
                            item.wrappedValue.qty = min(it.qty, max(1, pool.available ?? 1))
                        }
                        .disabled((pool.available ?? 0) < 1)
                    }
                }
            } else {
                ForEach(group.sortedOptions) { opt in
                    Button("\(opt.size ?? opt.variantGroup ?? "?")  (স্টক \(opt.available ?? 0))") {
                        item.wrappedValue.stock = opt
                        item.wrappedValue.displaySize = opt.size ?? opt.variantGroup ?? ""
                        item.wrappedValue.sizeGroup = opt.sizeGroup ?? ""
                        item.wrappedValue.variantGroup = SizeEngine.normalizeWomenVariant(opt.variantGroup) ?? ""
                        item.wrappedValue.qty = min(it.qty, max(1, opt.available ?? 1))
                    }
                    .disabled((opt.available ?? 0) < 1)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(it.isWomen ? it.displaySize : "সাইজ \(it.displaySize)").lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.caption2)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(AlmaSwiftTheme.violet)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(AlmaSwiftTheme.violet.opacity(0.15), in: Capsule())
        }
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
                // Label flips to "ক্ষতি" (loss) when profit is negative — never call a loss "লাভ".
                Text(estimatedProfit >= 0 ? "আনুমানিক লাভ" : "আনুমানিক ক্ষতি")
                    .font(.subheadline.weight(estimatedProfit >= 0 ? .regular : .semibold))
                    .foregroundStyle(estimatedProfit >= 0 ? Color.primary : AlmaSwiftTheme.ios27Red(scheme))
                Spacer()
                Text("৳\(abs(estimatedProfit).formatted())")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(estimatedProfit >= 0
                        ? AlmaSwiftTheme.ios27Green(scheme) : AlmaSwiftTheme.ios27Red(scheme))
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
                Text(e).font(.footnote).foregroundStyle(AlmaSwiftTheme.ios27Red(scheme))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // Loss guard: explain why the button is locked so the owner can fix the price.
            if let loss = lossReason {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.footnote).foregroundStyle(AlmaSwiftTheme.ios27Red(scheme))
                    Text(loss).font(.footnote.weight(.semibold)).foregroundStyle(AlmaSwiftTheme.ios27Red(scheme))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(AlmaSwiftTheme.ios27Red(scheme).opacity(0.12),
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
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
                            in: Capsule())
                .foregroundStyle(.white)
                .shadow(color: canSubmit ? AlmaSwiftTheme.coral.opacity(0.35) : .clear,
                        radius: 10, y: 4)
            }
            .buttonStyle(AlmaCapsuleButtonStyle())
            .disabled(!canSubmit)
            Button("ওয়েব ফর্মে খুলুন") { dismiss(); openWeb("/orders/new", "নতুন অর্ডার") }
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    // ── Field helpers (glassy rows, not stock Form chrome) ──

    private var divider: some View {
        Divider().overlay(AlmaSwiftTheme.separator(scheme))
    }

    private func glassField(_ placeholder: String, text: Binding<String>,
                            keyboard: UIKeyboardType = .default, invalid: Bool = false) -> some View {
        TextField(placeholder, text: text)
            .keyboardType(keyboard)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(.vertical, 9)
            .foregroundStyle(invalid ? AlmaSwiftTheme.ios27Red(scheme) : Color.primary)
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
                            in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
        }
        .padding(.vertical, 3)
    }

    // ── Catalog ──

    private func addMenItem(group: StockGroup, size: String, pool: AlmaStockItem) {
        appendItem(group: group, stock: pool, display: size,
                   sizeGroup: SizeEngine.sizeGroup(for: size) ?? "", variantGroup: "")
    }
    private func addWomenItem(group: StockGroup, label: String, variant: String, pool: AlmaStockItem) {
        appendItem(group: group, stock: pool, display: label, sizeGroup: "", variantGroup: variant)
    }
    private func addCustomItem(group: StockGroup, option: AlmaStockItem) {
        appendItem(group: group, stock: option,
                   display: option.size ?? option.variantGroup ?? "",
                   sizeGroup: option.sizeGroup ?? "",
                   variantGroup: SizeEngine.normalizeWomenVariant(option.variantGroup) ?? "")
    }
    private func appendItem(group: StockGroup, stock: AlmaStockItem, display: String,
                            sizeGroup: String, variantGroup: String) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        let price = defaultSellPrice(for: stock, group: group)
        items.append(FormItem(groupKey: group.key, collectionType: group.collectionType,
                              stock: stock, displaySize: display,
                              sizeGroup: sizeGroup, variantGroup: variantGroup, sellPrice: price))
        query = ""
        pickingGroup = nil
        isAdding = false
        searchFocused = false
    }

    /// The default SELL price to pre-fill (web parity: use the product master's
    /// `default_price`, matched by stock SKU → collection code → product name; NEVER the
    /// buying price). Returns 0 when unknown so the owner types the sell price himself.
    private func defaultSellPrice(for stock: AlmaStockItem, group: StockGroup) -> Int {
        for key in [stock.sku, group.key, group.product, stock.product] {
            let k = (key ?? "").trimmingCharacters(in: .whitespaces).lowercased()
            if !k.isEmpty, let p = priceBySku[k], p > 0 { return p }
        }
        return 0
    }

    /// Strip the pool word ("133 ADULT" → "133") so the group title reads as the
    /// collection, not one of its stock rows.
    private func baseProductName(_ row: AlmaStockItem, key: String) -> String {
        var n = (row.product ?? key)
        for suffix in [" ADULT", " KIDS", " ORNA", " THREE PIECE", " TWO PIECE"] {
            if n.uppercased().hasSuffix(suffix) { n = String(n.dropLast(suffix.count)); break }
        }
        let trimmed = n.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? key : trimmed
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
                g[key] = StockGroup(key: key, product: baseProductName(row, key: key),
                                    category: row.category ?? "",
                                    collectionType: row.collectionType ?? "", options: [row])
            } else {
                g[key]?.options.append(row)
            }
        }
        groups = g
        // Key the default SELL price by product SKU and NAME (both normalized), so the
        // native picker can resolve it by stock SKU, collection code, or product name —
        // mirrors the web's productByCode map (sku/id/name). Only positive prices count.
        var map: [String: Int] = [:]
        for p in products?.products ?? [] {
            guard let price = p.defaultPrice, price > 0 else { continue }
            for key in [p.sku, p.name] {
                let k = (key ?? "").trimmingCharacters(in: .whitespaces).lowercased()
                if !k.isEmpty, map[k] == nil { map[k] = price }
            }
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
        let firstProduct = groups[first.groupKey]?.product ?? first.stock.product ?? ""
        let title = items.count > 1
            ? "\(firstProduct) + \(items.count - 1) more"
            : firstProduct
        let payload = CreateOrderPayload(
            customer: customer, customer_name: customer,
            phone: phone.filter(\.isNumber), customer_phone: phone.filter(\.isNumber),
            address: address, customer_address: address,
            product: title, product_name: title,
            category: first.stock.category ?? "",
            size: first.displaySize,
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
                // MEN → size=numeric, size_group=KIDS/ADULT. WOMEN → variant=label,
                // variant_group=normalized. CUSTOM → size & variant carry the chosen value.
                let women = it.isWomen
                return CreateOrderPayload.Item(
                    line_no: i + 1,
                    product_code: it.groupKey,
                    product: groups[it.groupKey]?.product ?? it.stock.product ?? "",
                    category: it.stock.category ?? "",
                    size: women ? "" : it.displaySize,
                    variant: women ? it.displaySize : (it.sizeGroup.isEmpty ? it.displaySize : ""),
                    size_group: it.sizeGroup,
                    variant_group: it.variantGroup,
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
