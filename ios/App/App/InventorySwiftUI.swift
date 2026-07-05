//
//  InventorySwiftUI.swift
//  ALMA ERP — the Inventory screen as native SwiftUI (browse/search/detail).
//
//  Mirrors the web /inventory page:
//    GET /api/stock → { items: StockItem[], summary: { total_skus, low_stock,
//                       out_of_stock, total_value } }   (flat — no {ok,data} wrapper)
//  The web page loads the FULL stock list once and filters client-side
//  (view chips Active/Archived/Low/Out · category select · text search over
//  sku/product/category/collection/barcode/pool label) — the native screen does the
//  same, with the search debounced because the list can run to thousands of rows.
//  Stock WRITES (adjust quantity, buying price, archive/restore, add item) stay on
//  the proven web page — inventory writes are risky — reachable via openWeb.
//  Carried lessons: lenient per-field decoding (GAS mixes numbers/strings), ONE
//  spinner state, never a global overlay.
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
    var authExpired = false

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
    @State private var searchDebounce: Task<Void, Never>? = nil

    /// Escape hatch into the proven web screen (writes, add item, login).
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
                if vm.loading && vm.items.isEmpty { loadingRows }
                ForEach(visible) { item in
                    InventoryItemCard(item: item) {
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
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(InventoryAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .scrollDismissesKeyboard(.immediately)
        .task { await vm.load() }
        .sheet(item: $selected) { item in
            InventoryDetailSheet(item: item, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
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
        .inventoryGlass(colorScheme, corner: 14)
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
        .inventoryGlass(colorScheme, corner: 14)
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
                .inventoryGlass(colorScheme, corner: 14)
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
        .inventoryGlass(colorScheme, corner: 16)
    }

    private func errorCard(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote).foregroundStyle(InventoryPalette.red500)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).inventoryGlass(colorScheme, corner: 12)
    }

    private var loadingRows: some View {
        ForEach(0..<5, id: \.self) { _ in
            Color.clear.frame(height: 112)
                .inventoryGlass(colorScheme, corner: 16)
                .inventoryShimmer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "shippingbox").font(.largeTitle).foregroundStyle(.secondary)
            Text("No items found").foregroundStyle(.secondary)
            Text("Try another filter or add a product")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 60)
        .padding(.bottom, 30)
    }

    private var webEscape: some View {
        Button {
            openWeb("/inventory", "Inventory")
        } label: {
            Label("সব অপশন (Add / Adjust সহ) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Row card (mirrors one web mobile card)

@available(iOS 17.0, *)
private struct InventoryItemCard: View {
    let item: InventoryStockItem
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
        }
        .padding(14)
        .inventoryGlass(colorScheme, corner: 16)
        .contentShape(RoundedRectangle(cornerRadius: 16))
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

// MARK: - Detail sheet (browse-only; writes stay on the web)

@available(iOS 17.0, *)
private struct InventoryDetailSheet: View {
    let item: InventoryStockItem
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                stockCard
                moneyCard
                attributesCard
                webActions
            }
            .padding(18)
        }
        .presentationBackground { InventoryAurora() }
    }

    private var header: some View {
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
    private var stockCard: some View {
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
        .inventoryGlass(colorScheme, corner: 14)
    }

    private var moneyCard: some View {
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
        .inventoryGlass(colorScheme, corner: 14)
    }

    private var attributesCard: some View {
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
        .inventoryGlass(colorScheme, corner: 14)
    }

    /// Stock writes are risky — Adjust / Price / Archive stay on the proven web page.
    /// /inventory?q=… deep link seeds the web search with this SKU (existing web hook).
    private var webActions: some View {
        VStack(spacing: 8) {
            Button {
                dismiss()
                let q = item.sku.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? item.sku
                openWeb("/inventory?q=\(q)", "Inventory")
            } label: {
                Label("Adjust / Price / Archive — ওয়েবে খুলুন", systemImage: "slider.horizontal.3")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .tint(InventoryPalette.coral)
            Text("স্টক পরিবর্তন ওয়েব পেজ থেকে করুন — ভুল এন্ট্রি এড়াতে।")
                .font(.caption2).foregroundStyle(.secondary)
        }
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
            .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8)
                .strokeBorder(tint.opacity(0.30), lineWidth: 1))
    }
}

// MARK: - Aurora background + glass (Inventory-owned copies — parallel-session rule:
// page files never import another page's helpers, so the shared look is duplicated
// from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct InventoryAurora: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            if scheme == .dark {
                LinearGradient(stops: [
                    .init(color: Color(red: 0.075, green: 0.063, blue: 0.196), location: 0.0),  // deep indigo
                    .init(color: Color(red: 0.216, green: 0.125, blue: 0.439), location: 0.32), // violet
                    .init(color: Color(red: 0.478, green: 0.176, blue: 0.494), location: 0.62), // purple-magenta
                    .init(color: Color(red: 0.706, green: 0.255, blue: 0.404), location: 1.0),  // pink
                ], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [AlmaSwiftTheme.violet.opacity(0.35), .clear],
                               center: .init(x: 0.15, y: 0.18), startRadius: 10, endRadius: 420)
                RadialGradient(colors: [Color(red: 0.93, green: 0.42, blue: 0.55).opacity(0.30), .clear],
                               center: .init(x: 0.9, y: 0.85), startRadius: 20, endRadius: 480)
            } else {
                AlmaSwiftTheme.rootBg(.light)
                LinearGradient(stops: [
                    .init(color: Color(red: 0.902, green: 0.882, blue: 0.973), location: 0.0),  // pale violet
                    .init(color: Color(red: 0.949, green: 0.941, blue: 0.972), location: 0.45), // cream
                    .init(color: Color(red: 0.988, green: 0.918, blue: 0.925), location: 1.0),  // pale pink
                ], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [AlmaSwiftTheme.violet.opacity(0.14), .clear],
                               center: .init(x: 0.12, y: 0.15), startRadius: 10, endRadius: 380)
                RadialGradient(colors: [AlmaSwiftTheme.coral.opacity(0.12), .clear],
                               center: .init(x: 0.9, y: 0.9), startRadius: 20, endRadius: 420)
            }
        }
        .ignoresSafeArea()
    }
}

@available(iOS 17.0, *)
private extension View {
    func inventoryGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
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
