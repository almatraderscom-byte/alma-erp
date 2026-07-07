//
//  CreativeStudioSwiftUI.swift
//  ALMA — native Creative Studio (redesign, owner-approved 2026-07-07)
//
//  Full-screen agent sub-page reached from the assistive-touch / floating chat head.
//  Image-forward "professional AI studio" layout on the SHARED native aura theme
//  (reuses AgentAuroraBackground + AgentPalette from AssistantSwiftUI — the exact same
//  aurora glow, coral #E07A5F accent and liquid glass as every other native page).
//
//  Registry note: `/agent/creative-studio` was KEEP_WEB; owner instruction 2026-07-07
//  lifts that and asks for this native version. Read-only web reference for API shapes:
//  src/agent/components/creative-studio/studio-api.ts (config/gallery/models/run) and
//  src/lib/creative-studio/constants.ts (modes/vibes/family presets).
//
//  Consumes the SAME JSON APIs the web page calls, via AlmaAPI (cookie bridge):
//    GET  /api/assistant/creative-studio/config          → CSStudioConfig
//    GET  /api/assistant/creative-studio/gallery?page=…   → CSGalleryResponse
//    GET  /api/assistant/brand-models                     → { models: [...] }
//    POST /api/assistant/upload         (multipart)       → { path }
//    POST /api/assistant/creative-studio/run              → { message, jobs, provider }
//
//  Verify (page session cannot build the app — pbxproj frozen):
//    xcrun swiftc -typecheck -sdk $(xcrun --sdk iphonesimulator --show-sdk-path) \
//      -target arm64-apple-ios17.0-simulator ios/App/App/CreativeStudioSwiftUI.swift \
//      ios/App/App/{AlmaAPI,ClaudeTopFade,AssistantSwiftUI,SpikeNativeShell}.swift …
//

import SwiftUI
import PhotosUI

// MARK: - Wire models (mirror studio-api.ts; all optional so shape drift never fails a decode)

struct CSStudioConfig: Decodable, Equatable {
    let fashnConfigured: Bool?
    let geminiConfigured: Bool?
    let veoConfigured: Bool?
    let organization: String?
}

struct CSGalleryItem: Decodable, Identifiable, Equatable {
    let id: String
    let type: String?
    let status: String?
    let summary: String?
    let createdAt: String?
    let mode: String?
    let provider: String?
    let familyPreset: String?
    let previewUrl: String?
    let thumbUrl: String?
    let brandedUrl: String?
    let storagePath: String?
    let modelCreator: String?

    var imageURL: URL? { CS.url(thumbUrl ?? previewUrl ?? brandedUrl) }
    var isVideo: Bool { type == "video_gen" || (storagePath?.hasSuffix(".mp4") ?? false) }
    var isExecuted: Bool { status == "executed" }
    var title: String { (summary?.isEmpty == false ? summary : nil) ?? CS.modeLabel(mode) }
    var modeLabel: String { CS.modeLabel(mode) }
}

struct CSGalleryResponse: Decodable { let items: [CSGalleryItem]; let hasMore: Bool?; let total: Int? }

struct CSModel: Decodable, Identifiable, Equatable {
    let id: String
    let name: String?
    let role: String?
    let isDefault: Bool?
    let imageUrl: String?
    var imageURL: URL? { CS.url(imageUrl) }
}
struct CSModelsResponse: Decodable { let models: [CSModel] }

private struct CSUploadResponse: Decodable { let path: String?; let storagePath: String?; let url: String? }
private struct CSRunResponse: Decodable { let message: String?; let provider: String? }

/// Manual run payload — encodes only the keys that are set (matches the web's undefined-omit).
private struct CSRunPayload: Encodable {
    var mode: String
    var provider: String?
    var productImagePath: String?
    var familyPreset: String?
    var backgroundPrompt: String?
    var aspectRatio: String?
    var resolution: String?
    var generationMode: String?
    var vibe: String?
    var numImages: Int?

    enum CodingKeys: String, CodingKey {
        case mode, provider, productImagePath, familyPreset, backgroundPrompt
        case aspectRatio, resolution, generationMode, vibe, numImages
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(mode, forKey: .mode)
        try c.encodeIfPresent(provider, forKey: .provider)
        try c.encodeIfPresent(productImagePath, forKey: .productImagePath)
        try c.encodeIfPresent(familyPreset, forKey: .familyPreset)
        try c.encodeIfPresent(backgroundPrompt, forKey: .backgroundPrompt)
        try c.encodeIfPresent(aspectRatio, forKey: .aspectRatio)
        try c.encodeIfPresent(resolution, forKey: .resolution)
        try c.encodeIfPresent(generationMode, forKey: .generationMode)
        try c.encodeIfPresent(vibe, forKey: .vibe)
        try c.encodeIfPresent(numImages, forKey: .numImages)
    }
}

// MARK: - Static content (mirrors constants.ts)

enum CS {
    static func url(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        return URL(string: raw, relativeTo: AlmaAPI.baseURL)
    }

    struct Mode: Identifiable, Equatable {
        let id: String; let label: String; let bn: String; let icon: String
        let fashnOnly: Bool; let isVideo: Bool; let needsProduct: Bool
    }
    static let modes: [Mode] = [
        .init(id: "product_to_model", label: "Product→Model", bn: "প্রোডাক্ট", icon: "hanger",
              fashnOnly: false, isVideo: false, needsProduct: true),
        .init(id: "try_on", label: "Try-On", bn: "ট্রাই-অন", icon: "person.fill",
              fashnOnly: false, isVideo: false, needsProduct: true),
        .init(id: "model_swap", label: "Model Swap", bn: "সোয়াপ", icon: "arrow.triangle.2.circlepath",
              fashnOnly: true, isVideo: false, needsProduct: false),
        .init(id: "face_to_model", label: "Face→Model", bn: "ফেস", icon: "face.smiling",
              fashnOnly: true, isVideo: false, needsProduct: false),
        .init(id: "edit", label: "Edit", bn: "এডিট", icon: "wand.and.stars",
              fashnOnly: true, isVideo: false, needsProduct: false),
        .init(id: "image_to_video", label: "Image→Video", bn: "রিল", icon: "video.fill",
              fashnOnly: false, isVideo: true, needsProduct: false),
    ]
    static func modeLabel(_ id: String?) -> String {
        modes.first { $0.id == id }?.label ?? (id ?? "ক্রিয়েটিভ")
    }

    static let vibes: [(id: String, bn: String)] =
        [("premium", "প্রিমিয়াম"), ("festival", "ফেস্টিভাল"), ("offer", "অফার"), ("lifestyle", "লাইফস্টাইল")]
    static let families = ["Single", "বাবা+ছেলে", "মা+মেয়ে", "মা+ছেলে", "বাবা+মেয়ে", "কাপল", "পুরো ফ্যামিলি"]
    static let familyIds = ["single", "father_son", "mother_daughter", "mother_son", "father_daughter", "couple", "full_family"]
    static let familyIcons = ["person.fill", "figure.and.child.holdinghands", "figure.and.child.holdinghands",
                              "figure.and.child.holdinghands", "figure.and.child.holdinghands", "heart.fill",
                              "figure.2.and.child.holdinghands"]

    /// Proportional box (fits `maxSide`) for an "w:h" aspect string — drives the visual ratio frames.
    static func ratioBox(_ s: String, maxSide: CGFloat) -> CGSize {
        let p = s.split(separator: ":").compactMap { Double($0) }
        guard p.count == 2, p[0] > 0, p[1] > 0 else { return CGSize(width: maxSide, height: maxSide) }
        return p[0] >= p[1] ? CGSize(width: maxSide, height: maxSide * p[1] / p[0])
                            : CGSize(width: maxSide * p[0] / p[1], height: maxSide)
    }
    static let aspects = ["4:5", "1:1", "9:16", "16:9"]
    static let resolutions = ["1K", "2K", "4K"]
    static let genModes = ["Fast", "Balanced", "Quality"]
    static let backgrounds = ["Studio", "Outdoor BD", "Festival", "Lifestyle", "Custom"]
    static let videoTemplates: [(bn: String, sub: String)] =
        [("ঝলক", "fast cut · 15s"), ("স্টোরি", "9:16 · 30s"), ("শোকেস", "slow pan · 20s"), ("অফার", "bold text · 12s")]
    static let audioModes = ["শুটের অডিও", "শুধু মিউজিক", "কথা+মিউজিক"]
    static let musicVibes = ["উৎসব", "শান্ত", "এনার্জেটিক"]

