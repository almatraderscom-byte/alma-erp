//
//  SupplierImportSwiftUI.swift
//  ALMA ERP — the Supplier-import page as a native SwiftUI screen (READ-ONLY).
//
//  Mirrors the readable half of the web /inventory/supplier-import page:
//    GET /api/products → PRODUCT MASTER catalog ({ products, total })
//  The web page's write path (paste scraped JSON → preview → POST
//  /api/supplier-import/commit) needs a file/clipboard workflow that is
//  web-only by design — the native screen shows the catalog state that the
//  importer appends into (grouped by update-day as "import batches", with
//  status pills + a batch detail sheet) and hands off to the web page for
//  the actual import. Carried lessons: lenient decoding, ONE shimmer set,
//  cancellation-safe pull-to-refresh, Bangla auth/empty states.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum SupplierImportPalette {
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
}

// MARK: - Models (same field names the web ProductsResponse declares)

struct SupplierImportProduct: Decodable, Identifiable, Equatable {
    let id: String
    let sku: String?
    let name: String
    let category: String?
    let defaultPrice: Int?
    let defaultCogs: Int?
    let active: Bool?
    let notes: String?
    let updatedAt: String?

    private enum Keys: String, CodingKey {
        case id, sku, name, category, active, notes
        case defaultPrice = "default_price"
        case defaultCogs = "default_cogs"
        case updatedAt = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? UUID().uuidString
        sku = try? c.decodeIfPresent(String.self, forKey: .sku)
        name = (try? c.decode(String.self, forKey: .name)) ?? "—"
        category = try? c.decodeIfPresent(String.self, forKey: .category)
        defaultPrice = Self.flexInt(c, .defaultPrice)
        defaultCogs = Self.flexInt(c, .defaultCogs)   // server redacts for non-owner roles
        active = try? c.decodeIfPresent(Bool.self, forKey: .active)
        notes = try? c.decodeIfPresent(String.self, forKey: .notes)
        updatedAt = try? c.decodeIfPresent(String.self, forKey: .updatedAt)
    }

    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }

    static func == (a: SupplierImportProduct, b: SupplierImportProduct) -> Bool { a.id == b.id }
}

/// `/api/products` returns the payload flat (`{ products, total }`); decode a
/// `{ ok, data: {…} }` wrapper too, in case the route ever adopts apiDataSuccess.
struct SupplierImportCatalogResponse: Decodable {
    let products: [SupplierImportProduct]
    let total: Int?

    private enum Keys: String, CodingKey { case ok, data, products, total }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        products = (try? c.decode([SupplierImportProduct].self, forKey: .products)) ?? []
        if let i = try? c.decodeIfPresent(Int.self, forKey: .total) { total = i } else { total = nil }
    }
}

/// One "import batch" — the catalog grouped by the day rows last changed
/// (imports append in bulk, so each import shows up as one day-group).
struct SupplierImportBatch: Identifiable, Equatable {
    let id: String                     // "yyyy-MM-dd" day key (Asia/Dhaka) or "unknown"
    let label: String                  // display date
    let products: [SupplierImportProduct]
    let isRecent: Bool                 // within the last 7 days

