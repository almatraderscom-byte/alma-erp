//
//  CatalogImagesSwiftUI.swift
//  ALMA ERP — the agent Product Images screen (/agent/catalog-images) as a native
//  SwiftUI screen. READ-ONLY: browse coverage + galleries; uploads/deletes stay on
//  the web escape hatch (the web screen owns staging/confirm/delete flows).
//
//  Mirrors the web CatalogImagesScreen — same endpoints, same labels, same blocks:
//    GET /api/assistant/catalog/products        → { ok, groups, totalGroups, withImages, missing }
//    GET /api/assistant/catalog/images/{code}   → { ok, images: [{id, url, storagePath, isPrimary}] }
//  Web-parity blocks: 3 coverage KPI cards (মোট প্রোডাক্ট / ছবি আছে / ছবি নেই) ·
//  search (কোড/নাম/ক্যাটাগরি/মেম্বার) · filter chips সব/ছবি নেই/ছবি আছে · Photos-style
//  product grid with count + family-set badges · detail sheet with the image gallery
//  (প্রধান badge) · footer escape hatch to the web screen for upload/delete.
//

import SwiftUI

// MARK: - Web palette (exact hexes from globals.css / tailwind tokens)

private enum CatalogImagePalette {
    static let coral = AlmaSwiftTheme.coral                                  // web --c-accent  #E07A5F
    static let goldLt = Color(red: 0.957, green: 0.635, blue: 0.549)         // #F4A28C
    static let goldDim = Color(red: 0.769, green: 0.353, blue: 0.235)        // #C45A3C
    static let red500 = Color(red: 0.937, green: 0.267, blue: 0.267)         // #EF4444
    static let amber600 = Color(red: 0.851, green: 0.467, blue: 0.024)       // #D97706
    static let amber500 = Color(red: 0.961, green: 0.620, blue: 0.043)       // #F59E0B
    static let emerald600 = Color(red: 0.020, green: 0.588, blue: 0.412)     // #059669
    static let green400 = Color(red: 0.290, green: 0.871, blue: 0.502)       // #4ADE80
    // Page-specific accents the web screen uses on badges/chips:
    static let blue = Color(red: 0.239, green: 0.545, blue: 0.992)           // #3D8BFD (filter/set badge)
    static let sage = Color(red: 0.506, green: 0.698, blue: 0.604)           // #81B29A (has-images badge)

    /// The web's accent-tinted text reads gold-dim on cream, gold-lt over dark aurora.
    static func accentText(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? goldLt : goldDim
    }
}

// MARK: - Models (same field names the web page types declare)

struct CatalogImageGroup: Decodable, Identifiable, Equatable {
    let code: String
    let name: String
    let category: String
    let kind: String                 // "collection" | "sku"
    let members: [String]
    let imageCount: Int
    let hasImages: Bool
    let primaryImageUrl: String?

    var id: String { code }
    var isCollection: Bool { kind == "collection" }

    private enum Keys: String, CodingKey {
        case code, name, category, kind, members, imageCount, hasImages, primaryImageUrl
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        code = (try? c.decode(String.self, forKey: .code)) ?? ""
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        category = (try? c.decodeIfPresent(String.self, forKey: .category)) ?? ""
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "sku"
        members = (try? c.decodeIfPresent([String].self, forKey: .members)) ?? []
        let count = Self.flexInt(c, .imageCount) ?? 0
        imageCount = count
        hasImages = (try? c.decodeIfPresent(Bool.self, forKey: .hasImages)) ?? (count > 0)
        primaryImageUrl = try? c.decodeIfPresent(String.self, forKey: .primaryImageUrl)
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }

    static func == (a: CatalogImageGroup, b: CatalogImageGroup) -> Bool {
        a.code == b.code && a.imageCount == b.imageCount && a.primaryImageUrl == b.primaryImageUrl
    }
}