    /// The brand coral → rose CTA gradient (echoes the aura's coral→pink blobs).
    static var cta: LinearGradient {
        LinearGradient(colors: [Color(red: 0.96, green: 0.63, blue: 0.37),
                                Color(red: 0.85, green: 0.37, blue: 0.53)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    static let ctaGlow = Color(red: 0.91, green: 0.43, blue: 0.36).opacity(0.45)
}

enum CSTab: String, CaseIterable, Identifiable {
    case home, create, gallery, video, library
    var id: String { rawValue }
    var bn: String {
        switch self {
        case .home: return "হোম"; case .create: return "তৈরি"; case .gallery: return "গ্যালারি"
        case .video: return "ভিডিও"; case .library: return "লাইব্রেরি"
        }
    }
    var icon: String {
        switch self {
        case .home: return "house.fill"; case .create: return "sparkles"; case .gallery: return "photo.on.rectangle.angled"
        case .video: return "film.fill"; case .library: return "person.crop.circle.fill"
        }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class CreativeStudioVM {
    var config: CSStudioConfig?
    var gallery: [CSGalleryItem] = []
    var models: [CSModel] = []
    var loading = false
    var authExpired = false
    var generating = false
    var toast: String?

    var galleryFilter = "all"   // all | image | video | executed | pending

    var filteredGallery: [CSGalleryItem] {
        switch galleryFilter {
        case "image": return gallery.filter { !$0.isVideo }
        case "video": return gallery.filter { $0.isVideo }
        case "executed": return gallery.filter { $0.isExecuted }
        case "pending": return gallery.filter { !$0.isExecuted }
        default: return gallery
        }
    }

    func loadAll() async {
        loading = true
        defer { loading = false }
        async let c: CSStudioConfig? = try? AlmaAPI.shared.get("/api/assistant/creative-studio/config")
        async let g: CSGalleryResponse? = try? AlmaAPI.shared.get(
            "/api/assistant/creative-studio/gallery", query: ["page": "1", "limit": "24"])
        async let m: CSModelsResponse? = try? AlmaAPI.shared.get("/api/assistant/brand-models")
        let (cfg, gal, mods) = await (c, g, m)
        if let cfg { config = cfg }
        if let gal { gallery = gal.items }
        if let mods { models = mods.models }
        authExpired = (cfg == nil && gal == nil)
    }

    /// Upload one product photo then queue a generation for the chosen mode/options.
    func generate(imageData: Data, mode: CS.Mode, provider: String,
                  family: String?, aspect: String, resolution: String, genMode: String, vibe: String,
                  numImages: Int = 2) async {
        guard !generating else { return }
        generating = true
        defer { generating = false }
        do {
            let up: CSUploadResponse = try await AlmaAPI.shared.uploadMultipart(
                "/api/assistant/upload", fileField: "file",
                filename: "product.jpg", mime: "image/jpeg", data: imageData,
                fields: ["folder": "creative-studio"])
            guard let path = up.path ?? up.storagePath ?? up.url else {
                toast = "আপলোড ব্যর্থ হলো"; return
            }
            let payload = CSRunPayload(
                mode: mode.id, provider: provider, productImagePath: path,
                familyPreset: family, backgroundPrompt: nil,
                aspectRatio: aspect, resolution: resolution.lowercased(),
                generationMode: genMode.lowercased(), vibe: vibe, numImages: numImages)
            let res: CSRunResponse = try await AlmaAPI.shared.send("POST", "/api/assistant/creative-studio/run", body: payload)
            toast = res.message ?? "জেনারেশন শুরু হয়েছে — গ্যালারিতে আসবে"
            if let g: CSGalleryResponse = try? await AlmaAPI.shared.get(
                "/api/assistant/creative-studio/gallery", query: ["page": "1", "limit": "24"]) {
                gallery = g.items
            }
        } catch AlmaAPIError.notAuthenticated {
            toast = "সেশন শেষ — আবার লগইন করুন"
        } catch {
            toast = "জেনারেট করা গেল না"
        }
    }

    func flash(_ msg: String) { toast = msg }

    // ── Model library actions (wired to the same web APIs) ──────────────────
    private struct CSAction: Encodable { let action: String; let id: String }
    private struct CSOK: Decodable { let ok: Bool? }

    func setDefaultModel(_ id: String) async {
        do {
            let _: CSOK = try await AlmaAPI.shared.send("POST", "/api/assistant/brand-models",
                                                        body: CSAction(action: "set_default", id: id))
            if let m: CSModelsResponse = try? await AlmaAPI.shared.get("/api/assistant/brand-models") { models = m.models }
            toast = "ডিফল্ট মডেল সেট হলো"
        } catch { toast = "সেট করা গেল না" }
    }
    func removeModel(_ id: String) async {
        do {
            let _: CSOK = try await AlmaAPI.shared.send("POST", "/api/assistant/brand-models",
                                                        body: CSAction(action: "remove", id: id))
            models.removeAll { $0.id == id }
            toast = "মডেল মুছে ফেলা হলো"
        } catch { toast = "মুছতে পারলাম না" }
    }

    // ── Scene feedback on an executed creative (CS4 weighting) ──────────────
    private struct CSFeedback: Encodable { let pendingActionId: String; let verdict: String }
    func rate(_ item: CSGalleryItem, _ verdict: String) async {
        do {
            let _: CSOK = try await AlmaAPI.shared.send("POST", "/api/assistant/creative-studio/feedback",
                                                        body: CSFeedback(pendingActionId: item.id, verdict: verdict))
            toast = verdict == "good" ? "এই ধরনের সিন বেশি আসবে" : "এই সিন কম আসবে"
        } catch { toast = "নোট করা গেল না" }
    }
}

/// The web Creative Studio path — every heavy sub-feature (finishing editor, audio
/// lab, video upload/finish, logo, drive, settings) opens here until it's native.
let CS_WEB_PATH = "/agent/creative-studio"

// MARK: - Root screen (custom chrome + floating tab bar over the shared aura)

@available(iOS 17.0, *)
struct CreativeStudioScreen: View {
    @Environment(\.colorScheme) private var scheme
    @State private var vm = CreativeStudioVM()
    @State private var tab: CSTab
    @State private var popNav: (() -> Void)?
    /// Web fallback for anything not yet native (finishing editor, drive auth, etc.).
    let openWeb: (_ path: String, _ title: String) -> Void

    /// `initialTab` lets a deep-link (or the verification harness) open straight to a tab.
    init(openWeb: @escaping (_ path: String, _ title: String) -> Void, initialTab: CSTab = .home) {
        self.openWeb = openWeb
        _tab = State(initialValue: initialTab)
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            AgentAuroraBackground()
            CSNavPopper { popNav = $0 }.frame(width: 0, height: 0).allowsHitTesting(false)

            Group {
                switch tab {
                case .home:    CSHomeTab(vm: vm, go: { tab = $0 }, exit: { popNav?() })
                case .create:  CSCreateTab(vm: vm, back: { tab = .home })
                case .gallery: CSGalleryTab(vm: vm, openWeb: openWeb)
                case .video:   CSVideoTab(vm: vm, openWeb: openWeb)
                case .library: CSLibraryTab(vm: vm, openWeb: openWeb)
                }
            }
            .transition(.opacity)

            CSTabBar(tab: $tab)
        }
        .animation(.easeInOut(duration: 0.28), value: tab)
        .background(AgentPalette(scheme).bg0.ignoresSafeArea())
        .task { await vm.loadAll() }
        .overlay(alignment: .top) { CSToastView(message: vm.toast) }
        .toolbar(.hidden, for: .navigationBar)
    }
}

// MARK: - Floating glass tab bar (active = coral pill with label, others icon-only)

@available(iOS 17.0, *)
private struct CSTabBar: View {
    @Binding var tab: CSTab
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 6) {
            ForEach(CSTab.allCases) { t in
                Button {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.78)) { tab = t }
                    CSHaptic.tap()
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: t.icon).font(.system(size: 17, weight: .semibold))
                        if tab == t {
                            Text(t.bn).font(.system(size: 13, weight: .bold)).fixedSize()
                        }
                    }
                    .foregroundStyle(tab == t ? Color.white : AgentPalette(scheme).muted)
                    .padding(.vertical, 10)
                    .padding(.horizontal, tab == t ? 15 : 11)
                    .background {
                        if tab == t {
                            Capsule().fill(CS.cta)
                                .shadow(color: CS.ctaGlow, radius: 10, y: 5)
                        }
                    }
                }
                .buttonStyle(.plain)
                if t != CSTab.allCases.last { Spacer(minLength: 0) }
            }
        }
        .padding(7)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(scheme == .dark ? 0.12 : 0.4), lineWidth: 1))
        .padding(.horizontal, 14)
        .padding(.bottom, 6)
        .shadow(color: .black.opacity(0.35), radius: 22, y: 12)
    }
}

