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
        .sheet(item: $selected) { batch in
            SupplierImportBatchSheet(batch: batch, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── KPI strip (web step-4 header: "Catalog loaded: N products · …") ──

    private var kpiStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                kpiCard("PRODUCTS", vm.total, SupplierImportPalette.goldLt)
                kpiCard("CATEGORIES", vm.categoryCount, .primary)
                kpiCard("NEW · ৭ দিন", vm.newInSevenDays, SupplierImportPalette.emerald600)
                kpiCard("ACTIVE", vm.products.filter { $0.active != false }.count,
                        SupplierImportPalette.green400)
            }
            .padding(.horizontal, 2)
            .padding(.vertical, 1)
        }
    }

    private func kpiCard(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            Text("\(value)").font(.headline.weight(.bold)).foregroundStyle(tint)
        }
        .frame(minWidth: 84, alignment: .leading)
        .padding(12)
        .supplierImportGlass(colorScheme, corner: 14)
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
        .supplierImportGlass(colorScheme, corner: 12)
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
        .supplierImportGlass(colorScheme, corner: 16)
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
            .padding(12).supplierImportGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .supplierImportGlass(colorScheme, corner: 16)
    }

    private var loadingRows: some View {
        ForEach(0..<4, id: \.self) { _ in
            Color.clear.frame(height: 96)
                .supplierImportGlass(colorScheme, corner: 16)
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

    private var webEscape: some View {
        Button {
            openWeb("/inventory/supplier-import", "Supplier import")
        } label: {
            Label("সব অপশন (ইমপোর্ট সহ) — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
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
        .supplierImportGlass(colorScheme, corner: 16)
        .contentShape(RoundedRectangle(cornerRadius: 16))
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
        .supplierImportGlass(colorScheme, corner: 12)
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
    func supplierImportGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
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

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Supplier import — Light") {
    SupplierImportScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