/// GET /api/assistant/catalog/products — flat { ok, groups, … }; decode a possible
/// { ok, data: {…} } wrap too, like the other native screens do.
struct CatalogImagesCatalogResponse: Decodable {
    let groups: [CatalogImageGroup]
    let totalGroups: Int
    let withImages: Int
    let missing: Int

    private enum Keys: String, CodingKey { case ok, data, groups, totalGroups, withImages, missing }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        groups = (try? c.decode([CatalogImageGroup].self, forKey: .groups)) ?? []
        totalGroups = Self.flexInt(c, .totalGroups) ?? groups.count
        withImages = Self.flexInt(c, .withImages) ?? groups.filter { $0.hasImages }.count
        missing = Self.flexInt(c, .missing) ?? groups.filter { !$0.hasImages }.count
    }
    private static func flexInt(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decodeIfPresent(Int.self, forKey: k) { return i }
        if let d = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(d.rounded()) }
        if let s = try? c.decodeIfPresent(String.self, forKey: k) { return Int(s) }
        return nil
    }
}

/// One stored image of a product (web ProductImageEntry).
struct CatalogImageEntry: Decodable, Identifiable, Equatable {
    let id: String
    let url: String?
    let storagePath: String?
    let isPrimary: Bool

    private enum Keys: String, CodingKey { case id, url, storagePath, isPrimary }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        storagePath = try? c.decodeIfPresent(String.self, forKey: .storagePath)
        id = (try? c.decode(String.self, forKey: .id)) ?? storagePath ?? UUID().uuidString
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        isPrimary = (try? c.decodeIfPresent(Bool.self, forKey: .isPrimary)) ?? false
    }
}

struct CatalogImageListResponse: Decodable {
    let images: [CatalogImageEntry]
    private enum Keys: String, CodingKey { case ok, data, images }
    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: Keys.self)
        let c = (try? root.nestedContainer(keyedBy: Keys.self, forKey: .data)) ?? root
        images = (try? c.decode([CatalogImageEntry].self, forKey: .images)) ?? []
    }
}

// MARK: - Helpers

private enum CatalogImageFormat {
    /// Image URLs may be absolute (Supabase storage) or app-relative — resolve both.
    static func imageURL(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        return URL(string: raw, relativeTo: AlmaAPI.baseURL)
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class CatalogImagesVM {
    var groups: [CatalogImageGroup] = []
    var totalGroups = 0
    var withImages = 0
    var missing = 0
    var loading = false
    var error: String? = nil
    var authExpired = false
    var filter = "all"               // all | missing | with (web Filter type)
    var query = ""

    func load() async {
        loading = true
        error = nil
        defer { loading = false }
        do {
            let resp: CatalogImagesCatalogResponse = try await AlmaAPI.shared.get(
                "/api/assistant/catalog/products")
            groups = resp.groups
            totalGroups = resp.totalGroups
            withImages = resp.withImages
            missing = resp.missing
            authExpired = false
        } catch AlmaAPIError.notAuthenticated {
            authExpired = true
        } catch {
            if Self.isCancellation(error) { return }   // pull-to-refresh let go early
            self.error = "লোড করা গেল না"
        }
    }

    /// SwiftUI .refreshable cancels the task when the gesture ends — that's not an
    /// error the owner should ever see.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if case AlmaAPIError.transport(let t) = error, (t as? URLError)?.code == .cancelled { return true }
        return (error as? URLError)?.code == .cancelled
    }

    /// Same predicate as the web's `filtered` memo: filter chip + free-text query
    /// over code / name / category / members.
    var filtered: [CatalogImageGroup] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return groups.filter { g in
            if filter == "missing" && g.hasImages { return false }
            if filter == "with" && !g.hasImages { return false }
            if q.isEmpty { return true }
            return g.code.lowercased().contains(q)
                || g.name.lowercased().contains(q)
                || g.category.lowercased().contains(q)
                || g.members.contains { $0.lowercased().contains(q) }
        }
    }
}