// MARK: - HOME

@available(iOS 17.0, *)
private struct CSHomeTab: View {
    let vm: CreativeStudioVM
    let go: (CSTab) -> Void
    let exit: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var filter = "সব"

    private var hero: CSGalleryItem? { vm.gallery.first { !$0.isVideo } ?? vm.gallery.first }
    private var recents: [CSGalleryItem] { Array(vm.gallery.prefix(8)) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                CSChipRow(items: ["সব", "ছবি", "ভিডিও", "ফ্যামিলি", "লাইফস্টাইল"], selection: $filter)
                    .padding(.top, 12)

                heroCard.padding(.top, 16)

                CSSectionHeader(title: "শুরু করুন", trailing: "সব মোড") { go(.create) }
                featureList

                CSSectionHeader(title: "সাম্প্রতিক তৈরি", trailing: "গ্যালারি") { go(.gallery) }
                recentStrip

                CSSectionHeader(title: "ট্রেন্ডিং সিন", trailing: nil, action: nil)
                trendingGrid
                Color.clear.frame(height: 96)
            }
            .padding(.horizontal, 18)
        }
        .claudeTopFade(useNativeEdgeEffect: false)
        .refreshable { await vm.loadAll() }
    }

    private var header: some View {
        HStack(spacing: 11) {
            Button { exit(); CSHaptic.tap() } label: {
                Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AgentPalette(scheme).ink).frame(width: 38, height: 38).csGlass(scheme, corner: 999)
            }.buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 2) {
                Text((vm.config?.organization ?? "ALMA Lifestyle").uppercased())
                    .font(.system(size: 10, weight: .bold)).tracking(1.4)
                    .foregroundStyle(AgentPalette.coralLt)
                Text("ক্রিয়েটিভ স্টুডিও")
                    .font(.system(size: 19, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
            }
            Spacer()
            HStack(spacing: 5) {
                Image(systemName: "sparkles").font(.system(size: 12)).foregroundStyle(AgentPalette.coralLt)
                Text("১,২৪০").font(.system(size: 12.5, weight: .bold)).monospacedDigit()
            }
            .foregroundStyle(AgentPalette(scheme).ink)
            .padding(.vertical, 7).padding(.horizontal, 12)
            .csGlass(scheme, corner: 999)
        }
        .padding(.top, 58)
    }

    private var heroCard: some View {
        CSPhoto(url: hero?.imageURL, ratio: 0.86)
            .overlay {
                LinearGradient(colors: [.black.opacity(0.86), .black.opacity(0.1), .clear],
                               startPoint: .bottom, endPoint: .center)
                    .allowsHitTesting(false)
            }
            .overlay(alignment: .topLeading) {
                HStack(spacing: 8) {
                    CSPill(text: "নির্বাচিত", icon: "sparkles", filled: true)
                    CSPill(text: "4K · HD", icon: nil, filled: false)
                }.padding(15)
            }
            .overlay(alignment: .bottomLeading) { heroBody }
            .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(.white.opacity(0.1), lineWidth: 1))
            .shadow(color: .black.opacity(0.4), radius: 20, y: 12)
    }

    private var heroBody: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("ঈদ ২০২৬ · সিগনেচার").font(.system(size: 11, weight: .bold)).tracking(0.8)
                .foregroundStyle(AgentPalette.coralLt)
            Text("প্রিমিয়াম ফ্যামিলি সিন").font(.system(size: 24, weight: .heavy)).foregroundStyle(.white)
            Text("এক প্রোডাক্ট ছবি থেকে ঈদের পুরো ফ্যামিলি ক্যাম্পেইন — এক ট্যাপে।")
                .font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.75)).fixedSize(horizontal: false, vertical: true)
            Button { go(.create); CSHaptic.tap() } label: {
                Label("এখনই বানাও", systemImage: "wand.and.stars")
                    .font(.system(size: 14.5, weight: .bold)).foregroundStyle(.white)
                    .padding(.vertical, 13).frame(maxWidth: .infinity)
                    .background(CS.cta, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .shadow(color: CS.ctaGlow, radius: 12, y: 6)
            }.buttonStyle(.plain).padding(.top, 10)
        }
        .padding(18)
    }

    private var featureList: some View {
        VStack(spacing: 12) {
            CSFeatureRow(image: vm.gallery.first?.imageURL, name: "Product→Model", badge: "নতুন",
                         desc: "প্রোডাক্ট ছবি → রিয়েল মডেল শট", credits: "১৫০") { go(.create) }
            CSFeatureRow(image: vm.gallery.dropFirst(1).first?.imageURL, name: "ফ্যামিলি সেট", badge: "প্রিমিয়াম",
                         desc: "ম্যাচিং ঈদ কালেকশন, এক সাথে", credits: "২৫০") { go(.create) }
            CSFeatureRow(image: vm.gallery.dropFirst(2).first?.imageURL, name: "Try-On", badge: nil,
                         desc: "মডেলের গায়ে আপনার পোশাক", credits: "১২০") { go(.create) }
        }
        .padding(.top, 2)
    }

    private var recentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 11) {
                Button { go(.create) } label: {
                    VStack(spacing: 8) {
                        ZStack { RoundedRectangle(cornerRadius: 13).fill(CS.cta).frame(width: 40, height: 40)
                            Image(systemName: "plus").font(.system(size: 20, weight: .bold)).foregroundStyle(.white) }
                        Text("নতুন").font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                    }
                    .frame(width: 116, height: 150).csGlass(scheme, corner: 18)
                }.buttonStyle(.plain)
                ForEach(recents) { item in
                    CSPhoto(url: item.imageURL, ratio: 116.0 / 150.0)
                        .frame(width: 116, height: 150)
                        .overlay(alignment: .bottomLeading) {
                            Text(item.title).font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                                .lineLimit(1).padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(LinearGradient(colors: [.black.opacity(0.72), .clear], startPoint: .bottom, endPoint: .top))
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(.white.opacity(0.08), lineWidth: 1))
                }
            }.padding(.vertical, 2)
        }
    }

    private var trendingGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            ForEach(Array(vm.gallery.prefix(6))) { item in
                CSGalleryTile(item: item)
            }
        }
    }
}

// MARK: - CREATE

@available(iOS 17.0, *)
private struct CSCreateTab: View {
    let vm: CreativeStudioVM
    let back: () -> Void
    @Environment(\.colorScheme) private var scheme

    @State private var picked: PhotosPickerItem?
    @State private var imageData: Data?
    @State private var uiImage: UIImage?
    @State private var mode = CS.modes[0]
    @State private var isAdvanced = false
    @State private var advOpen = false
    @State private var vibe = 0
    @State private var family = 0
    @State private var aspect = 0
    @State private var resolution = 1
    @State private var genMode = 1
    @State private var background = 0
    @State private var numImages = 2
    @State private var providerPick = 0   // 0 = FASHN Pro, 1 = Gemini

