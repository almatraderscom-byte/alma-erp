//
//  InventorySwiftUI.swift
//  ALMA ERP — the Inventory screen as native SwiftUI (browse/search/detail + writes).
//
//  Mirrors the web /inventory page:
//    GET  /api/stock → { items: StockItem[], summary: { total_skus, low_stock,
//                        out_of_stock, total_value } }   (flat — no {ok,data} wrapper)
//    POST /api/stock → inventory mutations (web api.stock.mutate parity):
//          { action:"adjust",  sku, new_stock, buying_price?, reason }
//          { action:"edit",    sku, data:{ buyingPrice?, reorder_level? } }
//          { action:"archive", sku, reason:"manual archive" }
//          { action:"restore", sku }
//    POST /api/products → add product (web AddProductModal single-mode parity):
//          { name, sku?, category?, default_price, default_cogs, color?, size?,
//            initial_stock, reorder_level, notes?, supplier:"manual",
//            sync_to_stock, skip_duplicate_name_check:false }
//  The web page loads the FULL stock list once and filters client-side
//  (view chips Active/Archived/Low/Out · category select · text search over
//  sku/product/category/collection/barcode/pool label) — the native screen does the
//  same, with the search debounced because the list can run to thousands of rows.
//  Every write asks a Bangla confirmationDialog first (SKU + quantity delta spelled
//  out) and shows a per-SKU spinner — never a global overlay. Success/error notices
//  mirror the web's toasts; the list reloads after each committed write.
//  Photo upload + collection/bulk add stay on the web (complex uploader/grid) — a
//  small link opens them. Carried lessons: lenient per-field decoding (GAS mixes
//  numbers/strings), ONE spinner per row, never a global overlay.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum InventoryPalette {
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
    /// Positive money (web txt-pos): green-400 over dark aurora, emerald on cream.
    static func positive(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? green400 : emerald600
    }
}

// MARK: - Models (same field names /api/stock emits — GAS-lenient decoding)

struct InventoryStockItem: Decodable, Identifiable, Equatable {
    let sku: String
    let product: String
    let category: String?
    let color: String?
    let size: String?
    let opening: Int
    let purchased: Int
    let sold: Int
    let returned: Int
    let damaged: Int
    let reserved: Int
    let currentStock: Int
    let available: Int
    let reorderLevel: Int
    let stockValue: Int
    let sellValue: Int
    let potentialProfit: Int
    let collectionCode: String?
    let collectionType: String?
    let sizeGroup: String?
    let variantGroup: String?
    let sizeCategory: String?
    let sizeValue: String?
    let buyingPrice: Int?      // redacted server-side for non-admin roles → nil
    let sellingPrice: Int?
    let barcode: String?
    let active: Bool?
    let archived: Bool?

    var id: String { sku }

    private enum Keys: String, CodingKey {
        case sku, product, category, color, size
        case opening, purchased, sold, returned, damaged, reserved
        case current_stock, available, reorder_level
        case stock_value, sell_value, potential_profit
        case collectionCode, collectionType, sizeGroup, variantGroup, sizeCategory, sizeValue
        case buyingPrice, selling_price, barcode, active, archived
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        sku = (try? c.decode(String.self, forKey: .sku)) ?? ""
        product = (try? c.decode(String.self, forKey: .product)) ?? "—"
        category = try? c.decodeIfPresent(String.self, forKey: .category)
        color = try? c.decodeIfPresent(String.self, forKey: .color)
        size = try? c.decodeIfPresent(String.self, forKey: .size)
        opening = Self.flexInt(c, .opening) ?? 0
        purchased = Self.flexInt(c, .purchased) ?? 0
        sold = Self.flexInt(c, .sold) ?? 0
        returned = Self.flexInt(c, .returned) ?? 0
        damaged = Self.flexInt(c, .damaged) ?? 0
        reserved = Self.flexInt(c, .reserved) ?? 0
        currentStock = Self.flexInt(c, .current_stock) ?? 0
        available = Self.flexInt(c, .available) ?? 0
        reorderLevel = Self.flexInt(c, .reorder_level) ?? 0
        stockValue = Self.flexInt(c, .stock_value) ?? 0
        sellValue = Self.flexInt(c, .sell_value) ?? 0
        potentialProfit = Self.flexInt(c, .potential_profit) ?? 0
        collectionCode = try? c.decodeIfPresent(String.self, forKey: .collectionCode)
        collectionType = try? c.decodeIfPresent(String.self, forKey: .collectionType)
        sizeGroup = try? c.decodeIfPresent(String.self, forKey: .sizeGroup)
        variantGroup = try? c.decodeIfPresent(String.self, forKey: .variantGroup)
        sizeCategory = try? c.decodeIfPresent(String.self, forKey: .sizeCategory)
        sizeValue = try? c.decodeIfPresent(String.self, forKey: .sizeValue)
        buyingPrice = Self.flexInt(c, .buyingPrice)
        sellingPrice = Self.flexInt(c, .selling_price)
        barcode = try? c.decodeIfPresent(String.self, forKey: .barcode)
        active = try? c.decodeIfPresent(Bool.self, forKey: .active)
        archived = try? c.decodeIfPresent(Bool.self, forKey: .archived)
    }

    /// GAS/Sheets mixes numeric shapes — Int, Double, numeric string. Whole-taka rule:
    /// doubles round to whole numbers.
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) {
            if let i = Int(s) { return i }
            if let d = Double(s) { return Int(d.rounded()) }
        }
        return nil
    }

    static func == (a: InventoryStockItem, b: InventoryStockItem) -> Bool {
        a.sku == b.sku && a.available == b.available && a.archived == b.archived
            && a.buyingPrice == b.buyingPrice && a.reorderLevel == b.reorderLevel
    }

    /// Web inventoryPoolLabel(): MEN → sizeGroup, WOMEN → variantGroup, else sizeValue.
    var poolLabel: String? {
        let candidates: [String?] = switch collectionType {
        case "MEN": [sizeGroup, sizeCategory, sizeValue, size]
        case "WOMEN": [variantGroup, sizeValue, size]
        default: [sizeValue, variantGroup, size]
        }
        return candidates.compactMap { $0 }.first { !$0.isEmpty }
    }

    /// Web status badge: ARCHIVED · OUT (≤0) · LOW (≤ reorder) · IN STOCK.
    var statusLabel: String {
        if archived == true { return "ARCHIVED" }
        if available <= 0 { return "OUT" }
        if available <= reorderLevel { return "LOW" }
        return "IN STOCK"
    }
    var statusColor: Color {
        if archived == true { return .secondary }
        if available <= 0 { return InventoryPalette.red500 }
        if available <= reorderLevel { return InventoryPalette.amber500 }
        return InventoryPalette.green400
    }

    /// Web: Math.round(sold / (opening + purchased + 0.01) * 100).
    var utilisationPct: Int {
        Int((Double(sold) / (Double(opening + purchased) + 0.01) * 100).rounded())
    }
}