// MARK: - Screen

@available(iOS 17.0, *)
struct CatalogImagesScreen: View {
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = CatalogImagesVM()
    @State private var selected: CatalogImageGroup? = nil
    let openWeb: (_ path: String, _ title: String) -> Void

    private let gridColumns = [GridItem(.adaptive(minimum: 108), spacing: 10)]

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if vm.authExpired { authCard }
                if let err = vm.error { errorCard(err) }
                kpiStrip
                searchField
                filterChips
                if vm.loading && vm.groups.isEmpty { loadingGrid } else { productGrid }
                if !vm.loading && vm.filtered.isEmpty && vm.error == nil && !vm.authExpired {
                    emptyState
                }
                webEscape
                Color.clear.frame(height: 8)
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)
        }
        .background(CatalogImagesAurora())
        .claudeTopFade()
        .refreshable { await vm.load() }
        .task { await vm.load() }
        .sheet(item: $selected) { group in
            CatalogImageDetailSheet(group: group, openWeb: openWeb)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
    }

    // ── Coverage KPI strip (web SummaryCards: মোট প্রোডাক্ট / ছবি আছে / ছবি নেই) ──

    private var kpiStrip: some View {
        HStack(spacing: 10) {
            kpiCard("মোট প্রোডাক্ট", vm.totalGroups, .primary)
            kpiCard("ছবি আছে", vm.withImages, CatalogImagePalette.sage)
            kpiCard("ছবি নেই", vm.missing, CatalogImagePalette.amber500)
        }
        .padding(.top, 4)
    }

    private func kpiCard(_ label: String, _ value: Int, _ tint: Color) -> some View {
        VStack(spacing: 3) {
            Text("\(value)").font(.headline.weight(.bold)).foregroundStyle(tint)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .catalogImagesGlass(colorScheme, corner: 14)
    }

    // ── Search + filter (web controls row) ──

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.footnote).foregroundStyle(.secondary)
            TextField("কোড / নাম / ক্যাটাগরি খুঁজুন…", text: $vm.query)
                .font(.subheadline)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !vm.query.isEmpty {
                Button {
                    vm.query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .catalogImagesGlass(colorScheme, corner: 12)
    }

    /// Web filter buttons সব / ছবি নেই / ছবি আছে as the app's capsule chips.
    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                catalogChip("সব", active: vm.filter == "all") { vm.filter = "all" }
                catalogChip("ছবি নেই", active: vm.filter == "missing") { vm.filter = "missing" }
                catalogChip("ছবি আছে", active: vm.filter == "with") { vm.filter = "with" }
            }
            .padding(.horizontal, 2)
        }
    }

    private func catalogChip(_ label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            UISelectionFeedbackGenerator().selectionChanged()
            action()
        } label: {
            Text(label)
                .font(.footnote.weight(active ? .semibold : .regular))
                .foregroundStyle(active ? CatalogImagePalette.accentText(colorScheme) : .secondary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(active ? CatalogImagePalette.coral.opacity(colorScheme == .dark ? 0.28 : 0.14)
                                   : Color.white.opacity(colorScheme == .dark ? 0.08 : 0.45),
                            in: Capsule())
                .overlay(Capsule().strokeBorder(
                    active ? CatalogImagePalette.coral.opacity(0.55)
                           : Color.white.opacity(colorScheme == .dark ? 0.10 : 0.4),
                    lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // ── Product grid (Photos-style) ──

    private var productGrid: some View {
        LazyVGrid(columns: gridColumns, spacing: 10) {
            ForEach(vm.filtered) { group in
                CatalogImageProductCard(group: group) {
                    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
                    selected = group
                }
            }
        }
    }

    private var loadingGrid: some View {
        LazyVGrid(columns: gridColumns, spacing: 10) {
            ForEach(0..<6, id: \.self) { _ in
                Color.clear
                    .aspectRatio(0.8, contentMode: .fit)
                    .catalogImagesGlass(colorScheme, corner: 14)
                    .catalogImagesShimmer()
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.largeTitle).foregroundStyle(.secondary)
            Text("কোনো প্রোডাক্ট মিলল না।").foregroundStyle(.secondary)
        }
        .padding(.top, 60)
        .padding(.bottom, 30)
    }

    private func errorCard(_ message: String) -> some View {
        HStack(spacing: 8) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(CatalogImagePalette.red500)
            Spacer()
            Button("আবার চেষ্টা করুন") {
                Task { await vm.load() }
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(CatalogImagePalette.accentText(colorScheme))
            .buttonStyle(.plain)
        }
        .padding(12)
        .catalogImagesGlass(colorScheme, corner: 12)
    }

    private var authCard: some View {
        VStack(spacing: 10) {
            Text("সেশন পাওয়া যায়নি — একবার ওয়েব ভিউতে লগইন করুন").font(.subheadline)
            Button("লগইন খুলুন") { openWeb("/login", "Login") }.buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity).padding(20)
        .catalogImagesGlass(colorScheme, corner: 16)
    }

    /// Uploads, deletes and new-product creation stay on the web screen.
    private var webEscape: some View {
        Button {
            openWeb("/agent/catalog-images", "Product Images")
        } label: {
            Label("ছবি আপলোড / ডিলিট — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.vertical, 6)
    }
}

// MARK: - Product card (one grid tile — web ProductCard parity)

@available(iOS 17.0, *)
private struct CatalogImageProductCard: View {
    let group: CatalogImageGroup
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 0) {
                CatalogImageSquare(url: CatalogImageFormat.imageURL(group.primaryImageUrl))
                    .overlay(alignment: .topTrailing) { countBadge.padding(5) }
                    .overlay(alignment: .topLeading) {
                        if group.isCollection { setBadge.padding(5) }
                    }
                    .clipShape(UnevenRoundedRectangle(topLeadingRadius: 14, topTrailingRadius: 14))
                VStack(alignment: .leading, spacing: 1) {
                    Text(group.code)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                    Text(group.name.isEmpty ? (group.category.isEmpty ? "—" : group.category) : group.name)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
            }
            .catalogImagesGlass(colorScheme, corner: 14)
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
    }

    /// Web count badge: green "N ছবি" when covered, amber "ছবি নেই" when missing.
    private var countBadge: some View {
        Text(group.hasImages ? "\(group.imageCount) ছবি" : "ছবি নেই")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 7).padding(.vertical, 2.5)
            .background((group.hasImages ? CatalogImagePalette.sage : CatalogImagePalette.amber500)
                .opacity(0.92), in: Capsule())
    }

    /// Web family-set badge: blue "সেট ×N".
    private var setBadge: some View {
        Text("সেট ×\(group.members.count)")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 7).padding(.vertical, 2.5)
            .background(CatalogImagePalette.blue.opacity(0.92), in: Capsule())
    }
}

/// Square AsyncImage tile with the web's 🖼️ placeholder.
@available(iOS 17.0, *)
private struct CatalogImageSquare: View {
    let url: URL?

    var body: some View {
        Color.black.opacity(0.12)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let url {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        case .failure:
                            placeholder
                        default:
                            ProgressView().controlSize(.small)
                        }
                    }
                } else {
                    placeholder
                }
            }
            .clipped()
    }

    private var placeholder: some View {
        Text("🖼️").font(.title2).opacity(0.4)
    }
}