    private var bothProviders: Bool { (vm.config?.fashnConfigured ?? false) && (vm.config?.geminiConfigured ?? false) }
    private var provider: String {
        if mode.fashnOnly { return "fashn" }
        if bothProviders { return providerPick == 0 ? "fashn" : "gemini" }
        return (vm.config?.fashnConfigured ?? false) ? "fashn" : "gemini"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                stepLabel("১ · ছবি যোগ করুন")
                dropZone
                stepLabel("২ · মোড")
                CSSegment(items: ["✦ Auto — এক ট্যাপ", "Advanced"], index: Binding(
                    get: { isAdvanced ? 1 : 0 },
                    set: { isAdvanced = ($0 == 1); if isAdvanced { advOpen = true } }))
                    .padding(.horizontal, 18)
                stepLabel("৩ · স্টাইল বেছে নিন")
                styleGrid
                stepLabel("৪ · ভাইব")
                vibeRow
                advanced.padding(.top, 20)
                Color.clear.frame(height: 150)
            }
        }
        .claudeTopFade(useNativeEdgeEffect: false)
        .overlay(alignment: .bottom) { generateBar }
        .onChange(of: picked) { _, new in Task { await loadPicked(new) } }
    }

    private var header: some View {
        HStack(spacing: 11) {
            Button { back(); CSHaptic.tap() } label: {
                Image(systemName: "chevron.left").font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AgentPalette(scheme).ink).frame(width: 38, height: 38).csGlass(scheme, corner: 999)
            }.buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 2) {
                Text("নতুন জেনারেশন").font(.system(size: 10, weight: .bold)).tracking(1.2).foregroundStyle(AgentPalette.coralLt)
                Text("ক্রিয়েটিভ বানাও").font(.system(size: 19, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
            }
            Spacer()
            Image(systemName: "star").font(.system(size: 16)).foregroundStyle(AgentPalette(scheme).ink)
                .frame(width: 38, height: 38).csGlass(scheme, corner: 999)
        }
        .padding(.top, 58).padding(.horizontal, 18)
    }

    private var dropZone: some View {
        PhotosPicker(selection: $picked, matching: .images) {
            ZStack {
                if let uiImage {
                    Image(uiImage: uiImage).resizable().scaledToFill()
                        .frame(height: 300).frame(maxWidth: .infinity).clipped()
                        .overlay(alignment: .bottomLeading) {
                            Label("ছবি যোগ হয়েছে", systemImage: "checkmark")
                                .font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                                .padding(.vertical, 7).padding(.horizontal, 13)
                                .background(.black.opacity(0.55), in: Capsule()).padding(13)
                        }
                        .overlay(alignment: .bottomTrailing) {
                            Text("বদলান").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                                .padding(.vertical, 7).padding(.horizontal, 14)
                                .background(.white.opacity(0.18), in: Capsule()).padding(13)
                        }
                } else {
                    VStack(spacing: 14) {
                        ZStack { RoundedRectangle(cornerRadius: 20).fill(CS.cta).frame(width: 64, height: 64)
                            Image(systemName: "plus").font(.system(size: 26, weight: .bold)).foregroundStyle(.white) }
                            .shadow(color: CS.ctaGlow, radius: 14, y: 8)
                        Text("প্রোডাক্ট ছবি দিন").font(.system(size: 16, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                        Text("ট্যাপ করে তুলুন বা টেনে ছাড়ুন — বাকিটা স্টুডিও সামলাবে")
                            .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).muted)
                            .multilineTextAlignment(.center).frame(maxWidth: 220)
                    }
                    .frame(maxWidth: .infinity).frame(height: 300)
                }
            }
            .background(AgentPalette(scheme).glassFill)
            .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.6, dash: uiImage == nil ? [7] : []))
                .foregroundStyle(uiImage == nil ? Color.white.opacity(0.2) : AgentPalette.coral.opacity(0.5)))
        }
        .buttonStyle(.plain).padding(.horizontal, 18)
    }

    private var styleGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 11), count: 3), spacing: 11) {
            ForEach(Array(CS.modes.enumerated()), id: \.element.id) { idx, m in
                Button { mode = m; CSHaptic.tap() } label: {
                    CSPhoto(url: sampleURL(idx), ratio: 0.75)
                        .overlay(alignment: .bottom) {
                            Text(m.label).font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                                .lineLimit(1).minimumScaleFactor(0.7).padding(.vertical, 8).frame(maxWidth: .infinity)
                                .background(LinearGradient(colors: [.black.opacity(0.78), .clear], startPoint: .bottom, endPoint: .center))
                        }
                        .overlay(alignment: .topLeading) {
                            if m.fashnOnly {
                                Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(Color(red: 0.91, green: 0.72, blue: 0.45))
                                    .padding(6).background(.black.opacity(0.55), in: Circle()).padding(7)
                            }
                        }
                        .overlay(alignment: .topTrailing) {
                            if mode.id == m.id {
                                Image(systemName: "checkmark").font(.system(size: 11, weight: .heavy)).foregroundStyle(AgentPalette.coral)
                                    .padding(5).background(.white, in: Circle()).padding(7)
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(mode.id == m.id ? Color.white : .white.opacity(0.08), lineWidth: mode.id == m.id ? 2 : 1))
                }.buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 18)
    }

    private var vibeRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 11) {
                ForEach(Array(CS.vibes.enumerated()), id: \.offset) { idx, v in
                    Button { vibe = idx; CSHaptic.tap() } label: {
                        VStack(spacing: 8) {
                            CSPhoto(url: sampleURL(idx), ratio: 96.0 / 64.0)
                                .frame(width: 96, height: 64)
                                .overlay(alignment: .topTrailing) {
                                    if vibe == idx {
                                        Image(systemName: "checkmark").font(.system(size: 10, weight: .heavy)).foregroundStyle(AgentPalette.coral)
                                            .padding(4).background(.white, in: Circle()).padding(6)
                                    }
                                }
                                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(vibe == idx ? Color.white : .white.opacity(0.1), lineWidth: vibe == idx ? 2 : 1))
                            Text(v.bn).font(.system(size: 12, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                        }
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 18)
        }
    }

    private var advanced: some View {
        VStack(spacing: 0) {
            Button { withAnimation(.easeInOut(duration: 0.3)) { advOpen.toggle() }; CSHaptic.tap() } label: {
                HStack {
                    Label("অ্যাডভান্সড কন্ট্রোল", systemImage: "slider.horizontal.3")
                        .font(.system(size: 14.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(AgentPalette(scheme).muted).rotationEffect(.degrees(advOpen ? 180 : 0))
                }.padding(16)
            }.buttonStyle(.plain)
            if advOpen {
                VStack(alignment: .leading, spacing: 0) {
                    Divider().overlay(AgentPalette(scheme).borderSubtle)
                    advField("ফ্যামিলি প্রিসেট") { familyRail }
                    advField("অ্যাসপেক্ট রেশিও") { aspectRow }
                    HStack(alignment: .top, spacing: 14) {
                        advField("রেজোলিউশন") { CSSegment(items: CS.resolutions, index: $resolution).padding(.leading, 16) }
                        advField("কোয়ালিটি") { CSSegment(items: CS.genModes, index: $genMode).padding(.trailing, 16) }
                    }
                    advField("ব্যাকগ্রাউন্ড") { backgroundRail }
                    if bothProviders && !mode.fashnOnly {
                        advField("ইঞ্জিন") {
                            CSSegment(items: ["FASHN Pro", "Gemini"], index: $providerPick).padding(.horizontal, 16)
                        }
                    }
                    advField("কয়টি ছবি") { imageCountStepper }
                    Color.clear.frame(height: 10)
                }
            }
        }
        .csGlass(scheme, corner: 22).padding(.horizontal, 18)
    }

    private func advField<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(label.uppercased()).font(.system(size: 11.5, weight: .bold)).tracking(0.6)
                .foregroundStyle(AgentPalette(scheme).muted).padding(.horizontal, 16)
            content()
        }.padding(.vertical, 14)
    }

    // Family presets as icon pills (visual, not flat text chips).
    private var familyRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 9) {
                ForEach(Array(CS.families.enumerated()), id: \.offset) { i, name in
                    let sel = family == i
                    Button { family = i; CSHaptic.tap() } label: {
                        HStack(spacing: 7) {
                            Image(systemName: CS.familyIcons[i]).font(.system(size: 13, weight: .semibold))
                            Text(name).font(.system(size: 12.5, weight: sel ? .bold : .medium))
                        }
                        .foregroundStyle(sel ? Color.white : AgentPalette(scheme).muted)
                        .padding(.vertical, 9).padding(.horizontal, 13)
                        .background {
                            if sel { Capsule().fill(AgentPalette.coral).shadow(color: CS.ctaGlow, radius: 6, y: 3) }
                            else { Capsule().fill(Color.white.opacity(scheme == .dark ? 0.06 : 0.5)); Capsule().strokeBorder(.white.opacity(0.08), lineWidth: 1) }
                        }
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 16)
        }
    }

    // Aspect ratio as tappable proportional frames (the premium AI-app pattern).
    private var aspectRow: some View {
        HStack(spacing: 10) {
            ForEach(Array(CS.aspects.enumerated()), id: \.offset) { i, r in
                let sel = aspect == i
                let sz = CS.ratioBox(r, maxSide: 34)
                Button { aspect = i; CSHaptic.tap() } label: {
                    VStack(spacing: 9) {
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(sel ? AgentPalette.coral.opacity(0.22) : Color.white.opacity(0.06))
                            .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous)
                                .strokeBorder(sel ? AgentPalette.coral : Color.white.opacity(0.32), lineWidth: sel ? 2 : 1.5))
                            .frame(width: sz.width, height: sz.height)
                            .frame(height: 40)
                        Text(r).font(.system(size: 12, weight: sel ? .bold : .medium))
                            .foregroundStyle(sel ? AgentPalette.coral : AgentPalette(scheme).muted)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(sel ? AgentPalette.coral.opacity(0.1) : Color.white.opacity(scheme == .dark ? 0.03 : 0.28)))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(sel ? AgentPalette.coral.opacity(0.4) : Color.white.opacity(0.06), lineWidth: 1))
                }.buttonStyle(.plain)
            }
        }.padding(.horizontal, 16)
    }

    // Background styles as real-photo thumbnails (+ a Custom tile).
    private var backgroundRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(Array(CS.backgrounds.enumerated()), id: \.offset) { i, name in
                    let sel = background == i
                    Button { background = i; CSHaptic.tap() } label: {
                        if name == "Custom" {
                            VStack(spacing: 6) {
                                Image(systemName: "plus").font(.system(size: 18, weight: .bold))
                                Text("Custom").font(.system(size: 10.5, weight: .semibold))
                            }
                            .foregroundStyle(sel ? AgentPalette.coral : AgentPalette(scheme).muted)
                            .frame(width: 92, height: 68)
                            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.05)))
                            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(style: StrokeStyle(lineWidth: 1.4, dash: [5]))
                                .foregroundStyle(sel ? AgentPalette.coral.opacity(0.6) : .white.opacity(0.25)))
                        } else {
                            CSPhoto(url: bgURL(i), ratio: 92.0 / 68.0).frame(width: 92, height: 68)
                                .overlay(alignment: .bottomLeading) {
                                    Text(name).font(.system(size: 10.5, weight: .bold)).foregroundStyle(.white)
                                        .padding(6).frame(maxWidth: .infinity, alignment: .leading)
                                        .background(LinearGradient(colors: [.black.opacity(0.72), .clear], startPoint: .bottom, endPoint: .center))
                                }
                                .overlay(alignment: .topTrailing) {
                                    if sel {
                                        Image(systemName: "checkmark").font(.system(size: 9, weight: .heavy)).foregroundStyle(AgentPalette.coral)
                                            .padding(4).background(.white, in: Circle()).padding(5)
                                    }
                                }
                                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .strokeBorder(sel ? Color.white : .white.opacity(0.1), lineWidth: sel ? 2 : 1))
                        }
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 16)
        }
    }
    private func bgURL(_ i: Int) -> URL? {
        vm.gallery.isEmpty ? nil : vm.gallery[(i + 2) % vm.gallery.count].imageURL
    }

    private var imageCountStepper: some View {
        HStack(spacing: 16) {
            ForEach(1...4, id: \.self) { n in
                Button { numImages = n; CSHaptic.tap() } label: {
                    Text(almaBn(n)).font(.system(size: 15, weight: .bold))
                        .foregroundStyle(numImages == n ? Color.white : AgentPalette(scheme).muted)
                        .frame(width: 46, height: 40)
                        .background {
                            if numImages == n { RoundedRectangle(cornerRadius: 12, style: .continuous).fill(AgentPalette.coral) }
                            else { RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(scheme == .dark ? 0.05 : 0.4)) }
                        }
                }.buttonStyle(.plain)
            }
            Spacer()
        }.padding(.horizontal, 16)
    }

    private var generateBar: some View {
        Button { Task { await runGenerate() } } label: {
            HStack(spacing: 9) {
                if vm.generating { ProgressView().tint(.white) }
                else { Image(systemName: "wand.and.stars").font(.system(size: 18, weight: .semibold)) }
                Text(vm.generating ? "জেনারেট হচ্ছে…" : "জেনারেট — ৪টি ভ্যারিয়েশন").font(.system(size: 16, weight: .bold))
            }
            .foregroundStyle(.white).frame(maxWidth: .infinity).padding(17)
            .background(CS.cta, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .shadow(color: CS.ctaGlow, radius: 18, y: 10)
        }
        .buttonStyle(.plain).disabled(vm.generating)
        .padding(.horizontal, 18).padding(.bottom, 92)
    }

    private func stepLabel(_ s: String) -> some View {
        Text(s.uppercased()).font(.system(size: 12, weight: .bold)).tracking(0.6)
            .foregroundStyle(AgentPalette(scheme).muted).padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sampleURL(_ i: Int) -> URL? {
        guard !vm.gallery.isEmpty else { return nil }
        return vm.gallery[i % vm.gallery.count].imageURL
    }

    private func loadPicked(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self) else { return }
        imageData = data; uiImage = UIImage(data: data)
    }

    private func runGenerate() async {
        guard let data = imageData else { vm.flash("আগে একটা প্রোডাক্ট ছবি দিন"); CSHaptic.tap(); return }
        guard mode.needsProduct || mode.id == "product_to_model" else {
            vm.flash("এই মোডে অতিরিক্ত ছবি লাগবে — আপাতত Advanced ওয়েবে"); return
        }
        CSHaptic.tap()
        await vm.generate(imageData: data, mode: mode, provider: provider,
                          family: family == 0 ? nil : CS.familyIds[family],
                          aspect: CS.aspects[aspect], resolution: CS.resolutions[resolution],
                          genMode: CS.genModes[genMode], vibe: CS.vibes[vibe].id, numImages: numImages)
    }
}