/// GET /api/stock answers flat `{ items, summary }` — but decode a `{ok,data}` wrapper
/// too, in case the route ever migrates to apiDataSuccess like approvals did.
struct InventoryStockResponse: Decodable {
    let items: [InventoryStockItem]
    let totalSkus: Int
    let lowStock: Int
    let outOfStock: Int
    let totalValue: Int

    private enum Keys: String, CodingKey { case ok, data, items, summary }
    private enum SummaryKeys: String, CodingKey { case total_skus, low_stock, out_of_stock, total_value }

    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        items = (try? c.decode([InventoryStockItem].self, forKey: .items)) ?? []
        if let s = try? c.nestedContainer(keyedBy: SummaryKeys.self, forKey: .summary) {
            totalSkus = Self.flexInt(s, .total_skus) ?? items.count
            lowStock = Self.flexInt(s, .low_stock) ?? 0
            outOfStock = Self.flexInt(s, .out_of_stock) ?? 0
            totalValue = Self.flexInt(s, .total_value) ?? 0
        } else {
            totalSkus = items.count
            lowStock = 0
            outOfStock = 0
            totalValue = 0
        }
    }

    private static func flexInt(_ c: KeyedDecodingContainer<SummaryKeys>, _ k: SummaryKeys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

/// POST /api/stock result — `{ ok:true, sku, … }` on success; errors arrive as HTTP
/// 500 `{ error }` (AlmaAPIError.http) but decode a 200-`{error}` shape defensively.
private struct InventoryMutateResponse: Decodable {
    let ok: Bool
    let error: String?
    private enum Keys: String, CodingKey { case ok, error }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        ok = ((try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil) ?? (error == nil)
    }
}

/// POST /api/products result — { ok, product_id, duplicate?, stock:{ ok, reason } }.
private struct InventoryCreateResponse: Decodable {
    let ok: Bool
    let productId: String?
    let stockOk: Bool?
    let stockReason: String?
    let error: String?
    private enum Keys: String, CodingKey { case ok, product_id, stock, error }
    private enum StockKeys: String, CodingKey { case ok, reason }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        ok = ((try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil) ?? false
        productId = try? c.decodeIfPresent(String.self, forKey: .product_id)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        if let s = try? c.nestedContainer(keyedBy: StockKeys.self, forKey: .stock) {
            stockOk = ((try? s.decodeIfPresent(Bool.self, forKey: .ok)) ?? nil)
            stockReason = try? s.decodeIfPresent(String.self, forKey: .reason)
        } else {
            stockOk = nil
            stockReason = nil
        }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class InventoryVM {
    var items: [InventoryStockItem] = []
    var totalSkus = 0
    var lowStockCount = 0
    var outOfStockCount = 0
    var loading = false
    var error: String? = nil
    var notice: String? = nil          // success line (the web's toast.success)
    var authExpired = false

    // Writes — per-SKU busy set (per-row spinners, never a global overlay).
    var busySkus: Set<String> = []
    var creating = false               // add-product in flight

    // Filters — same client-side semantics as the web page.
    var view = "active"            // active | archived | low | out
    var category: String? = nil
    var search = ""                // live TextField text
    var appliedSearch = ""         // debounced needle actually filtered on

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: InventoryStockResponse = try await AlmaAPI.shared.get("/api/stock")
            items = resp.items
            totalSkus = resp.totalSkus
            lowStockCount = resp.lowStock
            outOfStockCount = resp.outOfStock
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

    // ── Writes (web mutateInventory parity — POST /api/stock) ──

    /// One inventory mutation: per-SKU busy flag → POST → success haptic + Bangla
    /// notice → full reload (keeps summary/KPIs honest). Returns the error message
    /// (also mirrored into `self.error`) or nil on success.
    @discardableResult
    private func mutate(sku: String, body: [String: AnyEncodable], successNotice: String) async -> String? {
        guard !sku.isEmpty, !busySkus.contains(sku) else { return "এই SKU-তে আরেকটি কাজ চলছে" }
        busySkus.insert(sku)
        notice = nil
        error = nil
        defer { busySkus.remove(sku) }
        do {
            let resp: InventoryMutateResponse = try await AlmaAPI.shared.send("POST", "/api/stock", body: body)
            if let err = resp.error, !err.isEmpty { throw AlmaAPIError.http(status: 200, body: err) }
            guard resp.ok else { throw AlmaAPIError.http(status: 200, body: "Inventory action failed") }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            notice = successNotice
            await load()
            return nil
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return "সেশন নেই — ওয়েব ট্যাবে লগইন করুন।"
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            let msg = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            self.error = msg
            return msg
        }
    }

    /// Web adjustStock: { action:"adjust", sku, new_stock, buying_price?, reason }.
    /// `new_stock` is the absolute new level (the web prompts with `available`).
    func adjustStock(sku: String, newStock: Int, buyingPrice: Int?, reason: String) async -> String? {
        var body: [String: AnyEncodable] = [
            "action": AnyEncodable("adjust"),
            "sku": AnyEncodable(sku),
            "new_stock": AnyEncodable(newStock),
            "reason": AnyEncodable(reason.isEmpty ? "manual correction" : reason),
        ]
        if let buyingPrice { body["buying_price"] = AnyEncodable(buyingPrice) }
        return await mutate(sku: sku, body: body,
                            successNotice: "স্টক আপডেট হয়েছে — \(sku) → \(newStock)")
    }

    /// Web updateBuyingPrice + reorder-level edit:
    /// { action:"edit", sku, data:{ buyingPrice?, reorder_level? } }.
    func editItem(sku: String, buyingPrice: Int?, reorderLevel: Int?) async -> String? {
        var data: [String: AnyEncodable] = [:]
        if let buyingPrice { data["buyingPrice"] = AnyEncodable(buyingPrice) }
        if let reorderLevel { data["reorder_level"] = AnyEncodable(reorderLevel) }
        guard !data.isEmpty else { return nil }
        let body: [String: AnyEncodable] = [
            "action": AnyEncodable("edit"),
            "sku": AnyEncodable(sku),
            "data": AnyEncodable(data),
        ]
        return await mutate(sku: sku, body: body, successNotice: "আপডেট হয়েছে — \(sku)")
    }

    /// Web archive button: { action:"archive", sku, reason:"manual archive" }.
    func archive(sku: String) async -> String? {
        await mutate(sku: sku, body: [
            "action": AnyEncodable("archive"),
            "sku": AnyEncodable(sku),
            "reason": AnyEncodable("manual archive"),
        ], successNotice: "আর্কাইভ হয়েছে — \(sku)")
    }

    /// Web restore button: { action:"restore", sku }.
    func restore(sku: String) async -> String? {
        await mutate(sku: sku, body: [
            "action": AnyEncodable("restore"),
            "sku": AnyEncodable(sku),
        ], successNotice: "রিস্টোর হয়েছে — \(sku)")
    }

    /// Web AddProductModal single mode: POST /api/products. Returns error or nil.
    func createProduct(body: [String: AnyEncodable]) async -> String? {
        guard !creating else { return "আগের সেভ এখনো চলছে" }
        creating = true
        notice = nil
        error = nil
        defer { creating = false }
        do {
            let resp: InventoryCreateResponse = try await AlmaAPI.shared.send("POST", "/api/products", body: body)
            guard resp.ok, let pid = resp.productId, !pid.isEmpty else {
                let msg = resp.error ?? "সার্ভার থেকে অপ্রত্যাশিত উত্তর।"
                self.error = msg
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                return msg
            }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            var msg = "নতুন আইটেম সেভ হয়েছে — \(pid)"
            if resp.stockOk == false, resp.stockReason == "stock_sku_exists" {
                msg += " (স্টকে এই SKU আগেই ছিল — ডুপ্লিকেট হয়নি)"
            }
            notice = msg
            await load()
            return nil
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
            return "সেশন নেই — ওয়েব ট্যাবে লগইন করুন।"
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            let msg = (error as? AlmaAPIError)?.localizedDescription ?? error.localizedDescription
            self.error = msg
            return msg
        }
    }

    /// Web `items` useMemo — view chip → category → text needle, same fields.
    var filtered: [InventoryStockItem] {
        let needle = appliedSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return items.filter { i in
            let archived = i.archived ?? false
            let viewOK: Bool
            switch view {
            case "archived": viewOK = archived
            case "low": viewOK = !archived && i.active != false && i.available > 0 && i.available <= i.reorderLevel
            case "out": viewOK = !archived && i.active != false && i.available <= 0
            default: viewOK = !archived && i.active != false
            }
            guard viewOK else { return false }
            if let cat = category, !(i.category == cat || i.collectionCode == cat) { return false }
            guard !needle.isEmpty else { return true }
            return [i.sku, i.product, i.category, i.collectionCode, i.barcode, i.poolLabel]
                .contains { ($0 ?? "").lowercased().contains(needle) }
        }
    }

    /// Active (non-archived) items — the web computes the money KPIs over these.
    private var activeItems: [InventoryStockItem] {
        items.filter { $0.archived != true && $0.active != false }
    }

    /// Web KPI "Stock Value" — sum over active items (not summary.total_value).
    var stockValue: Int { activeItems.reduce(0) { $0 + $1.stockValue } }

    /// Web KPI "Potential Profit" — row potential_profit, falling back (JS `||`)
    /// to selling_price × available − stock_value when the row value is 0/absent.
    var potentialProfit: Int {
        activeItems.reduce(0) { sum, i in
            let fallback = (i.sellingPrice ?? 0) * max(i.available, 0) - i.stockValue
            return sum + (i.potentialProfit != 0 ? i.potentialProfit : fallback)
        }
    }

    /// Web category select options — distinct categories, sorted.
    var categories: [String] {
        Array(Set(items.compactMap { $0.category }.filter { !$0.isEmpty })).sorted()
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct InventoryScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = InventoryVM()
    @State private var selected: InventoryStockItem? = nil
    @State private var showAdd = false
    @State private var searchDebounce: Task<Void, Never>? = nil

    /// Escape hatch into the web screen (photo upload, collection/bulk add, login).
    let openWeb: (_ path: String, _ title: String) -> Void

    /// Web mobile view renders at most the first 120 matches — same cap here so a
    /// 3000-SKU catalog can't flood the LazyVStack; search narrows to the rest.
    private static let mobileCap = 120

    var body: some View {
        let rows = vm.filtered
        let visible = Array(rows.prefix(Self.mobileCap))
        return ScrollView {
            LazyVStack(spacing: 10) {
                kpiStrip
                viewChips
                HStack(spacing: 8) {
                    searchRow
                    categoryMenu
                }
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                if let ok = vm.notice { noticeCard(ok) }
                if vm.loading && vm.items.isEmpty { loadingRows }
                ForEach(visible) { item in
                    InventoryItemCard(item: item, vm: vm) {
                        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                        selected = item
                    }
                }
                if !vm.loading && rows.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                if !vm.loading && rows.count > visible.count {
                    Text("Showing first \(visible.count.formatted()) matches. Use filters/search for the rest.")
                        .font(.caption2).foregroundStyle(.secondary)
                        .padding(.vertical, 4)
                }
                webEscape
                Color.clear.frame(height: 64)   // keep the FAB off the last card's buttons
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(InventoryAurora())
        .claudeTopFade()
        .overlay(alignment: .bottomTrailing) { addFab }
        .refreshable { await vm.load() }
        .scrollDismissesKeyboard(.immediately)
        .task { await vm.load() }
        .sheet(item: $selected) { item in
            InventoryDetailSheet(item: item, vm: vm, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showAdd) {
            InventoryAddSheet(vm: vm, openWeb: openWeb)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Add-item FAB (web's fixed "+ Add item" button) ──

    private var addFab: some View {
        Button {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            showAdd = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "plus")
                Text("Add item")
            }
            .font(.subheadline.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(InventoryPalette.coral, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.25), lineWidth: 1))
            .shadow(color: InventoryPalette.coral.opacity(0.45), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .padding(.trailing, 16)
        .padding(.bottom, 14)
    }

    // ── KPI strip (web KpiCards: Total SKUs · Stock Value · Potential Profit · Low Stock) ──

    private var kpiStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("TOTAL SKUS", "\(vm.totalSkus)", .primary)
                kpiCard("STOCK VALUE", AlmaSwiftTheme.takaShort(vm.stockValue),
                        InventoryPalette.accentText(colorScheme))
                kpiCard("POTENTIAL PROFIT", AlmaSwiftTheme.takaShort(vm.potentialProfit),
                        InventoryPalette.positive(colorScheme))
                kpiCard("LOW STOCK", "\(vm.lowStockCount)",
                        vm.lowStockCount > 0 ? InventoryPalette.amber600 : .primary)
                kpiCard("OUT OF STOCK", "\(vm.outOfStockCount)",
                        vm.outOfStockCount > 0 ? InventoryPalette.red500 : .primary)
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
        .padding(.top, 4)
    }

    private func kpiCard(_ label: String, _ value: String, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text(value).font(.headline.weight(.bold)).foregroundStyle(tint)
                .lineLimit(1).minimumScaleFactor(0.6)
        }
        .frame(minWidth: 84, alignment: .leading)
        .padding(12)
        .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── View chips (web: Active / Archived / Low stock / Out of stock) ──

    private var viewChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                inventoryChip("Active", active: vm.view == "active") { vm.view = "active" }
                inventoryChip("Low stock", active: vm.view == "low") { vm.view = "low" }
                inventoryChip("Out of stock", active: vm.view == "out") { vm.view = "out" }
                inventoryChip("Archived", active: vm.view == "archived") { vm.view = "archived" }
            }
            .padding(.horizontal, 2)
        }
    }

    private func inventoryChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? InventoryPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? InventoryPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? InventoryPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Search (debounced — client-side filter over the full stock list) ──

    private var searchRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search SKU, product name…", text: Binding(
                get: { vm.search },
                set: { newValue in
                    vm.search = newValue
                    searchDebounce?.cancel()
                    searchDebounce = Task { // client-side filter, debounced (1000s of rows)
                        try? await Task.sleep(nanoseconds: 300_000_000)
                        if !Task.isCancelled { vm.appliedSearch = newValue }
                    }
                }))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !vm.search.isEmpty {
                Button {
                    searchDebounce?.cancel()
                    vm.search = ""
                    vm.appliedSearch = ""
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    /// The web's category <Select>, as one native menu.
    private var categoryMenu: some View {
        Menu {
            Picker("Category", selection: Binding(get: { vm.category ?? "" }, set: { v in
                vm.category = v.isEmpty ? nil : v
            })) {
                Text("All categories").tag("")
                ForEach(vm.categories, id: \.self) { Text($0).tag($0) }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle" + (vm.category != nil ? ".fill" : ""))
                .font(.title3)
                .foregroundStyle(AlmaSwiftTheme.violet)
                .frame(width: 42, height: 42)
                .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    // ── Shared bits ──

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
                .multilineTextAlignment(.center)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(InventoryPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    /// Success line — the web's toast.success equivalent.
    private func noticeCard(_ message: String) -> some View {
        Label(message, systemImage: "checkmark.circle")
            .font(.footnote).foregroundStyle(InventoryPalette.positive(colorScheme))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var loadingRows: some View {
        ForEach(0..<5, id: \.self) { _ in
            Color.clear.frame(height: 112)
                .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .inventoryShimmer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "shippingbox").font(.largeTitle).foregroundStyle(.secondary)
            Text("No items found").foregroundStyle(.secondary)
            Text("Try another filter or add a product")
                .font(.caption).foregroundStyle(.secondary)
            Button("+ Add item") { showAdd = true }
                .buttonStyle(.borderedProminent)
                .tint(InventoryPalette.coral)
        }
        .padding(.top, 60)
        .padding(.bottom, 30)
    }

    /// Small escape into the web page (photo upload / collection add / anything else).
    private var webEscape: some View {
        Button {
            openWeb("/inventory", "Inventory")
        } label: {
            Label("ওয়েব ভার্সন", systemImage: "safari")
                .font(.caption)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 4)
    }
}

// MARK: - Action buttons (web Actions column / mobile card buttons — native writes)

/// The web row's Adjust / Price / Archive-or-Restore buttons. Owns its own sheet +
/// confirmation state so it can live inside a list card AND inside the detail sheet.
@available(iOS 17.0, *)
private struct InventoryActionButtons: View {
    let item: InventoryStockItem
    let vm: InventoryVM
    @Environment(\.colorScheme) private var colorScheme
    @State private var showAdjust = false
    @State private var showEdit = false
    @State private var confirmArchive = false
    @State private var confirmRestore = false

    private var busy: Bool { vm.busySkus.contains(item.sku) }

    var body: some View {
        HStack(spacing: 8) {
            pill("Adjust", tint: InventoryPalette.accentText(colorScheme)) { showAdjust = true }
            pill("Price", tint: .secondary) { showEdit = true }
            if item.archived == true {
                pill("Restore", tint: InventoryPalette.positive(colorScheme)) { confirmRestore = true }
            } else {
                pill("Archive", tint: InventoryPalette.red500) { confirmArchive = true }
            }
            if busy { ProgressView().controlSize(.small) }
            Spacer(minLength: 0)
        }
        .sheet(isPresented: $showAdjust) {
            InventoryAdjustSheet(item: item, vm: vm)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showEdit) {
            InventoryEditSheet(item: item, vm: vm)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        // Web sends reason:"manual archive" — confirm in Bangla with SKU + stock qty.
        .confirmationDialog("\(item.sku) আর্কাইভ করবেন?", isPresented: $confirmArchive,
                            titleVisibility: .visible) {
            Button("হ্যাঁ, আর্কাইভ করুন", role: .destructive) {
                Task { await vm.archive(sku: item.sku) }
            }
            Button("বাতিল", role: .cancel) {}
        } message: {
            Text("SKU \(item.sku) · স্টক \(item.currentStock) পিস — আর্কাইভ করলে Active তালিকা থেকে সরে যাবে (পরে Restore করা যাবে)।")
        }
        .confirmationDialog("\(item.sku) রিস্টোর করবেন?", isPresented: $confirmRestore,
                            titleVisibility: .visible) {
            Button("হ্যাঁ, রিস্টোর করুন") {
                Task { await vm.restore(sku: item.sku) }
            }
            Button("বাতিল", role: .cancel) {}
        } message: {
            Text("SKU \(item.sku) · স্টক \(item.currentStock) পিস — আবার Active তালিকায় ফিরবে।")
        }
    }

    private func pill(_ title: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(tint)
                .padding(.horizontal, 11).padding(.vertical, 6)
                .background(Color.white.opacity(colorScheme == .dark ? 0.07 : 0.4), in: Capsule())
                .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .opacity(busy ? 0.45 : 1)
    }
}

// MARK: - Adjust-stock sheet (web adjustStock prompt → native stepper + reason)

@available(iOS 17.0, *)
private struct InventoryAdjustSheet: View {
    let item: InventoryStockItem
    let vm: InventoryVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var qtyText: String
    @State private var reason = "manual correction"
    @State private var confirming = false
    @State private var saving = false
    @State private var errorText: String? = nil

    /// Same presets the web prompt suggests.
    private static let reasons = ["manual correction", "damaged", "lost", "supplier update", "return restock"]

    init(item: InventoryStockItem, vm: InventoryVM) {
        self.item = item
        self.vm = vm
        // Web parity: promptDialog defaults to the current *available* quantity.
        _qtyText = State(initialValue: String(item.available))
    }

    private var qty: Int? {
        let n = Int(qtyText.trimmingCharacters(in: .whitespaces))
        return (n ?? -1) >= 0 ? n : nil
    }
    private var delta: Int { (qty ?? item.available) - item.available }
    private var deltaLabel: String { delta >= 0 ? "+\(delta)" : "\(delta)" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("স্টক অ্যাডজাস্ট").font(.headline)
                    Text("\(item.sku) · \(item.product)")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }

                HStack(spacing: 14) {
                    metric("Available", "\(item.available)")
                    metric("Stock", "\(item.currentStock)")
                    metric("Reserved", "\(item.reserved)")
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("নতুন পরিমাণ").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        stepButton("minus") { setQty(max(0, (qty ?? item.available) - 1)) }
                        TextField("0", text: $qtyText)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.center)
                            .font(.title2.weight(.bold).monospacedDigit())
                            .padding(.vertical, 8)
                            .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                        stepButton("plus") { setQty((qty ?? item.available) + 1) }
                    }
                    if qty == nil {
                        Text("০ বা তার বেশি একটি সংখ্যা দিন")
                            .font(.caption2).foregroundStyle(InventoryPalette.red500)
                    } else if delta != 0 {
                        Text("পরিবর্তন: \(item.available) → \(qty ?? 0) (\(deltaLabel))")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(InventoryPalette.accentText(colorScheme))
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("কারণ").font(.caption.weight(.bold)).foregroundStyle(.secondary)
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(Self.reasons, id: \.self) { r in
                                reasonChip(r)
                            }
                        }
                    }
                    TextField("কারণ লিখুন…", text: $reason)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                }

                if let errorText {
                    Label(errorText, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(InventoryPalette.red500)
                }

                Button {
                    guard qty != nil else { return }
                    confirming = true
                } label: {
                    HStack {
                        if saving { ProgressView().controlSize(.small).tint(.white) }
                        Text(saving ? "সেভ হচ্ছে…" : "সেভ করুন")
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .tint(InventoryPalette.coral)
                .disabled(qty == nil || saving)
            }
            .padding(18)
        }
        .presentationBackground { InventoryAurora() }
        .confirmationDialog("স্টক পরিবর্তন নিশ্চিত করুন", isPresented: $confirming,
                            titleVisibility: .visible) {
            Button("হ্যাঁ, আপডেট করুন") { save() }
            Button("বাতিল", role: .cancel) {}
        } message: {
            Text("SKU \(item.sku): স্টক \(item.available) → \(qty ?? 0) (\(deltaLabel)) · কারণ: \(reason.isEmpty ? "manual correction" : reason)")
        }
    }

    private func save() {
        guard let q = qty, !saving else { return }
        saving = true
        errorText = nil
        Task {
            // Web parity: adjust carries the row's current buying price along.
            let err = await vm.adjustStock(sku: item.sku, newStock: q,
                                           buyingPrice: item.buyingPrice, reason: reason)
            saving = false
            if let err { errorText = err } else { dismiss() }
        }
    }

    private func setQty(_ n: Int) {
        UISelectionFeedbackGenerator().selectionChanged()
        qtyText = String(n)
    }

    private func stepButton(_ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.headline)
                .foregroundStyle(InventoryPalette.accentText(colorScheme))
                .frame(width: 48, height: 44)
                .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
        .buttonStyle(.plain)
    }

    private func reasonChip(_ r: String) -> some View {
        let active = reason == r
        return Button {
            UISelectionFeedbackGenerator().selectionChanged()
            reason = r
        } label: {
            Text(r)
                .font(.caption2.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? InventoryPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(active ? InventoryPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? InventoryPalette.coral.opacity(0.55) : Color.clear, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.system(size: 9, weight: .heavy)).textCase(.uppercase)
                .foregroundStyle(.secondary)
            Text(value).font(.footnote.weight(.bold).monospacedDigit())
        }
    }
}

// MARK: - Price / reorder-level sheet (web updateBuyingPrice + edit reorder_level)

@available(iOS 17.0, *)
private struct InventoryEditSheet: View {
    let item: InventoryStockItem
    let vm: InventoryVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var priceText: String
    @State private var reorderText: String
    @State private var confirming = false
    @State private var saving = false
    @State private var errorText: String? = nil

    init(item: InventoryStockItem, vm: InventoryVM) {
        self.item = item
        self.vm = vm
        _priceText = State(initialValue: String(item.buyingPrice ?? 0))
        _reorderText = State(initialValue: String(item.reorderLevel))
    }

    private var price: Int? {
        let n = Int(priceText.trimmingCharacters(in: .whitespaces))
        return (n ?? -1) >= 0 ? n : nil
    }
    private var reorder: Int? {
        let n = Int(reorderText.trimmingCharacters(in: .whitespaces))
        return (n ?? -1) >= 0 ? n : nil
    }
    private var priceChanged: Bool { price != nil && price != (item.buyingPrice ?? 0) }
    private var reorderChanged: Bool { reorder != nil && reorder != item.reorderLevel }
    private var valid: Bool { price != nil && reorder != nil && (priceChanged || reorderChanged) }

    private var changeSummary: String {
        var parts: [String] = []
        if priceChanged { parts.append("দাম ৳\(item.buyingPrice ?? 0) → ৳\(price ?? 0)") }
        if reorderChanged { parts.append("রিঅর্ডার লেভেল \(item.reorderLevel) → \(reorder ?? 0)") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("দাম / রিঅর্ডার লেভেল").font(.headline)
                    Text("\(item.sku) · \(item.product)")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }

                field("বায়িং প্রাইস (৳)", text: $priceText,
                      invalid: price == nil, hint: "বর্তমান: ৳\((item.buyingPrice ?? 0).formatted())")
                field("রিঅর্ডার লেভেল", text: $reorderText,
                      invalid: reorder == nil, hint: "বর্তমান: \(item.reorderLevel)")

                if let errorText {
                    Label(errorText, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(InventoryPalette.red500)
                }

                Button {
                    guard valid else { return }
                    confirming = true
                } label: {
                    HStack {
                        if saving { ProgressView().controlSize(.small).tint(.white) }
                        Text(saving ? "সেভ হচ্ছে…" : "সেভ করুন")
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .tint(InventoryPalette.coral)
                .disabled(!valid || saving)

                if !valid && price != nil && reorder != nil {
                    Text("কিছু পরিবর্তন করা হয়নি")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(18)
        }
        .presentationBackground { InventoryAurora() }
        .confirmationDialog("পরিবর্তন নিশ্চিত করুন", isPresented: $confirming,
                            titleVisibility: .visible) {
            Button("হ্যাঁ, সেভ করুন") { save() }
            Button("বাতিল", role: .cancel) {}
        } message: {
            Text("SKU \(item.sku): \(changeSummary)")
        }
    }

    private func save() {
        guard valid, !saving else { return }
        saving = true
        errorText = nil
        Task {
            let err = await vm.editItem(sku: item.sku,
                                        buyingPrice: priceChanged ? price : nil,
                                        reorderLevel: reorderChanged ? reorder : nil)
            saving = false
            if let err { errorText = err } else { dismiss() }
        }
    }

    private func field(_ label: String, text: Binding<String>, invalid: Bool, hint: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption.weight(.bold)).foregroundStyle(.secondary)
            TextField("0", text: text)
                .keyboardType(.numberPad)
                .font(.title3.weight(.bold).monospacedDigit())
                .padding(.horizontal, 12).padding(.vertical, 9)
                .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
            Text(invalid ? "০ বা তার বেশি একটি সংখ্যা দিন" : hint)
                .font(.caption2)
                .foregroundStyle(invalid ? InventoryPalette.red500 : .secondary)
        }
    }
}

// MARK: - Add-product sheet (web AddProductModal, single mode)

@available(iOS 17.0, *)
private struct InventoryAddSheet: View {
    let vm: InventoryVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    @State private var name = ""
    @State private var sku = ""
    @State private var category = ""
    @State private var priceText = "0"     // sell price → default_price
    @State private var cogsText = "0"      // buying price → default_cogs
    @State private var color = ""
    @State private var size = ""
    @State private var stockText = "0"     // initial_stock
    @State private var reorderText = "0"   // reorder_level
    @State private var notes = ""
    @State private var syncToStock = true
    @State private var confirming = false
    @State private var errorText: String? = nil

    private func nonNegInt(_ s: String) -> Int? {
        let n = Int(s.trimmingCharacters(in: .whitespaces))
        return (n ?? -1) >= 0 ? n : nil
    }
    private var price: Int? { nonNegInt(priceText) }
    private var cogs: Int? { nonNegInt(cogsText) }
    private var stock: Int? { nonNegInt(stockText) }
    private var reorder: Int? { nonNegInt(reorderText) }
    private var valid: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && price != nil && cogs != nil && stock != nil && reorder != nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("নতুন আইটেম যোগ করুন").font(.headline)
                    Text("সিঙ্গেল প্রোডাক্ট — কালেকশন/বাল্ক ও ছবি আপলোড ওয়েবে")
                        .font(.caption).foregroundStyle(.secondary)
                }

                textField("প্রোডাক্টের নাম *", text: $name, placeholder: "যেমন: Premium Panjabi")
                textField("SKU (খালি রাখলে অটো)", text: $sku, placeholder: "AUTO", mono: true)
                categoryField
                HStack(spacing: 10) {
                    numberField("সেল প্রাইস (৳)", text: $priceText, invalid: price == nil)
                    numberField("বায়িং প্রাইস (৳)", text: $cogsText, invalid: cogs == nil)
                }
                HStack(spacing: 10) {
                    textField("কালার", text: $color, placeholder: "—")
                    textField("সাইজ", text: $size, placeholder: "—")
                }
                HStack(spacing: 10) {
                    numberField("শুরুর স্টক", text: $stockText, invalid: stock == nil)
                    numberField("রিঅর্ডার লেভেল", text: $reorderText, invalid: reorder == nil)
                }
                textField("নোট", text: $notes, placeholder: "ঐচ্ছিক")

                Toggle(isOn: $syncToStock) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("ইনভেন্টরিতে স্টক রো যোগ করুন").font(.footnote.weight(.semibold))
                        Text("বন্ধ করলে শুধু ক্যাটালগে সেভ হবে").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .tint(InventoryPalette.coral)
                .padding(12)
                .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)

                if let errorText {
                    Label(errorText, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(InventoryPalette.red500)
                }

                Button {
                    guard valid else { return }
                    confirming = true
                } label: {
                    HStack {
                        if vm.creating { ProgressView().controlSize(.small).tint(.white) }
                        Text(vm.creating ? "সেভ হচ্ছে…" : "+ Add item")
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .tint(InventoryPalette.coral)
                .disabled(!valid || vm.creating)

                // Photo upload + collection/bulk mode stay on the proven web modal.
                Button {
                    dismiss()
                    openWeb("/inventory", "Inventory")
                } label: {
                    Label("ছবি / কালেকশন-বাল্ক মোড — ওয়েব ভার্সন", systemImage: "safari")
                        .font(.caption)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .padding(.vertical, 2)
            }
            .padding(18)
        }
        .scrollDismissesKeyboard(.immediately)
        .presentationBackground { InventoryAurora() }
        .confirmationDialog("নতুন আইটেম তৈরি করবেন?", isPresented: $confirming,
                            titleVisibility: .visible) {
            Button("হ্যাঁ, তৈরি করুন") { save() }
            Button("বাতিল", role: .cancel) {}
        } message: {
            Text("\(name.trimmingCharacters(in: .whitespaces))\(sku.trimmingCharacters(in: .whitespaces).isEmpty ? "" : " · SKU \(sku.trimmingCharacters(in: .whitespaces))") · শুরুর স্টক \(stock ?? 0) পিস · সেল ৳\(price ?? 0) · বায়িং ৳\(cogs ?? 0)")
        }
    }

    private func save() {
        guard valid, !vm.creating else { return }
        errorText = nil
        // Same payload the web AddProductModal (single mode) posts to /api/products.
        var body: [String: AnyEncodable] = [
            "name": AnyEncodable(name.trimmingCharacters(in: .whitespaces)),
            "default_price": AnyEncodable(price ?? 0),
            "default_cogs": AnyEncodable(cogs ?? 0),
            "initial_stock": AnyEncodable(stock ?? 0),
            "reorder_level": AnyEncodable(reorder ?? 0),
            "supplier": AnyEncodable("manual"),
            "sync_to_stock": AnyEncodable(syncToStock),
            "skip_duplicate_name_check": AnyEncodable(false),
        ]
        let trimmedSku = sku.trimmingCharacters(in: .whitespaces)
        if !trimmedSku.isEmpty { body["sku"] = AnyEncodable(trimmedSku) }
        let trimmedCat = category.trimmingCharacters(in: .whitespaces)
        if !trimmedCat.isEmpty { body["category"] = AnyEncodable(trimmedCat) }
        let trimmedColor = color.trimmingCharacters(in: .whitespaces)
        if !trimmedColor.isEmpty { body["color"] = AnyEncodable(trimmedColor) }
        let trimmedSize = size.trimmingCharacters(in: .whitespaces)
        if !trimmedSize.isEmpty { body["size"] = AnyEncodable(trimmedSize) }
        let trimmedNotes = notes.trimmingCharacters(in: .whitespaces)
        if !trimmedNotes.isEmpty { body["notes"] = AnyEncodable(trimmedNotes) }
        Task {
            let err = await vm.createProduct(body: body)
            if let err { errorText = err } else { dismiss() }
        }
    }

    /// Category — free text with a menu of existing categories (web's select + Other).
    private var categoryField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ক্যাটাগরি").font(.caption.weight(.bold)).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                TextField("যেমন: Panjabi", text: $category)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                Menu {
                    ForEach(vm.categories, id: \.self) { c in
                        Button(c) { category = c }
                    }
                } label: {
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.footnote)
                        .foregroundStyle(AlmaSwiftTheme.violet)
                        .frame(width: 38, height: 38)
                        .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                }
            }
        }
    }

    private func textField(_ label: String, text: Binding<String>, placeholder: String,
                           mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption.weight(.bold)).foregroundStyle(.secondary)
            TextField(placeholder, text: text)
                .font(mono ? .footnote.monospaced() : .footnote)
                .textInputAutocapitalization(mono ? .characters : .sentences)
                .autocorrectionDisabled(mono)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
        }
    }

    private func numberField(_ label: String, text: Binding<String>, invalid: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption.weight(.bold)).foregroundStyle(.secondary)
            TextField("0", text: text)
                .keyboardType(.numberPad)
                .font(.footnote.weight(.bold).monospacedDigit())
                .padding(.horizontal, 12).padding(.vertical, 9)
                .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
                .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                    .strokeBorder(invalid ? InventoryPalette.red500.opacity(0.6) : .clear, lineWidth: 1))
        }
    }
}