// MARK: - Detail sheet (web ProductDetail modal, read-only gallery)

@available(iOS 17.0, *)
private struct CatalogImageDetailSheet: View {
    let group: CatalogImageGroup
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var images: [CatalogImageEntry] = []
    @State private var loading = true
    @State private var failed = false

    private let galleryColumns = [GridItem(.adaptive(minimum: 96), spacing: 8)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                if group.isCollection { familyNote }
                gallery
                webLink
            }
            .padding(18)
        }
        .presentationBackground { CatalogImagesAurora() }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        failed = false
        defer { loading = false }
        do {
            let resp: CatalogImageListResponse = try await AlmaAPI.shared.get(
                "/api/assistant/catalog/images/\(group.code.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? group.code)")
            images = resp.images
        } catch {
            if CatalogImagesVM.isCancellation(error) { return }
            failed = true
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(group.code).font(.headline)
                if group.isCollection {
                    Text("ফ্যামিলি সেট ×\(group.members.count)")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(CatalogImagePalette.blue)
                        .padding(.horizontal, 8).padding(.vertical, 2.5)
                        .background(CatalogImagePalette.blue.opacity(0.14), in: Capsule())
                }
                Spacer()
                Text(group.hasImages ? "\(group.imageCount) ছবি" : "ছবি নেই")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(group.hasImages ? CatalogImagePalette.sage : CatalogImagePalette.amber600)
            }
            Text(group.name.isEmpty ? (group.category.isEmpty ? "—" : group.category) : group.name)
                .font(.caption).foregroundStyle(.secondary)
            if group.isCollection {
                Text("মেম্বার: \(group.members.joined(separator: ", "))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    /// Web collection note — images uploaded here land on every member of the set.
    private var familyNote: some View {
        Text("এটি ফ্যামিলি ম্যাচিং সেট — এখানে আপলোড করা ছবি সেটের সব \(group.members.count)টি মেম্বারে যোগ হবে।")
            .font(.caption2)
            .foregroundStyle(CatalogImagePalette.blue)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(CatalogImagePalette.blue.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10)
                .strokeBorder(CatalogImagePalette.blue.opacity(0.20), lineWidth: 1))
    }

    @ViewBuilder private var gallery: some View {
        if loading && images.isEmpty {
            LazyVGrid(columns: galleryColumns, spacing: 8) {
                ForEach(0..<6, id: \.self) { _ in
                    Color.clear
                        .aspectRatio(1, contentMode: .fit)
                        .catalogImagesGlass(colorScheme, corner: 10)
                        .catalogImagesShimmer()
                }
            }
        } else if failed {
            Text("লোড করা গেল না")
                .font(.footnote).foregroundStyle(CatalogImagePalette.red500)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 30)
        } else if images.isEmpty {
            Text("এখনো কোনো ছবি নেই।")
                .font(.footnote).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 30)
        } else {
            LazyVGrid(columns: galleryColumns, spacing: 8) {
                ForEach(images) { img in
                    CatalogImageSquare(url: CatalogImageFormat.imageURL(img.url))
                        .overlay(alignment: .topLeading) {
                            if img.isPrimary {
                                Text("প্রধান")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(CatalogImagePalette.coral.opacity(0.92), in: Capsule())
                                    .padding(4)
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
        }
    }

    /// Upload/delete for this product happens on the web screen.
    private var webLink: some View {
        Button {
            dismiss()
            openWeb("/agent/catalog-images", "Product Images")
        } label: {
            Label("ছবি যোগ/মুছতে — ওয়েবে খুলুন", systemImage: "safari")
                .font(.footnote)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .padding(.top, 2)
    }
}

// MARK: - Aurora background + glass (CatalogImages-owned copies — parallel-session
// rule: page files never import another page's helpers, so the shared look is
// duplicated from the Orders/Assistant spec verbatim)

@available(iOS 17.0, *)
private struct CatalogImagesAurora: View {
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
    func catalogImagesGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.10 : 0.45), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct CatalogImagesShimmer: ViewModifier {
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
    func catalogImagesShimmer() -> some View { modifier(CatalogImagesShimmer()) }
}

// MARK: - Preview (stubbed — live data needs the app session)

@available(iOS 17.0, *)
#Preview("Product Images — Light") {
    CatalogImagesScreen(openWeb: { _, _ in }).preferredColorScheme(.light)
}