// MARK: - GALLERY

@available(iOS 17.0, *)
private struct CSGalleryTab: View {
    let vm: CreativeStudioVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var detail: CSGalleryItem?

    private let filterMap: [(bn: String, key: String)] =
        [("সব", "all"), ("ছবি", "image"), ("ভিডিও", "video"), ("পোস্ট হয়েছে", "executed"), ("পেন্ডিং", "pending")]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(almaBn(vm.gallery.count))টি ক্রিয়েটিভ").font(.system(size: 10, weight: .bold)).tracking(1.2)
                        .foregroundStyle(AgentPalette.coralLt)
                    Text("গ্যালারি").font(.system(size: 30, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
                }.padding(.top, 58).padding(.horizontal, 18)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(filterMap.enumerated()), id: \.offset) { _, f in
                            CSChip(text: f.bn, on: vm.galleryFilter == f.key) { vm.galleryFilter = f.key; CSHaptic.tap() }
                        }
                    }.padding(.horizontal, 18)
                }.padding(.top, 14)

                if vm.gallery.isEmpty {
                    CSEmpty(loading: vm.loading).padding(.top, 40)
                } else {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                        ForEach(vm.filteredGallery) { item in
                            CSGalleryTile(item: item).onTapGesture { detail = item; CSHaptic.tap() }
                        }
                    }.padding(18)
                }
                Color.clear.frame(height: 96)
            }
        }
        .claudeTopFade(useNativeEdgeEffect: false)
        .refreshable { await vm.loadAll() }
        .sheet(item: $detail) { item in
            CSDetailSheet(item: item, vm: vm, openWeb: openWeb)
                .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
    }
}

// MARK: - VIDEO

@available(iOS 17.0, *)
private struct CSVideoTab: View {
    let vm: CreativeStudioVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var vibe = 0
    @State private var template = 0
    @State private var audioMode = 0
    @State private var music = 0
    @State private var captions = true
    @State private var stings = false