// MARK: - Row card (mirrors one web mobile card, action buttons included)

@available(iOS 17.0, *)
private struct InventoryItemCard: View {
    let item: InventoryStockItem
    let vm: InventoryVM
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.sku)
                        .font(.caption2.monospaced().weight(.bold))
                        .foregroundStyle(InventoryPalette.accentText(colorScheme))
                    Text(item.product)
                        .font(.subheadline.weight(.bold))
                        .lineLimit(2)
                    Text(metaLine)
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3) {
                    Text("৳\(item.stockValue.formatted())")
                        .font(.footnote.weight(.bold).monospacedDigit())
                        .foregroundStyle(InventoryPalette.accentText(colorScheme))
                    Text(item.statusLabel)
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(item.statusColor)
                        .padding(.horizontal, 7).padding(.vertical, 2.5)
                        .background(item.statusColor.opacity(0.10), in: Capsule())
                        .overlay(Capsule().strokeBorder(item.statusColor.opacity(0.25), lineWidth: 1))
                }
            }

            HStack(spacing: 0) {
                statCell("\(item.available)", "Available",
                         tint: item.available <= 0 ? InventoryPalette.red500
                             : item.available <= item.reorderLevel ? InventoryPalette.amber600
                             : .primary)
                statCell("\(item.currentStock)", "Stock")
                statCell("\(item.sold)", "Sold")
                statCell("\(item.returned)", "Returns")
            }

            HStack(spacing: 8) {
                Text("Utilisation \(item.utilisationPct)%")
                    .font(.caption2).foregroundStyle(.secondary)
                InventoryProgressBar(pct: item.utilisationPct)
            }

            // Web mobile card's Adjust / Archive buttons (+ Price for full parity).
            InventoryActionButtons(item: item, vm: vm)
        }
        .padding(14)
        .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture(perform: onTap)
    }

    private var metaLine: String {
        [item.collectionCode ?? item.category,
         item.collectionType ?? item.color,
         item.poolLabel]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    private func statCell(_ value: String, _ label: String, tint: Color = .primary) -> some View {
        VStack(spacing: 1) {
            Text(value).font(.footnote.weight(.bold).monospacedDigit()).foregroundStyle(tint)
            Text(label).font(.system(size: 9)).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

/// Thin gold utilisation bar — the web's <Progress color="bg-gold">.
@available(iOS 17.0, *)
private struct InventoryProgressBar: View {
    let pct: Int

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.08))
                Capsule()
                    .fill(InventoryPalette.coral)
                    .frame(width: geo.size.width * CGFloat(min(max(pct, 0), 100)) / 100)
            }
        }
        .frame(height: 5)
    }
}