    static func == (a: SupplierImportBatch, b: SupplierImportBatch) -> Bool {
        a.id == b.id && a.products.count == b.products.count
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class SupplierImportVM {
    var products: [SupplierImportProduct] = []
    var total = 0
    var search = ""
    var categoryFilter: String? = nil     // nil = All
    var loading = false
    var error: String? = nil
    var authExpired = false

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: SupplierImportCatalogResponse = try await AlmaAPI.shared.get("/api/products")
            products = resp.products
            total = resp.total ?? resp.products.count
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = "তালিকা লোড করা যায়নি।"
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    // ── Derived state ──

    var filtered: [SupplierImportProduct] {
        var list = products
        if let cat = categoryFilter {
            list = list.filter { ($0.category ?? "") == cat }
        }
        let q = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return list }
        return list.filter {
            $0.name.lowercased().contains(q)
                || ($0.sku ?? "").lowercased().contains(q)
                || ($0.category ?? "").lowercased().contains(q)
        }
    }

    /// Top categories by product count (chip row), capped so the row stays sane.
    var topCategories: [(name: String, count: Int)] {
        var counts: [String: Int] = [:]
        for p in products {
            let c = (p.category ?? "").trimmingCharacters(in: .whitespaces)
            guard !c.isEmpty else { continue }
            counts[c, default: 0] += 1
        }
        return counts
            .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
            .prefix(8)
            .map { (name: $0.key, count: $0.value) }
    }

    var categoryCount: Int {
        Set(products.compactMap { p -> String? in
            let c = (p.category ?? "").trimmingCharacters(in: .whitespaces)
            return c.isEmpty ? nil : c
        }).count
    }

    var newInSevenDays: Int {
        products.filter { SupplierImportFormat.isWithinDays($0.updatedAt, days: 7) }.count
    }

    /// Day-groups, newest first; undated rows sink to a trailing "unknown" batch.
    var batches: [SupplierImportBatch] {
        var groups: [String: [SupplierImportProduct]] = [:]
        for p in filtered {
            groups[SupplierImportFormat.dayKey(p.updatedAt) ?? "unknown", default: []].append(p)
        }
        let keys = groups.keys.sorted { a, b in
            if a == "unknown" { return false }
            if b == "unknown" { return true }
            return a > b
        }
        return keys.prefix(14).map { key in
            let rows = (groups[key] ?? []).sorted { $0.name < $1.name }
            return SupplierImportBatch(
                id: key,
                label: key == "unknown" ? "তারিখ নেই" : (SupplierImportFormat.dayLabel(key) ?? key),
                products: rows,
                isRecent: key != "unknown" && SupplierImportFormat.isWithinDays(rows.first?.updatedAt, days: 7))
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct SupplierImportScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = SupplierImportVM()
    @State private var selected: SupplierImportBatch? = nil
    @State private var showImportSheet = false
    let openWeb: (_ path: String, _ title: String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { noticeCard(err, tone: .error) }
                kpiStrip
                searchField
                categoryChips
                if vm.loading && vm.products.isEmpty { loadingRows }
                batchList
                if !vm.loading && vm.products.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                importGuide
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(SupplierImportAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(isPresented: $showImportSheet) {
            SupplierImportRunSheet(
                catalogSkus: Set(vm.products.compactMap { $0.sku?.lowercased() }),
                catalogNames: Set(vm.products.map { $0.name.lowercased() }),
                onDone: { showImportSheet = false },
                onCommitted: { Task { await vm.load() } })
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $selected) { batch in
            SupplierImportBatchSheet(batch: batch, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── KPI strip (web step-4 header: "Catalog loaded: N products · …") — bento
    //    dark hero (owner spec 2026-07-08): same four counts, presentation only. ──

    private var kpiStrip: some View {
        SupBentoHeroCard(products: vm.total,
                         categories: vm.categoryCount,
                         newInWeek: vm.newInSevenDays,
                         active: vm.products.filter { $0.active != false }.count)
    }

    // ── Search (web "Filter preview…" SearchInput) ──

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
            TextField("পণ্য খুঁজুন (নাম / SKU / ক্যাটাগরি)", text: $vm.search)
                .font(.footnote)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !vm.search.isEmpty {
                Button {
                    vm.search = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .supplierImportGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    // ── Category chips (top categories by count, "All" first) ──

    @ViewBuilder private var categoryChips: some View {
        if !vm.topCategories.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    supplierImportChip("All", active: vm.categoryFilter == nil) {
                        vm.categoryFilter = nil
                    }
                    ForEach(vm.topCategories, id: \.name) { cat in
                        supplierImportChip("\(cat.name) · \(cat.count)",
                                           active: vm.categoryFilter == cat.name) {
                            vm.categoryFilter = vm.categoryFilter == cat.name ? nil : cat.name
                        }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
    }

    // ── Batch list (day-grouped "import history" cards) ──

    @ViewBuilder private var batchList: some View {
        let batches = vm.batches
        if !batches.isEmpty {
            Text("PRODUCT MASTER — দিন-ভিত্তিক ব্যাচ")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
            ForEach(batches) { batch in
                SupplierImportBatchCard(batch: batch) { selected = batch }
            }
        } else if !vm.products.isEmpty && !vm.loading {
            Text("এই ফিল্টারে কিছু পাওয়া যায়নি")
                .font(.footnote).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
        }
    }

    // ── Import guide (the web page's 5 steps, read-only digest) ──

    private var importGuide: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ইমপোর্ট কীভাবে চলে")
                .font(.caption.weight(.bold)).foregroundStyle(.secondary).textCase(.uppercase)
            guideRow("1", "One-time scrape (CDP) — Chrome থেকে Smart China Hub স্ক্র্যাপ")
            guideRow("2", "Paste scraped JSON — tmp/supplier-products.json ওয়েব পেজে পেস্ট")
            guideRow("3", "Category mapping — সাপ্লায়ার ক্যাটাগরি → আপনার ক্যাটাগরি")
            guideRow("4", "Preview & duplicates — Ready / Dup SKU / Dup ID / Dup name / Invalid")
            guideRow("5", "Commit import — PRODUCT MASTER-এ append (পুরনো SKU কখনো overwrite হয় না)")
            Text("ফাইল/JSON পেস্ট করে ইমপোর্ট চালানো শুধু ওয়েবে হয় — নিচের বাটনে খুলুন।")
                .font(.caption2).foregroundStyle(SupplierImportPalette.amber600)
            Button {
                UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                openWeb("/inventory/supplier-import", "Supplier import")
            } label: {
                Label("ওয়েবে ইমপোর্ট চালান", systemImage: "square.and.arrow.down.on.square")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(SupplierImportPalette.accentText(colorScheme))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                    .background(SupplierImportPalette.coral.opacity(0.13), in: Capsule())
                    .overlay(Capsule().strokeBorder(SupplierImportPalette.coral.opacity(0.35), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .supplierImportGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private func guideRow(_ n: String, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(n)
                .font(.caption2.weight(.bold))
                .foregroundStyle(SupplierImportPalette.accentText(colorScheme))
                .frame(width: 18, height: 18)
                .background(SupplierImportPalette.coral.opacity(0.14), in: Circle())
            Text(text).font(.caption).foregroundStyle(.secondary)
        }
    }

    // ── Shared bits (pattern parity) ──

    private func supplierImportChip(_ label: String, active: Bool,
                                    action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .lineLimit(1).minimumScaleFactor(0.5)
                .foregroundStyle(active ? SupplierImportPalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? SupplierImportPalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? SupplierImportPalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private enum NoticeTone { case error, success, info }
    private func noticeCard(_ message: String, tone: NoticeTone) -> some View {
        let (icon, color): (String, Color) = switch tone {
        case .error: ("exclamationmark.triangle", SupplierImportPalette.red500)
        case .success: ("checkmark.circle", SupplierImportPalette.emerald600)
        case .info: ("info.circle", Color.secondary)
        }
        return Label(message, systemImage: icon)
            .font(.footnote).foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12).supplierImportGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .supplierImportGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 96)
                .supplierImportGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
                .supplierImportShimmer()
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "shippingbox").font(.largeTitle).foregroundStyle(.secondary)
            Text("কোনো পণ্য পাওয়া যায়নি").foregroundStyle(.secondary)
            Text("ইমপোর্ট চালালে PRODUCT MASTER-এর পণ্য এখানে দেখা যাবে।")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 60)
        .padding(.bottom, 20)
    }

    /// NP-5 (AD-02): the import itself runs NATIVELY (paste/file → validate →
    /// duplicate preview → selectable commit → result summary).
    private var webEscape: some View {
        Button {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            showImportSheet = true
        } label: {
            Label("📦 JSON ইমপোর্ট চালান", systemImage: "square.and.arrow.down")
                .font(.footnote.weight(.bold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(SupplierImportPalette.coral.opacity(0.12), in: Capsule())
                .foregroundStyle(SupplierImportPalette.coral)
                .overlay(Capsule().strokeBorder(SupplierImportPalette.coral.opacity(0.35), lineWidth: 1))
        }
        .buttonStyle(.plain)
        .padding(.vertical, 6)
    }
}

// MARK: - Batch card (one day-group of PRODUCT MASTER rows)

@available(iOS 17.0, *)
private struct SupplierImportBatchCard: View {
    let batch: SupplierImportBatch
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(batch.label).font(.subheadline.weight(.bold))
                Spacer()
                if batch.isRecent {
                    statusPill("সাম্প্রতিক", tint: SupplierImportPalette.emerald600)
                }
                statusPill("\(batch.products.count) পণ্য", tint: SupplierImportPalette.coral,
                           text: SupplierImportPalette.accentText(colorScheme))
            }
            Text(categoriesLine).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: 6) {
                if let range = priceRange {
                    Text(range)
                        .font(.footnote.monospacedDigit().weight(.semibold))
                        .foregroundStyle(SupplierImportPalette.accentText(colorScheme))
                }
                Spacer()
                HStack(spacing: 3) {
                    Text("বিস্তারিত")
                    Image(systemName: "chevron.right")
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .supplierImportGlass(colorScheme, corner: AlmaSwiftTheme.rCard)
        .contentShape(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rCard, style: .continuous))
        .onTapGesture {
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
            onTap()
        }
    }

    private var categoriesLine: String {
        var counts: [String: Int] = [:]
        for p in batch.products {
            let c = (p.category ?? "").trimmingCharacters(in: .whitespaces)
            counts[c.isEmpty ? "Uncategorized" : c, default: 0] += 1
        }
        let top = counts.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
        let shown = top.prefix(3).map { "\($0.key) (\($0.value))" }.joined(separator: " · ")
        return top.count > 3 ? "\(shown) +\(top.count - 3)" : shown
    }

    private var priceRange: String? {
        let prices = batch.products.compactMap(\.defaultPrice)
        guard let lo = prices.min(), let hi = prices.max() else { return nil }
        return lo == hi ? "৳\(lo.formatted())" : "৳\(lo.formatted()) – ৳\(hi.formatted())"
    }

    private func statusPill(_ label: String, tint: Color, text: Color? = nil) -> some View {
        Text(label)
            .font(.caption2.weight(.bold))
            .foregroundStyle(text ?? tint)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(tint.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.35), lineWidth: 1))
    }
}

// MARK: - Batch detail sheet (product rows: name · SKU · category · price · pill)

@available(iOS 17.0, *)
private struct SupplierImportBatchSheet: View {
    let batch: SupplierImportBatch
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(batch.label).font(.headline)
                    Text("\(batch.products.count) পণ্য · PRODUCT MASTER")
                        .font(.caption).foregroundStyle(.secondary)
                }
                VStack(spacing: 8) {
                    ForEach(batch.products) { p in
                        productRow(p)
                    }
                }
                webLink
            }
            .padding(18)
        }
        .presentationBackground { SupplierImportAurora() }
    }

    private func productRow(_ p: SupplierImportProduct) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(p.name).font(.footnote.weight(.semibold)).lineLimit(2)
                Spacer(minLength: 6)
                if let price = p.defaultPrice {
                    Text("৳\(price.formatted())")
                        .font(.footnote.monospacedDigit().weight(.bold))
                        .foregroundStyle(SupplierImportPalette.accentText(colorScheme))
                }
            }
            HStack(spacing: 6) {
                Text(p.sku ?? "— auto —")
                    .font(.caption2.monospaced())
                    .foregroundStyle(SupplierImportPalette.accentText(colorScheme))
                if let cat = p.category, !cat.isEmpty {
                    Text(cat).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Text(p.active == false ? "Inactive" : "Active")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(p.active == false ? SupplierImportPalette.red500
                                                       : SupplierImportPalette.green400)
                    .padding(.horizontal, 5).padding(.vertical, 1.5)
                    .background((p.active == false ? SupplierImportPalette.red500
                                                   : SupplierImportPalette.green400).opacity(0.12),
                                in: Capsule())
            }
            if let notes = p.notes, !notes.isEmpty {
                Text(notes).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .supplierImportGlass(colorScheme, corner: AlmaSwiftTheme.rControl)
    }

    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/inventory/supplier-import", "Supplier import")
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

// MARK: - Formatting helpers

private enum SupplierImportFormat {
    private static func parse(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = fractional.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        return plain.date(from: iso)
    }

    /// updated_at → "yyyy-MM-dd" in Asia/Dhaka (import batches are Dhaka business days).
    static func dayKey(_ iso: String?) -> String? {
        guard let iso, let date = parse(iso) else { return nil }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return f.string(from: date)
    }

    /// "2026-07-05" → "5 Jul 2026" style medium date.
    static func dayLabel(_ key: String) -> String? {
        let inF = DateFormatter()
        inF.dateFormat = "yyyy-MM-dd"
        inF.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        guard let date = inF.date(from: key) else { return nil }
        let outF = DateFormatter()
        outF.dateStyle = .medium
        outF.timeStyle = .none
        outF.timeZone = TimeZone(identifier: "Asia/Dhaka") ?? .current
        return outF.string(from: date)
    }

    static func isWithinDays(_ iso: String?, days: Int) -> Bool {
        guard let iso, let date = parse(iso) else { return false }
        return date > Date().addingTimeInterval(-Double(days) * 86_400)
    }
}

// MARK: - Aurora background + glass (SupplierImport-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct SupplierImportAurora: View {
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
    func supplierImportGlass(_ scheme: ColorScheme, corner: CGFloat = AlmaSwiftTheme.rCard) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct SupplierImportShimmer: ViewModifier {
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
    func supplierImportShimmer() -> some View { modifier(SupplierImportShimmer()) }
}

// MARK: - Bento components (SupplierImport-owned copies of the Dashboard board
// language — per-file copies are this repo's parallel-session convention)

/// Central motion gate — count-ups freeze under Reduce Motion / Low Power.
@available(iOS 17.0, *)
private func supMotionOK(_ reduceMotion: Bool) -> Bool {
    !reduceMotion && !ProcessInfo.processInfo.isLowPowerModeEnabled
}

/// Count-up number (0 → target on appear, old → new on refresh) — one Animatable
/// interpolation, no timers; snaps straight to the value when motion is limited.
@available(iOS 17.0, *)
private struct SupCountUp: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: Int
    @State private var appeared = false

    var body: some View {
        let shown = appeared ? Double(target) : 0
        SupCountUpText(value: shown)
            .animation(supMotionOK(reduceMotion) ? .spring(duration: 0.9, bounce: 0) : nil,
                       value: shown)
            .onAppear {
                guard !appeared else { return }
                if supMotionOK(reduceMotion) {
                    appeared = true
                } else {
                    var tx = Transaction(); tx.disablesAnimations = true
                    withTransaction(tx) { appeared = true }
                }
            }
    }
}

@available(iOS 17.0, *)
private struct SupCountUpText: View, Animatable {
    var value: Double
    var animatableData: Double {
        get { value }
        set { value = newValue }
    }
    var body: some View {
        Text("\(Int(value.rounded()))")
    }
}

/// The dark hero anchor — deliberately dark in BOTH schemes (Dashboard hero recipe:
/// deep indigo base + violet/coral washes + a sage hint). Catalog-size count-up plus
/// the Categories / New-this-week / Active split — the same four counts as before.
@available(iOS 17.0, *)
private struct SupBentoHeroCard: View {
    let products: Int
    let categories: Int
    let newInWeek: Int
    let active: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("ক্যাটালগ · PRODUCTS").font(.system(size: 10, weight: .bold)).tracking(0.8)
                .foregroundStyle(SupplierImportPalette.goldLt)
            SupCountUp(target: products)
                .font(.system(size: 40, weight: .heavy)).monospacedDigit()
                .foregroundStyle(.white)
                .lineLimit(1).minimumScaleFactor(0.6)
                .padding(.top, 8)
            Text("সাপ্লায়ার ক্যাটালগে লোড করা")
                .font(.caption2).foregroundStyle(.white.opacity(0.6)).padding(.top, 5)

            HStack(alignment: .top, spacing: 0) {
                heroStat(label: "Categories", value: categories, tint: .white, sub: "ক্যাটাগরি")
                heroDivider
                heroStat(label: "New · ৭ দিন", value: newInWeek,
                         tint: SupplierImportPalette.green400, sub: "নতুন")
                heroDivider
                heroStat(label: "Active", value: active,
                         tint: SupplierImportPalette.green400, sub: "চালু")
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

    private var heroDivider: some View {
        Rectangle().fill(.white.opacity(0.14)).frame(width: 1)
            .padding(.vertical, 2).padding(.horizontal, 12)
    }

    private func heroStat(label: String, value: Int, tint: Color, sub: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.5)
                .foregroundStyle(.white.opacity(0.55))
            SupCountUp(target: value)
                .font(.system(size: 18, weight: .heavy)).monospacedDigit()
                .foregroundStyle(tint)
            Text(sub).font(.system(size: 9)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Supplier import — Light") {
    SupplierImportScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}

// MARK: - NP-5 (AD-02): native JSON import — paste/file → validate → preview → commit

@available(iOS 17.0, *)
private struct SupplierImportRunSheet: View {
    let catalogSkus: Set<String>
    let catalogNames: Set<String>
    let onDone: () -> Void
    let onCommitted: () -> Void

    private struct DraftRow: Identifiable {
        let id = UUID()
        let raw: [String: Any]
        let name: String
        let sku: String?
        let price: String
        let duplicate: String?    // duplicate_sku | duplicate_name | invalid | nil
        var selected: Bool
    }

    @State private var rawJson = ""
    @State private var rows: [DraftRow] = []
    @State private var parseError: String? = nil
    @State private var skipDuplicateNames = true
    @State private var committing = false
    @State private var result: (created: Int, skipped: Int, errors: [String])? = nil
    @State private var showFilePicker = false

    var body: some View {
        NavigationStack {
            Form {
                Section("JSON ইনপুট (array বা {items:[…]} — alma-supplier-import-v1)") {
                    TextEditor(text: $rawJson)
                        .font(.caption.monospaced())
                        .frame(minHeight: 110)
                        .autocorrectionDisabled()
                    HStack(spacing: 10) {
                        Button("📋 Paste") {
                            if let t = UIPasteboard.general.string { rawJson = t }
                        }
                        Button("📄 ফাইল") { showFilePicker = true }
                        Spacer()
                        Button("✅ Validate") { parse() }
                            .disabled(rawJson.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    .font(.caption.weight(.bold))
                    if let err = parseError {
                        Text(err).font(.caption2).foregroundStyle(.red)
                    }
                }
                if !rows.isEmpty {
                    Section("Preview — \(rows.count) rows · \(rows.filter(\.selected).count) selected · duplicates deselected") {
                        ForEach($rows) { $row in
                            Toggle(isOn: $row.selected) {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(row.name).font(.caption.weight(.semibold)).lineLimit(1)
                                    HStack(spacing: 6) {
                                        if let sku = row.sku {
                                            Text(sku).font(.system(size: 9).monospaced()).foregroundStyle(.secondary)
                                        }
                                        Text(row.price).font(.system(size: 9)).foregroundStyle(.secondary)
                                        if let dup = row.duplicate {
                                            Text(dup.replacingOccurrences(of: "_", with: " "))
                                                .font(.system(size: 8, weight: .bold))
                                                .foregroundStyle(.orange)
                                        }
                                    }
                                }
                            }
                            .disabled(row.duplicate == "invalid")
                        }
                    }
                    Section {
                        Toggle("সার্ভারে duplicate নামও স্কিপ করবে", isOn: $skipDuplicateNames)
                        Button(committing ? "⏳ Importing… (৩ মিনিট পর্যন্ত লাগতে পারে)" : "📦 Import \(rows.filter(\.selected).count) items") {
                            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
                            Task { await commit() }
                        }
                        .disabled(committing || rows.filter(\.selected).isEmpty)
                    }
                }
                if let r = result {
                    Section("ফলাফল") {
                        Text("✓ Created \(r.created) · Skipped \(r.skipped) · Errors \(r.errors.count)")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(r.errors.isEmpty ? .green : .orange)
                        ForEach(Array(r.errors.prefix(8).enumerated()), id: \.offset) { _, e in
                            Text(e).font(.caption2).foregroundStyle(.red)
                        }
                    }
                }
            }
            .navigationTitle("Supplier import")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("বন্ধ") { onDone() } }
            }
            .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.json, .plainText]) { res in
                if case .success(let url) = res {
                    let secured = url.startAccessingSecurityScopedResource()
                    defer { if secured { url.stopAccessingSecurityScopedResource() } }
                    if let t = try? String(contentsOf: url, encoding: .utf8) { rawJson = t }
                }
            }
        }
    }

    /// Web parseJsonFile + enrichDrafts essentials: array or {items}; duplicate
    /// detection by sku/name against the catalog AND within the file itself.
    private func parse() {
        parseError = nil
        result = nil
        rows = []
        guard let data = rawJson.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) else {
            parseError = "JSON পড়া যায়নি — ফরম্যাট চেক করুন।"
            return
        }
        let list: [[String: Any]]
        if let arr = json as? [[String: Any]] {
            list = arr
        } else if let obj = json as? [String: Any], let items = obj["items"] as? [[String: Any]] {
            list = items
        } else {
            parseError = "JSON must be an array of products or an object with an \"items\" array (e.g. alma-supplier-import-v1)"
            return
        }
        var seenSku = Set<String>()
        var seenName = Set<String>()
        rows = list.map { raw in
            let name = String(describing: raw["name"] ?? raw["product"] ?? "").trimmingCharacters(in: .whitespaces)
            let sku = (raw["sku"] as? String)?.trimmingCharacters(in: .whitespaces)
            let priceVal = raw["price"] ?? raw["default_price"] ?? ""
            var dup: String? = nil
            if name.isEmpty { dup = "invalid" }
            let ls = sku?.lowercased() ?? ""
            let ln = name.lowercased()
            if dup == nil, !ls.isEmpty, catalogSkus.contains(ls) || seenSku.contains(ls) { dup = "duplicate_sku" }
            if dup == nil, catalogNames.contains(ln) || seenName.contains(ln) { dup = "duplicate_name" }
            if !ls.isEmpty { seenSku.insert(ls) }
            if !ln.isEmpty { seenName.insert(ln) }
            return DraftRow(raw: raw, name: name.isEmpty ? "(নাম নেই)" : name, sku: sku,
                            price: "৳\(priceVal)", duplicate: dup, selected: dup == nil)
        }
        if rows.isEmpty { parseError = "কোনো row পাওয়া যায়নি।" }
    }

    /// POST /api/supplier-import/commit {items, skip_duplicate_names} — the web
    /// hook's exact payload; long timeout tolerated by the app's URLSession.
    private func commit() async {
        guard !committing else { return }
        committing = true
        defer { committing = false }
        let items = rows.filter { $0.selected && $0.duplicate != "invalid" }
            .map { SIJSON($0.raw) }
        struct Body: Encodable {
            let items: [SIJSON]
            let skip_duplicate_names: Bool
        }
        struct Resp: Decodable {
            let created: [String]
            let skipped: [Skip]
            let errors: [Err]
            struct Skip: Decodable { let sku: String?; let reason: String? }
            struct Err: Decodable { let sku: String?; let message: String? }
            private enum Keys: String, CodingKey { case ok, data, created, skipped, errors }
            init(from decoder: Decoder) throws {
                let root = try decoder.container(keyedBy: Keys.self)
                let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
                created = (try? c.decodeIfPresent([String].self, forKey: .created)) ?? []
                skipped = (try? c.decodeIfPresent([Skip].self, forKey: .skipped)) ?? []
                errors = (try? c.decodeIfPresent([Err].self, forKey: .errors)) ?? []
            }
        }
        do {
            let r: Resp = try await AlmaAPI.shared.send(
                "POST", "/api/supplier-import/commit",
                body: Body(items: items, skip_duplicate_names: skipDuplicateNames))
            result = (r.created.count, r.skipped.count,
                      r.errors.map { "\($0.sku ?? "?"): \($0.message ?? "error")" })
            UINotificationFeedbackGenerator().notificationOccurred(r.errors.isEmpty ? .success : .warning)
            onCommitted()
        } catch {
            result = (0, 0, ["Commit ব্যর্থ: \(error.localizedDescription)"])
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}


/// Minimal JSON-any → Encodable bridge (the import rows carry arbitrary supplier
/// fields; they must reach the server VERBATIM — no field allowlist here).
private enum SIJSON: Encodable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([SIJSON])
    case object([String: SIJSON])

    init(_ any: Any) {
        switch any {
        case let b as Bool: self = .bool(b)
        case let i as Int: self = .int(i)
        case let d as Double: self = .double(d)
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map(SIJSON.init))
        case let o as [String: Any]: self = .object(o.mapValues(SIJSON.init))
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) }
            else if n.doubleValue == n.doubleValue.rounded(), abs(n.doubleValue) < 1e15 { self = .int(n.intValue) }
            else { self = .double(n.doubleValue) }
        default: self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}