    private var clip: CSGalleryItem? { vm.gallery.first { $0.isVideo } ?? vm.gallery.first }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("রিল স্টুডিও · zero-LLM রেসিপি").font(.system(size: 10, weight: .bold)).tracking(1.1).foregroundStyle(AgentPalette.coralLt)
                    Text("ভিডিও").font(.system(size: 30, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
                }.padding(.top, 58).padding(.horizontal, 18)

                clipCard.padding(.top, 16).padding(.horizontal, 18)
                secLabel("ভাইব রেসিপি")
                CSSegment(items: ["Premium", "Festival", "Offer", "Lifestyle"], index: $vibe).padding(.horizontal, 18)
                secLabel("টেমপ্লেট")
                templates
                secLabel("এডিট")
                editToggles.padding(.horizontal, 18)
                secLabel("অডিও")
                CSSegment(items: CS.audioModes, index: $audioMode).padding(.horizontal, 18)
                secLabel("মিউজিক বেড")
                CSChipRow(items: CS.musicVibes, selectionIndex: $music)
                Button { openWeb(CS_WEB_PATH, "ভিডিও স্টুডিও"); CSHaptic.tap() } label: {
                    VStack(spacing: 3) {
                        Label("ভিডিও স্টুডিওতে যান — আপলোড ও রেন্ডার", systemImage: "film")
                            .font(.system(size: 15.5, weight: .bold)).foregroundStyle(.white)
                        Text("শুট আপলোড · মিউজিক লাইব্রেরি · কভার · ভয়েসওভার · টেমপ্লেট ফিনিশিং")
                            .font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.85))
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 15).padding(.horizontal, 14)
                    .background(CS.cta, in: RoundedRectangle(cornerRadius: 20, style: .continuous)).shadow(color: CS.ctaGlow, radius: 16, y: 9)
                }.buttonStyle(.plain).padding(.horizontal, 18).padding(.top, 24)
                Color.clear.frame(height: 96)
            }
        }
        .claudeTopFade(useNativeEdgeEffect: false)
    }

    private var clipCard: some View {
        CSPhoto(url: clip?.imageURL, ratio: 1.9)
            .frame(height: 210)
            .overlay { Image(systemName: "play.fill").font(.system(size: 22)).foregroundStyle(.white)
                .frame(width: 60, height: 60).background(.ultraThinMaterial, in: Circle()) }
            .overlay(alignment: .topLeading) { CSPill(text: "shoot_eid_03.mov", icon: "video.fill", filled: false).padding(14) }
            .overlay(alignment: .bottomTrailing) {
                Text("0:48").font(.system(size: 11, weight: .bold)).monospacedDigit().foregroundStyle(.white)
                    .padding(.vertical, 4).padding(.horizontal, 9).background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 8)).padding(14)
            }
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(.white.opacity(0.1), lineWidth: 1))
    }

    private var templates: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(Array(CS.videoTemplates.enumerated()), id: \.offset) { idx, t in
                    Button { template = idx; CSHaptic.tap() } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            CSPhoto(url: vm.gallery.isEmpty ? nil : vm.gallery[idx % vm.gallery.count].imageURL, ratio: 132.0 / 172.0)
                                .frame(width: 132, height: 172)
                                .overlay { Image(systemName: "play.fill").font(.system(size: 13)).foregroundStyle(.white)
                                    .frame(width: 32, height: 32).background(.white.opacity(0.22), in: Circle()) }
                                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(template == idx ? Color.white : .white.opacity(0.1), lineWidth: template == idx ? 2 : 1))
                            Text(t.bn).font(.system(size: 12.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                            Text(t.sub).font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                        }.frame(width: 132)
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 18)
        }
    }

    private var editToggles: some View {
        VStack(spacing: 0) {
            CSToggleRow(title: "বাংলা ক্যাপশন", sub: "Whisper থেকে অটো-বার্ন", on: $captions)
            Divider().overlay(AgentPalette(scheme).borderSubtle).padding(.horizontal, 16)
            CSToggleRow(title: "লোগো স্টিং", sub: "শুরু + শেষে ইন্ট্রো/আউট্রো", on: $stings)
        }.csGlass(scheme, corner: 22)
    }

    private func secLabel(_ s: String) -> some View {
        Text(s).font(.system(size: 15, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
            .padding(.horizontal, 20).padding(.top, 22).padding(.bottom, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - LIBRARY

@available(iOS 17.0, *)
private struct CSLibraryTab: View {
    let vm: CreativeStudioVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var finish = 0
    @State private var logoOn = true
    @State private var codeOn = true
    @State private var confirmDelete: CSModel?

    private let finishModes: [(icon: String, name: String, sub: String)] = [
        ("square.stack.3d.up", "মডেল ওভারলে", "মডেলের ওপর লোগো + কোড"),
        ("tag", "প্রোডাক্ট কার্ড", "সাদা কার্ডে প্রাইস সহ"),
        ("sparkles", "লাইফস্টাইল", "সিন + সফট হুক"),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("মডেল + ফিনিশিং").font(.system(size: 10, weight: .bold)).tracking(1.1).foregroundStyle(AgentPalette.coralLt)
                    Text("লাইব্রেরি").font(.system(size: 30, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
                }.padding(.top, 58).padding(.horizontal, 18)

                CSSectionHeader(title: "সেভ করা মডেল", trailing: "\(almaBn(vm.models.count))টি", action: nil).padding(.horizontal, 18)
                modelGrid

                CSSectionHeader(title: "ফিনিশিং", trailing: "logo · code · hook", action: nil).padding(.horizontal, 18)
                finishRail
                finishOptions
                CSSectionHeader(title: "আরও স্টুডিও টুল", trailing: nil, action: nil).padding(.horizontal, 18)
                moreTools
                Color.clear.frame(height: 96)
            }
        }
        .claudeTopFade(useNativeEdgeEffect: false)
        .refreshable { await vm.loadAll() }
        .alert("মডেল মুছবেন?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button("বাতিল", role: .cancel) {}
            Button("মুছুন", role: .destructive) { if let m = confirmDelete { Task { await vm.removeModel(m.id) } } }
        } message: { Text(confirmDelete?.name ?? "") }
    }

    // Logo/code toggles + a working apply button (per-image finishing opens the web editor).
    private var finishOptions: some View {
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                CSToggleRow(title: "লোগো বসাও", sub: "নিচের কোণে ওয়াটারমার্ক", on: $logoOn)
                Divider().overlay(AgentPalette(scheme).borderSubtle).padding(.horizontal, 16)
                CSToggleRow(title: "প্রাইস কোড + হুক", sub: "অফার টেক্সট ওভারলে", on: $codeOn)
            }.csGlass(scheme, corner: 20).padding(.horizontal, 18).padding(.top, 16)

            Button { openWeb(CS_WEB_PATH, "ফিনিশিং এডিটর"); CSHaptic.tap() } label: {
                Label("ছবি বেছে ফিনিশিং এডিটর খুলুন", systemImage: "slider.horizontal.below.rectangle")
                    .font(.system(size: 15.5, weight: .bold)).foregroundStyle(.white).frame(maxWidth: .infinity).padding(16)
                    .background(CS.cta, in: RoundedRectangle(cornerRadius: 18, style: .continuous)).shadow(color: CS.ctaGlow, radius: 14, y: 8)
            }.buttonStyle(.plain).padding(.horizontal, 18).padding(.top, 14)
            Text("লোগো, রং, ফন্ট আপনার ব্র্যান্ড সেটিং থেকেই আসে — প্রতি ছবির কোড ও hook এডিটরে লিখুন।")
                .font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).muted)
                .padding(.horizontal, 22).padding(.top, 9)
        }
    }

    // Reachable entries for the heavy web-only tools (nothing is lost / no dead ends).
    private var moreTools: some View {
        VStack(spacing: 10) {
            toolRow("🎙️ অডিও ল্যাব", "ভয়েস, মিউজিক, উইশ গান, SFX", "waveform")
            toolRow("🖼️ ব্র্যান্ড লোগো", "লোগো আপলোড / বদলান", "photo.badge.plus")
            toolRow("☁️ Google Drive", "ছবি/ভিডিও অটো-ব্যাকআপ", "arrow.up.doc")
            toolRow("⚙️ স্টুডিও সেটিংস", "QC মান · Telegram নোটিফাই", "gearshape")
        }.padding(.horizontal, 18)
    }
    private func toolRow(_ title: String, _ sub: String, _ icon: String) -> some View {
        Button { openWeb(CS_WEB_PATH, title); CSHaptic.tap() } label: {
            HStack(spacing: 13) {
                Image(systemName: icon).font(.system(size: 17)).foregroundStyle(AgentPalette.coralLt).frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 14.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                    Text(sub).font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).muted)
                }
                Spacer()
                Image(systemName: "arrow.up.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
            }.padding(14).csGlass(scheme, corner: 18)
        }.buttonStyle(.plain)
    }

    private var modelGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            ForEach(vm.models) { m in
                CSPhoto(url: m.imageURL, ratio: 0.75)
                    .overlay(alignment: .bottomLeading) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(m.name ?? "মডেল").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            Text(m.role ?? "brand model").font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.66))
                        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(LinearGradient(colors: [.black.opacity(0.8), .clear], startPoint: .bottom, endPoint: .center))
                    }
                    .overlay(alignment: .topLeading) {
                        if m.isDefault == true {
                            Label("ডিফল্ট", systemImage: "star.fill").font(.system(size: 9.5, weight: .bold))
                                .foregroundStyle(Color(red: 0.17, green: 0.12, blue: 0))
                                .padding(.vertical, 4).padding(.horizontal, 8)
                                .background(Color(red: 0.91, green: 0.72, blue: 0.27), in: Capsule()).padding(9)
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        HStack(spacing: 6) {
                            if m.isDefault != true {
                                iconChip("star") { Task { await vm.setDefaultModel(m.id) } }
                            }
                            iconChip("trash") { confirmDelete = m }
                        }.padding(9)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.white.opacity(0.1), lineWidth: 1))
            }
            addModelCard
        }.padding(.horizontal, 18)
    }
    private func iconChip(_ icon: String, _ tap: @escaping () -> Void) -> some View {
        Button { tap(); CSHaptic.tap() } label: {
            Image(systemName: icon).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                .frame(width: 28, height: 28).background(.black.opacity(0.45), in: Circle())
                .overlay(Circle().strokeBorder(.white.opacity(0.15), lineWidth: 1))
        }.buttonStyle(.plain)
    }

    private var addModelCard: some View {
        Button { openWeb(CS_WEB_PATH, "নতুন মডেল"); CSHaptic.tap() } label: {
            VStack(spacing: 9) {
                ZStack { RoundedRectangle(cornerRadius: 14).fill(CS.cta).frame(width: 44, height: 44)
                    Image(systemName: "plus").font(.system(size: 22, weight: .bold)).foregroundStyle(.white) }
                Text("নতুন মডেল").font(.system(size: 13, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            }
            .frame(maxWidth: .infinity).aspectRatio(0.75, contentMode: .fit)
            .csGlass(scheme, corner: 20)
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.4, dash: [6])).foregroundStyle(.white.opacity(0.2)))
        }.buttonStyle(.plain)
    }

    private var finishRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(Array(finishModes.enumerated()), id: \.offset) { idx, f in
                    Button { finish = idx; CSHaptic.tap() } label: {
                        VStack(alignment: .leading, spacing: 0) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 13).fill(finish == idx ? AnyShapeStyle(CS.cta) : AnyShapeStyle(Color.white.opacity(0.07)))
                                    .frame(width: 42, height: 42)
                                Image(systemName: f.icon).font(.system(size: 20)).foregroundStyle(finish == idx ? .white : AgentPalette(scheme).ink)
                            }.padding(.bottom, 12)
                            Text(f.name).font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                            Text(f.sub).font(.system(size: 11)).foregroundStyle(AgentPalette(scheme).muted).padding(.top, 3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(16).frame(width: 156, alignment: .leading)
                        .background {
                            RoundedRectangle(cornerRadius: 20, style: .continuous)
                                .fill(finish == idx ? AgentPalette.coral.opacity(0.12) : Color.white.opacity(scheme == .dark ? 0.04 : 0.3))
                        }
                        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(finish == idx ? AgentPalette.coral.opacity(0.45) : .white.opacity(0.08), lineWidth: 1))
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 18)
        }
    }
}