// MARK: - Detail sheet (full data + the same native actions)

@available(iOS 17.0, *)
private struct InventoryDetailSheet: View {
    let item: InventoryStockItem
    let vm: InventoryVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    /// Live row — after a write the list reloads; show the fresh numbers, not the
    /// snapshot the sheet was opened with.
    private var live: InventoryStockItem {
        vm.items.first { $0.sku == item.sku } ?? item
    }

    var body: some View {
        let current = live
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header(current)
                stockCard(current)
                moneyCard(current)
                attributesCard(current)
                actionsCard(current)
            }
            .padding(18)
        }
        .presentationBackground { InventoryAurora() }
    }

    private func header(_ item: InventoryStockItem) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(item.sku)
                    .font(.caption.monospaced().weight(.bold))
                    .foregroundStyle(InventoryPalette.accentText(colorScheme))
                Spacer()
                Text(item.statusLabel)
                    .font(.caption2.weight(.heavy))
                    .foregroundStyle(item.statusColor)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(item.statusColor.opacity(0.10), in: Capsule())
                    .overlay(Capsule().strokeBorder(item.statusColor.opacity(0.25), lineWidth: 1))
            }
            Text(item.product).font(.headline)
            if let barcode = item.barcode, !barcode.isEmpty {
                Text(barcode).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
    }

    /// Quantities — the web table's Available/Stock/Sold/Returned plus the hidden
    /// reserve/damage columns, with the reorder-level warning inline.
    private func stockCard(_ item: InventoryStockItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Stock")
            grid([
                ("Available", "\(item.available)",
                 item.available <= 0 ? InventoryPalette.red500
                     : item.available <= item.reorderLevel ? InventoryPalette.amber600 : .primary),
                ("Current stock", "\(item.currentStock)", .primary),
                ("Reserved", "\(item.reserved)", .primary),
                ("Sold", "\(item.sold)", .primary),
                ("Returned", "\(item.returned)", .primary),
                ("Damaged", "\(item.damaged)", .primary),
                ("Opening", "\(item.opening)", .primary),
                ("Purchased", "\(item.purchased)", .primary),
                ("Reorder level", "\(item.reorderLevel)", .primary),
            ])
            if item.archived != true && item.available > 0 && item.available <= item.reorderLevel {
                warnStrip("Low stock — reorder level \(item.reorderLevel)", tint: InventoryPalette.amber500,
                          text: InventoryPalette.amber600)
            }
            if item.archived != true && item.available <= 0 {
                warnStrip("Out of stock", tint: InventoryPalette.red500, text: InventoryPalette.red500)
            }
            HStack(spacing: 8) {
                Text("Utilisation \(item.utilisationPct)%")
                    .font(.caption2).foregroundStyle(.secondary)
                InventoryProgressBar(pct: item.utilisationPct)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func moneyCard(_ item: InventoryStockItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Value")
            grid([
                ("Stock value", "৳\(item.stockValue.formatted())", InventoryPalette.accentText(colorScheme)),
                ("Sell value", "৳\(item.sellValue.formatted())", .primary),
                ("Potential profit", "৳\(item.potentialProfit.formatted())",
                 item.potentialProfit >= 0 ? InventoryPalette.positive(colorScheme) : InventoryPalette.red500),
                ("Buying price", item.buyingPrice.map { "৳\($0.formatted())" } ?? "—", .primary),
                ("Selling price", item.sellingPrice.map { "৳\($0.formatted())" } ?? "—", .primary),
            ])
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func attributesCard(_ item: InventoryStockItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Product")
            grid([
                ("Collection", item.collectionCode ?? "—", .primary),
                ("Type", item.collectionType ?? item.category ?? "—", .primary),
                ("Category", item.category ?? "—", .primary),
                ("Size / Variant", item.poolLabel ?? "—", .primary),
                ("Color", item.color ?? "—", .primary),
            ])
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    /// Native writes (Adjust / Price / Archive-Restore) + tiny web escape for the
    /// photo uploader, which stays web-only.
    private func actionsCard(_ item: InventoryStockItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionLabel("Actions")
            InventoryActionButtons(item: item, vm: vm)
            if let n = vm.notice {
                Label(n, systemImage: "checkmark.circle")
                    .font(.caption).foregroundStyle(InventoryPalette.positive(colorScheme))
            }
            if let e = vm.error {
                Label(e, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(InventoryPalette.red500)
            }
            Button {
                dismiss()
                let q = item.sku.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? item.sku
                openWeb("/inventory?q=\(q)", "Inventory")
            } label: {
                Label("ছবি আপলোড / ওয়েব ভার্সন", systemImage: "safari")
                    .font(.caption)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .inventoryGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private func sectionLabel(_ label: String) -> some View {
        Text(label)
            .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
    }

    private func grid(_ rows: [(String, String, Color)]) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading),
                            GridItem(.flexible(), alignment: .leading),
                            GridItem(.flexible(), alignment: .leading)],
                  alignment: .leading, spacing: 12) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.0).font(.system(size: 9, weight: .heavy)).textCase(.uppercase)
                        .foregroundStyle(.secondary)
                    Text(row.1).font(.footnote.weight(.semibold).monospacedDigit())
                        .foregroundStyle(row.2)
                        .lineLimit(1).minimumScaleFactor(0.7)
                }
            }
        }
    }

    private func warnStrip(_ message: String, tint: Color, text: Color) -> some View {
        Text(message)
            .font(.caption2.weight(.bold))
            .foregroundStyle(text)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                .strokeBorder(tint.opacity(0.30), lineWidth: 1))
    }
}

// MARK: - Aurora background + glass (Inventory-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct InventoryAurora: View {
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
                        .fill(b.color)
                        .frame(width: b.size, height: b.size)
                        .position(x: geo.size.width * b.x + (drift ? b.dx : -b.dx),
                                  y: geo.size.height * b.y + (drift ? b.dy : -b.dy))
                        .blur(radius: 70)
                }
            }
            .onAppear { updateDrift() }
            .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)
                .receive(on: DispatchQueue.main)) { _ in updateDrift() }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    /// Battery guard: drift only when the owner allows motion — Reduce Motion and
    /// Low Power Mode both freeze the aurora to a static wash (blobs at rest).
    private func updateDrift() {
        if reduceMotion || ProcessInfo.processInfo.isLowPowerModeEnabled {
            var tx = Transaction(); tx.disablesAnimations = true
            withTransaction(tx) { drift = false }
        } else if !drift {
            withAnimation(.easeInOut(duration: 26).repeatForever(autoreverses: true)) { drift = true }
        }
    }
}

@available(iOS 17.0, *)
private extension View {
    func inventoryGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct InventoryShimmer: ViewModifier {
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
    func inventoryShimmer() -> some View { modifier(InventoryShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Inventory — Light") {
    InventoryScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