// MARK: - Reusable components

@available(iOS 17.0, *)
private struct CSPhoto: View {
    let url: URL?
    var ratio: CGFloat = 0.75   // width / height
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Rectangle().fill(placeholder).aspectRatio(ratio, contentMode: .fit)
            .overlay {
                if let url {
                    AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.25))) { phase in
                        switch phase {
                        case .success(let img): img.resizable().scaledToFill()
                        case .failure: fallback
                        default: ProgressView().controlSize(.small).tint(.white)
                        }
                    }
                } else { fallback }
            }
            .clipped()
    }
    private var placeholder: LinearGradient {
        LinearGradient(colors: [Color(red: 0.16, green: 0.15, blue: 0.22), Color(red: 0.24, green: 0.16, blue: 0.24)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    private var fallback: some View {
        Image(systemName: "photo").font(.system(size: 26)).foregroundStyle(.white.opacity(0.28))
    }
}

@available(iOS 17.0, *)
private struct CSGalleryTile: View {
    let item: CSGalleryItem
    @Environment(\.colorScheme) private var scheme
    @State private var fav = false
    var body: some View {
        CSPhoto(url: item.imageURL, ratio: 0.78)
            .overlay(alignment: .topLeading) {
                Text(item.isExecuted ? "পোস্ট" : "পেন্ডিং").font(.system(size: 9.5, weight: .bold))
                    .foregroundStyle(item.isExecuted ? Color(red: 0.03, green: 0.07, blue: 0.05) : Color(red: 0.17, green: 0.12, blue: 0))
                    .padding(.vertical, 4).padding(.horizontal, 9)
                    .background(item.isExecuted ? AgentPalette.teal : Color(red: 0.91, green: 0.72, blue: 0.27), in: Capsule()).padding(10)
            }
            .overlay(alignment: .topTrailing) {
                Button { fav.toggle(); CSHaptic.tap() } label: {
                    Image(systemName: fav ? "heart.fill" : "heart").font(.system(size: 13))
                        .foregroundStyle(fav ? Color(red: 1, green: 0.37, blue: 0.48) : .white)
                        .frame(width: 28, height: 28).background(.black.opacity(0.4), in: Circle())
                }.buttonStyle(.plain).padding(9)
            }
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title).font(.system(size: 12.5, weight: .bold)).foregroundStyle(.white).lineLimit(1)
                    Text(item.modeLabel).font(.system(size: 10)).foregroundStyle(.white.opacity(0.62))
                }.padding(11).frame(maxWidth: .infinity, alignment: .leading)
                .background(LinearGradient(colors: [.black.opacity(0.82), .clear], startPoint: .bottom, endPoint: .center))
            }
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.white.opacity(0.08), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct CSFeatureRow: View {
    let image: URL?; let name: String; let badge: String?; let desc: String; let credits: String
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Button(action: { action(); CSHaptic.tap() }) {
            HStack(spacing: 14) {
                CSPhoto(url: image, ratio: 1).frame(width: 76, height: 76)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 7) {
                        Text(name).font(.system(size: 15.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                        if let badge {
                            Text(badge).font(.system(size: 9.5, weight: .bold))
                                .foregroundStyle(badge == "নতুন" ? AgentPalette.teal : Color(red: 0.91, green: 0.72, blue: 0.45))
                                .padding(.vertical, 3).padding(.horizontal, 8)
                                .background((badge == "নতুন" ? AgentPalette.teal : Color(red: 0.91, green: 0.72, blue: 0.45)).opacity(0.16), in: Capsule())
                        }
                    }
                    Text(desc).font(.system(size: 12)).foregroundStyle(AgentPalette(scheme).muted).lineLimit(1)
                    HStack(spacing: 5) {
                        Image(systemName: "sparkles").font(.system(size: 11)).foregroundStyle(Color(red: 0.91, green: 0.72, blue: 0.45))
                        Text("\(credits) ক্রেডিট / জেনারেশন").font(.system(size: 11, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
                    }.padding(.top, 2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 15, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
            }
            .padding(11).csGlass(scheme, corner: 22)
        }.buttonStyle(.plain)
    }
}

@available(iOS 17.0, *)
private struct CSSectionHeader: View {
    let title: String; let trailing: String?; var action: (() -> Void)? = nil
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.system(size: 17, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
            Spacer()
            if let trailing {
                if let action {
                    Button { action(); CSHaptic.tap() } label: {
                        Text(trailing).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(AgentPalette.coralLt)
                    }.buttonStyle(.plain)
                } else {
                    Text(trailing).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
                }
            }
        }.padding(.top, 24).padding(.bottom, 13)
    }
}

@available(iOS 17.0, *)
private struct CSPill: View {
    let text: String; let icon: String?; let filled: Bool
    var body: some View {
        HStack(spacing: 5) {
            if let icon { Image(systemName: icon).font(.system(size: 10, weight: .bold)) }
            Text(text).font(.system(size: 11, weight: .bold))
        }
        .foregroundStyle(.white).padding(.vertical, 6).padding(.horizontal, 11)
        .background {
            if filled { Capsule().fill(CS.cta) }
            else { Capsule().fill(.black.opacity(0.4)); Capsule().strokeBorder(.white.opacity(0.15), lineWidth: 1) }
        }
    }
}

@available(iOS 17.0, *)
private struct CSSegment: View {
    let items: [String]
    @Binding var index: Int
    @Environment(\.colorScheme) private var scheme
    @Namespace private var ns
    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, label in
                Button { withAnimation(.spring(response: 0.32, dampingFraction: 0.8)) { index = i }; CSHaptic.tap() } label: {
                    Text(label).font(.system(size: 13.5, weight: .semibold))
                        .lineLimit(1).minimumScaleFactor(0.7)
                        .foregroundStyle(index == i ? Color.white : AgentPalette(scheme).muted)
                        .frame(maxWidth: .infinity).padding(.vertical, 10).padding(.horizontal, 2)
                        .background {
                            if index == i {
                                RoundedRectangle(cornerRadius: 12, style: .continuous).fill(CS.cta)
                                    .matchedGeometryEffect(id: "seg", in: ns)
                                    .shadow(color: CS.ctaGlow, radius: 5, y: 3)
                            }
                        }
                }.buttonStyle(.plain)
            }
        }
        .padding(4).background(.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.06), lineWidth: 1))
    }
}

@available(iOS 17.0, *)
private struct CSChip: View {
    let text: String; let on: Bool; let tap: () -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Button(action: tap) {
            Text(text).font(.system(size: 12.5, weight: on ? .bold : .medium))
                .foregroundStyle(on ? Color.white : AgentPalette(scheme).muted)
                .padding(.vertical, 9).padding(.horizontal, 15)
                .background {
                    if on { Capsule().fill(AgentPalette.coral).shadow(color: CS.ctaGlow, radius: 6, y: 3) }
                    else { Capsule().fill(Color.white.opacity(scheme == .dark ? 0.06 : 0.5)); Capsule().strokeBorder(.white.opacity(0.08), lineWidth: 1) }
                }
        }.buttonStyle(.plain)
    }
}

/// Chip row bound to a String selection (label-based).
@available(iOS 17.0, *)
private struct CSChipRow: View {
    let items: [String]
    var selection: Binding<String>? = nil
    var selectionIndex: Binding<Int>? = nil

    init(items: [String], selection: Binding<String>) { self.items = items; self.selection = selection }
    init(items: [String], selectionIndex: Binding<Int>) { self.items = items; self.selectionIndex = selectionIndex }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    CSChip(text: item, on: isOn(i)) { select(i, item) }
                }
            }.padding(.horizontal, 18)
        }
    }
    private func isOn(_ i: Int) -> Bool {
        if let selection { return selection.wrappedValue == items[i] }
        if let selectionIndex { return selectionIndex.wrappedValue == i }
        return false
    }
    private func select(_ i: Int, _ item: String) {
        selection?.wrappedValue = item; selectionIndex?.wrappedValue = i; CSHaptic.tap()
    }
}

@available(iOS 17.0, *)
private struct CSToggleRow: View {
    let title: String; let sub: String
    @Binding var on: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 14, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                Text(sub).font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).muted)
            }
            Spacer()
            Toggle("", isOn: $on).labelsHidden().tint(AgentPalette.teal)
        }.padding(15)
    }
}

@available(iOS 17.0, *)
private struct CSDetailSheet: View {
    let item: CSGalleryItem
    let vm: CreativeStudioVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @State private var rating: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                CSPhoto(url: item.imageURL, ratio: 0.82)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(.white.opacity(0.1), lineWidth: 1))
                    .padding(.horizontal, 18).padding(.top, 16)

                Text(item.title).font(.system(size: 20, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
                    .padding(.horizontal, 18).padding(.top, 18)
                HStack(spacing: 7) {
                    metaTag(item.modeLabel); metaTag((item.provider ?? "FASHN Pro")); metaTag(item.isExecuted ? "পোস্ট হয়েছে" : "পেন্ডিং")
                }.padding(.horizontal, 18).padding(.top, 8)

                HStack(spacing: 10) {
                    if let url = item.imageURL {
                        ShareLink(item: url) { actionLabel("ডাউনলোড", "arrow.down.to.line", primary: true) }
                    }
                    actionButton("এডিট", "pencil", primary: false) { openWeb(CS_WEB_PATH, "ফিনিশিং এডিটর") }
                    if let url = item.imageURL {
                        ShareLink(item: url) { actionLabel("শেয়ার", "square.and.arrow.up", primary: false) }
                    }
                }.padding(.horizontal, 18).padding(.top, 18)

                if item.isExecuted {
                    HStack(spacing: 10) {
                        rateButton("এমন সিন বেশি চাই", "good")
                        rateButton("বাদ দাও", "bad")
                    }.padding(.horizontal, 18).padding(.top, 14)
                }
                Color.clear.frame(height: 30)
            }
        }
        .presentationBackground { AgentAuroraBackground() }
    }
    private func metaTag(_ t: String) -> some View {
        Text(t).font(.system(size: 11, weight: .medium)).foregroundStyle(AgentPalette(scheme).muted)
            .padding(.vertical, 4).padding(.horizontal, 10).csGlass(scheme, corner: 999)
    }
    private func actionLabel(_ label: String, _ icon: String, primary: Bool) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon).font(.system(size: 19))
            Text(label).font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(primary ? Color.white : AgentPalette(scheme).ink)
        .frame(maxWidth: .infinity).padding(.vertical, 14)
        .background {
            if primary { RoundedRectangle(cornerRadius: 16, style: .continuous).fill(CS.cta) }
            else { RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white.opacity(scheme == .dark ? 0.05 : 0.4)) }
        }
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.08), lineWidth: primary ? 0 : 1))
    }
    private func actionButton(_ label: String, _ icon: String, primary: Bool, _ tap: @escaping () -> Void) -> some View {
        Button { tap(); CSHaptic.tap() } label: { actionLabel(label, icon, primary: primary) }.buttonStyle(.plain)
    }
    private func rateButton(_ label: String, _ key: String) -> some View {
        Button { rating = key; Task { await vm.rate(item, key) }; CSHaptic.tap() } label: {
            Text(label).font(.system(size: 13, weight: .bold))
                .foregroundStyle(rating == key && key == "good" ? Color(red: 0.03, green: 0.07, blue: 0.05) : AgentPalette(scheme).ink)
                .frame(maxWidth: .infinity).padding(13)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(rating == key ? (key == "good" ? AnyShapeStyle(AgentPalette.teal) : AnyShapeStyle(Color.white.opacity(0.16))) : AnyShapeStyle(Color.white.opacity(0.05))))
        }.buttonStyle(.plain)
    }
}

@available(iOS 17.0, *)
private struct CSEmpty: View {
    let loading: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(spacing: 12) {
            if loading { ProgressView().tint(AgentPalette.coral) }
            else { Image(systemName: "photo.stack").font(.system(size: 34)).foregroundStyle(AgentPalette(scheme).muted) }
            Text(loading ? "লোড হচ্ছে…" : "এখনো কোনো ক্রিয়েটিভ নেই").font(.system(size: 13)).foregroundStyle(AgentPalette(scheme).muted)
        }.frame(maxWidth: .infinity).padding(.top, 20)
    }
}

@available(iOS 17.0, *)
private struct CSToastView: View {
    let message: String?
    var body: some View {
        Group {
            if let message {
                Text(message).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                    .padding(.vertical, 11).padding(.horizontal, 18)
                    .background(.ultraThinMaterial, in: Capsule())
                    .overlay(Capsule().strokeBorder(.white.opacity(0.14), lineWidth: 1))
                    .shadow(color: .black.opacity(0.4), radius: 16, y: 8)
                    .padding(.top, 64)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: message)
    }
}

// MARK: - Glass helper + haptics

@available(iOS 17.0, *)
private extension View {
    func csGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.32),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.1 : 0.4), lineWidth: 1))
    }
}

enum CSHaptic {
    static func tap() {
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }
}

/// The screen is a full-screen takeover (its own header + floating tab bar). This
/// zero-size representable hides the pushed UIKit nav bar at the UIKit level (reliable
/// even when hosted in a plain UINavigationController — the SwiftUI `.toolbar(.hidden)`
/// modifier alone doesn't always propagate there), restores it on exit, and hands the
/// header's back button a pop closure. The edge-swipe back still works too.
@available(iOS 17.0, *)
private struct CSNavPopper: UIViewControllerRepresentable {
    let onReady: (@escaping () -> Void) -> Void
    func makeUIViewController(context: Context) -> Controller { let c = Controller(); c.onReady = onReady; return c }
    func updateUIViewController(_ vc: Controller, context: Context) {}

    final class Controller: UIViewController {
        var onReady: ((@escaping () -> Void) -> Void)?
        private var wasHidden = false
        override func viewDidLoad() { super.viewDidLoad(); view.isUserInteractionEnabled = false }
        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            if let nav = navigationController {
                wasHidden = nav.isNavigationBarHidden
                nav.setNavigationBarHidden(true, animated: animated)
                onReady? { [weak nav] in nav?.popViewController(animated: true) }
            }
        }
        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            navigationController?.setNavigationBarHidden(wasHidden, animated: animated)
        }
    }
}

// MARK: - Preview

@available(iOS 17.0, *)
#Preview("Creative Studio — Dark") {
    CreativeStudioScreen(openWeb: { _, _ in }).preferredColorScheme(.dark)
}
