//
//  CreativeStudioParitySwiftUI.swift
//  ALMA — native parity surfaces for the production (V4 shell) Creative Studio.
//
//  Gallery source picker · generated-reel (Veo) composer · project asset library ·
//  canvas preset sheet · Studio pulse. Every paid path goes through the same signed
//  estimate → owner confirmation gate as the web; nothing here calls a provider directly.
//

import SwiftUI
import Observation

// MARK: - Gallery source picker (web "Continue from a recent image" / source tray)

@available(iOS 17.0, *)
struct CSGalleryPickerSheet: View {
    let title: String
    let items: [CSGalleryItem]
    var selectedId: String? = nil
    let onPick: (CSGalleryItem) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var query = ""

    private var visible: [CSGalleryItem] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return items }
        return items.filter { "\($0.title) \($0.provider ?? "") \($0.mode ?? "")".lowercased().contains(needle) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(title).font(.system(size: 17, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink).padding(.top, 20)
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(AgentPalette(scheme).muted)
                    TextField("Title, mode বা provider", text: $query)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().font(.system(size: 12.5))
                }
                .padding(.horizontal, 12).frame(height: 40).csGlass(scheme, corner: 12)
                if visible.isEmpty {
                    Text("এই project-এ ready ছবি নেই — আগে Create থেকে একটি ছবি বানান।")
                        .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).muted)
                        .padding(13).frame(maxWidth: .infinity, alignment: .leading).csGlass(scheme, corner: 14)
                } else {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                        ForEach(visible) { item in
                            Button { onPick(item); dismiss(); CSHaptic.tap() } label: {
                                CSPhoto(url: item.imageURL, ratio: 0.75)
                                    .overlay(alignment: .bottomLeading) {
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(item.title).font(.system(size: 10.5, weight: .bold)).foregroundStyle(.white).lineLimit(1)
                                            Text([item.provider, item.originalVariant?.dimensionLabel ?? item.aspectRatio].compactMap { $0 }.joined(separator: " · "))
                                                .font(.system(size: 9)).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
                                        }
                                        .padding(7).frame(maxWidth: .infinity, alignment: .leading)
                                        .background(LinearGradient(colors: [.black.opacity(0.82), .clear], startPoint: .bottom, endPoint: .top))
                                    }
                                    .overlay(alignment: .topTrailing) {
                                        if selectedId == item.id {
                                            Image(systemName: "checkmark").font(.system(size: 10, weight: .heavy)).foregroundStyle(.white)
                                                .padding(5).background(AgentPalette.coral, in: Circle()).padding(6)
                                        }
                                    }
                                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                                        .strokeBorder(selectedId == item.id ? AgentPalette.coral : .white.opacity(0.1),
                                                      lineWidth: selectedId == item.id ? 2 : 1))
                            }.buttonStyle(.plain)
                        }
                    }
                }
                Text("Reference এই project-এর ভেতরেই থাকে; lineage (source asset/version) run-এর সাথে যায়।")
                    .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
            }.padding(.horizontal, 18).padding(.bottom, 30)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground { AgentAuroraBackground() }
    }
}

// MARK: - Generated reel (Veo) composer — web Video Lab "Generated reel" lane

@available(iOS 17.0, *)
struct CSReelComposer: View {
    let vm: CreativeStudioVM
    @Environment(\.colorScheme) private var scheme
    @State private var sourceMode = 0          // 0 gallery image · 1 saved avatar
    @State private var sourceItem: CSGalleryItem?
    @State private var avatarId = ""
    @State private var prompt = ""
    @State private var vibe = 0
    @State private var duration = 6
    @State private var aspect = "9:16"
    @State private var pickerOpen = false
    @State private var seeded: String?

    private var avatars: [CSModel] { vm.realModels }
    private var selectedAvatar: CSModel? { avatars.first { $0.id == avatarId } }
    private var startFramePath: String? {
        sourceMode == 0 ? sourceItem?.storagePath : selectedAvatar.flatMap(avatarPath)
    }
    private var ready: Bool {
        startFramePath != nil && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !vm.generating
    }

    /// Saved models expose a public URL; the run contract wants the storage path. The
    /// brand-models registry stores `imagePath`; CSModel only carries `imageUrl`, so we
    /// derive the canonical object path the same way the web `imagePath` resolves.
    private func avatarPath(_ m: CSModel) -> String? {
        if let path = m.imagePath, !path.isEmpty { return path }
        guard let raw = m.imageUrl else { return nil }
        if raw.hasPrefix("cs-asset:") { return nil }
        if let range = raw.range(of: "/storage/v1/object/") {
            let tail = raw[range.upperBound...]
            let parts = tail.split(separator: "?", maxSplits: 1)[0]
            // public|sign/<bucket>/<path>
            let comps = parts.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true)
            if comps.count == 2 {
                let bucketAndPath = comps[1].split(separator: "/", maxSplits: 1)
                if bucketAndPath.count == 2 { return String(bucketAndPath[1]).removingPercentEncoding }
            }
        }
        return raw.hasPrefix("http") ? nil : raw
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("🎬 জেনারেটেড রিল (Veo 3.1)").font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                    Text("Gallery ছবি বা saved avatar → motion prompt → signed estimate").font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                }
                Spacer()
                Text("720p").font(.system(size: 10, weight: .bold)).foregroundStyle(AgentPalette.coralLt)
                    .padding(.vertical, 4).padding(.horizontal, 8).background(AgentPalette.coral.opacity(0.12), in: Capsule())
            }

            CSSegment(items: ["Gallery ছবি", "Saved avatar"], index: $sourceMode)

            if sourceMode == 0 {
                Button { pickerOpen = true; CSHaptic.tap() } label: {
                    HStack(spacing: 12) {
                        Group {
                            if let sourceItem { CSPhoto(url: sourceItem.imageURL, ratio: 0.75) }
                            else { Image(systemName: "photo.on.rectangle.angled").font(.system(size: 20)).foregroundStyle(AgentPalette(scheme).muted) }
                        }
                        .frame(width: 54, height: 72).background(Color.white.opacity(0.05))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(sourceItem?.title ?? "Start frame বাছুন *").font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(2)
                            Text(sourceItem.map { [$0.provider, $0.originalVariant?.dimensionLabel].compactMap { $0 }.joined(separator: " · ") } ?? "Ready Gallery ছবি থেকে")
                                .font(.system(size: 11)).foregroundStyle(AgentPalette(scheme).muted)
                        }
                        Spacer()
                        Text(sourceItem == nil ? "বেছে নিন" : "বদলান").font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette.coral)
                            .padding(.vertical, 6).padding(.horizontal, 11).background(AgentPalette.coral.opacity(0.13), in: Capsule())
                    }
                    .padding(11).csGlass(scheme, corner: 16)
                }.buttonStyle(.plain)
            } else {
                if avatars.isEmpty {
                    Text("কোনো saved avatar নেই — লাইব্রেরি ট্যাবে মডেল সেভ করুন।")
                        .font(.system(size: 12)).foregroundStyle(Color(red: 0.95, green: 0.75, blue: 0.3))
                        .padding(11).frame(maxWidth: .infinity, alignment: .leading).csGlass(scheme, corner: 14)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 9) {
                            ForEach(avatars) { m in
                                Button { avatarId = m.id; CSHaptic.tap() } label: {
                                    VStack(spacing: 5) {
                                        CSPhoto(url: m.imageURL, ratio: 0.75).frame(width: 64, height: 84)
                                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                                                .strokeBorder(avatarId == m.id ? AgentPalette.coral : .white.opacity(0.1), lineWidth: avatarId == m.id ? 2 : 1))
                                        Text(m.name ?? "মডেল").font(.system(size: 10.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(1)
                                    }.frame(width: 72)
                                }.buttonStyle(.plain)
                            }
                        }
                    }
                    Text("Veo একটি source still নেয়; আলাদা product/person pair নেয় না।")
                        .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                }
            }

            Text("Motion prompt *").font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            TextField("ক্যামেরা মুভমেন্ট, কাপড়ের গতি, শেষ beat…", text: $prompt, axis: .vertical)
                .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(2...4)
                .padding(11).background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            Text("ভাইব").font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            HStack(spacing: 8) {
                ForEach(Array(CS.vibes.enumerated()), id: \.offset) { i, v in
                    CSChip(text: v.bn, on: vibe == i) { vibe = i }
                }
            }
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("দৈর্ঘ্য").font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                    HStack(spacing: 8) {
                        ForEach(CS.reelChainDurations, id: \.self) { d in
                            CSChip(text: "\(almaBn(d))s", on: duration == d) { duration = d }
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("অনুপাত").font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                    HStack(spacing: 8) {
                        ForEach(["9:16", "16:9"], id: \.self) { a in
                            CSChip(text: a, on: aspect == a) { aspect = a }
                        }
                    }
                }
            }
            Text(duration >= 16 ? "\(duration == 16 ? "২" : "৩") × ৮ সেকেন্ড Veo chain, তারপর deterministic ffmpeg assembly।"
                                : "এক Veo clip (৪–৮ সেকেন্ড)।")
                .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)

            Button {
                CSHaptic.tap()
                Task {
                    guard let path = startFramePath else { return }
                    _ = await vm.requestReel(sourcePath: path, sourceItem: sourceMode == 0 ? sourceItem : nil,
                                             modelId: sourceMode == 1 ? avatarId : nil,
                                             prompt: prompt, vibe: CS.vibes[vibe].id, aspect: aspect, seconds: duration)
                }
            } label: {
                HStack(spacing: 8) {
                    if vm.generating { ProgressView().tint(.white) }
                    Text(vm.generating ? "Estimate আনা হচ্ছে…" : "Review exact estimate (~৳\(almaBn(CS.longReelCostBdt(duration))))")
                        .font(.system(size: 14.5, weight: .bold))
                }
                .foregroundStyle(.white).frame(maxWidth: .infinity).padding(14)
                .background(CS.cta, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .shadow(color: CS.ctaGlow, radius: 12, y: 6)
                .opacity(ready ? 1 : 0.45)
            }.buttonStyle(.plain).disabled(!ready)
            Text("Signed whole-taka estimate → আলাদা confirmation → তারপরই Veo কল। Queued ≠ complete — Gallery-তে verified state।")
                .font(.system(size: 10)).foregroundStyle(AgentPalette(scheme).muted)
        }
        .padding(14).csGlass(scheme, corner: 18)
        .sheet(isPresented: $pickerOpen) {
            CSGalleryPickerSheet(title: "Start frame বাছুন", items: vm.readyImages, selectedId: sourceItem?.id) { sourceItem = $0 }
        }
        .onAppear { consumeSeed() }
        .onChange(of: vm.reelSeed?.id) { _, _ in consumeSeed() }
    }

    private func consumeSeed() {
        guard let seed = vm.reelSeed, seeded != seed.id else { return }
        seeded = seed.id
        vm.reelSeed = nil
        sourceMode = 0
        sourceItem = seed
    }
}

// MARK: - Project asset library (web ProjectLibraryView)

struct CSProjectAssetTag: Decodable, Identifiable, Equatable { let id: String; let name: String; let slug: String?; let color: String? }
struct CSProjectAssetVersion: Decodable, Identifiable, Equatable {
    let id: String
    let version: Int
    let previewUrl: String?
    let recipeName: String?
    let recipeVersion: Int?
    let provider: String?
    let engine: String?
    let jobId: String?
    let costBdt: Double?
    let costUsd: Double?
    let createdAt: String?
}
struct CSProjectAsset: Decodable, Identifiable, Equatable {
    let id: String
    let projectId: String
    let pendingActionId: String?
    let assetType: String?
    let title: String?
    let folder: String
    let previewUrl: String?
    let status: String?
    let tags: [CSProjectAssetTag]
    let versions: [CSProjectAssetVersion]
    let createdAt: String?
    let updatedAt: String?
    let readonly: Bool?
    var displayTitle: String { (title?.isEmpty == false ? title : nil) ?? assetType ?? "Asset" }
}
private struct CSProjectAssetsResponse: Decodable { let assets: [CSProjectAsset] }
private struct CSProjectAssetResponse: Decodable { let asset: CSProjectAsset }

@available(iOS 17.0, *)
@Observable
final class CSProjectAssetLibraryVM {
    let project: CSProjectSummary
    var assets: [CSProjectAsset] = []
    var legacy: [CSProjectAsset] = []
    var loading = false
    var legacyLoading = false
    var busy = false
    var error: String?
    var notice: String?
    var folderFilter = "সব"
    var tagFilter = "সব"

    init(project: CSProjectSummary) { self.project = project }

    var folders: [String] { ["সব"] + Array(Set(assets.map(\.folder))).sorted() }
    var tags: [String] { ["সব"] + Array(Set(assets.flatMap { $0.tags.map(\.name) })).sorted() }
    var visible: [CSProjectAsset] {
        assets.filter { a in
            (folderFilter == "সব" || a.folder == folderFilter)
                && (tagFilter == "সব" || a.tags.contains { $0.name == tagFilter })
        }
    }

    func load() async {
        loading = true; defer { loading = false }
        do {
            let r: CSProjectAssetsResponse = try await AlmaAPI.shared.get(
                "/api/assistant/creative-studio/projects/\(project.id)/assets")
            assets = r.assets
            error = nil
        } catch { self.error = message(error, "Asset library লোড হয়নি") }
    }

    func loadLegacy() async {
        legacyLoading = true; defer { legacyLoading = false }
        do {
            let r: CSProjectAssetsResponse = try await AlmaAPI.shared.get("/api/assistant/creative-studio/projects/legacy/assets")
            legacy = r.assets
        } catch { self.error = message(error, "Legacy asset লোড হয়নি") }
    }

    func saveMetadata(asset: CSProjectAsset, folder: String, tags: String) async -> CSProjectAsset? {
        guard !project.readonly else { notice = "Legacy project read-only"; return nil }
        struct Body: Encodable { let assetId: String; let folder: String; let tags: [String] }
        busy = true; defer { busy = false }
        do {
            let r: CSProjectAssetResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/creative-studio/projects/\(project.id)/assets",
                body: Body(assetId: asset.id, folder: folder.trimmingCharacters(in: .whitespaces),
                           tags: tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }))
            if let i = assets.firstIndex(where: { $0.id == r.asset.id }) { assets[i] = r.asset }
            notice = "Folder/tag সেভ হয়েছে"
            return r.asset
        } catch { self.error = message(error, "Folder/tag সেভ করা যায়নি"); return nil }
    }

    func importLegacy(_ item: CSProjectAsset) async {
        guard let pendingActionId = item.pendingActionId else { return }
        struct Body: Encodable { let pendingActionId: String; let title: String?; let folder: String; let recipeId: String? }
        busy = true; defer { busy = false }
        do {
            let r: CSProjectAssetResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/projects/\(project.id)/assets",
                body: Body(pendingActionId: pendingActionId, title: item.title,
                           folder: project.defaultFolder ?? "Creative Studio", recipeId: project.currentRecipeId))
            assets.insert(r.asset, at: 0)
            legacy.removeAll { $0.id == item.id }
            notice = "Legacy asset project-এ যোগ হয়েছে (original অক্ষত)"
        } catch { self.error = message(error, "Legacy asset যোগ হয়নি") }
    }

    private func message(_ error: Error, _ fallback: String) -> String {
        if case let AlmaAPIError.http(_, body) = error, let m = CS.serverMessage(body) { return m }
        if case AlmaAPIError.notAuthenticated = error { return "সেশন শেষ — আবার লগইন করুন" }
        return fallback
    }
}

@available(iOS 17.0, *)
struct CSProjectAssetLibrarySheet: View {
    @State private var model: CSProjectAssetLibraryVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var selected: CSProjectAsset?
    @State private var legacyOpen = false

    init(project: CSProjectSummary) { _model = State(initialValue: CSProjectAssetLibraryVM(project: project)) }

    var body: some View {
        NavigationStack {
            ZStack {
                AgentAuroraBackground().ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        header
                        filters
                        if model.loading { ProgressView("Asset library লোড হচ্ছে…").frame(maxWidth: .infinity).padding() }
                        else if model.visible.isEmpty { empty }
                        else { grid }
                        if let error = model.error {
                            Label(error, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.orange)
                        }
                        Color.clear.frame(height: 24)
                    }.padding(16)
                }
            }
            .navigationTitle("Asset library").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("বন্ধ") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await model.load() } } label: { Image(systemName: "arrow.clockwise") }.disabled(model.loading)
                }
            }
            .task { await model.load() }
            .sheet(item: $selected) { asset in CSProjectAssetDetailSheet(asset: asset, model: model) }
            .sheet(isPresented: $legacyOpen) { legacySheet }
            .overlay(alignment: .top) {
                if let notice = model.notice {
                    Text(notice).font(.caption.weight(.semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 13).padding(.vertical, 9).background(.black.opacity(0.78), in: Capsule()).padding(.top, 8)
                        .task { try? await Task.sleep(for: .seconds(3)); if model.notice == notice { model.notice = nil } }
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(model.project.name).font(.headline).foregroundStyle(AgentPalette(scheme).ink)
                    Text("\(model.project.product?.code ?? "No ERP product") · \(model.project.defaultFolder ?? "Creative Studio") · \(almaBn(model.assets.count)) assets")
                        .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
                }
                Spacer()
                if !model.project.readonly {
                    Button("Legacy থেকে যোগ") { legacyOpen = true; Task { await model.loadLegacy() } }
                        .font(.caption.weight(.bold)).buttonStyle(.bordered).tint(AgentPalette.coral)
                }
            }
            Text("নতুন Studio job এই project-এ auto-link হয়; version history ও lineage প্রতি asset-এ থাকে।")
                .font(.caption2).foregroundStyle(AgentPalette(scheme).muted)
        }.padding(14).csGlass(scheme, corner: 16)
    }

    private var filters: some View {
        HStack(spacing: 8) {
            Menu {
                ForEach(model.folders, id: \.self) { f in Button(f) { model.folderFilter = f } }
            } label: { Label(model.folderFilter == "সব" ? "Folder" : model.folderFilter, systemImage: "folder") }
            Menu {
                ForEach(model.tags, id: \.self) { t in Button(t) { model.tagFilter = t } }
            } label: { Label(model.tagFilter == "সব" ? "Tag" : "#\(model.tagFilter)", systemImage: "tag") }
            Spacer()
            Text("\(almaBn(model.visible.count))টি").font(.caption.weight(.bold)).foregroundStyle(AgentPalette(scheme).muted)
        }
        .font(.system(size: 12, weight: .semibold)).foregroundStyle(AgentPalette(scheme).ink)
    }

    private var empty: some View {
        Text("এই project-এ এখনো asset নেই। Create থেকে বানান, অথবা Legacy থেকে যোগ করুন।")
            .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
            .frame(maxWidth: .infinity, alignment: .leading).padding(13).csGlass(scheme, corner: 14)
    }

    private var grid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            ForEach(model.visible) { asset in
                Button { selected = asset; CSHaptic.tap() } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        CSPhoto(url: CS.url(asset.previewUrl), ratio: 0.9)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        Text(asset.displayTitle).font(.system(size: 12.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(1)
                        Text("\(asset.folder) · v\(asset.versions.count) · \(asset.status ?? "")").font(.system(size: 10)).foregroundStyle(AgentPalette(scheme).muted).lineLimit(1)
                        if !asset.tags.isEmpty {
                            Text(asset.tags.map { "#\($0.name)" }.joined(separator: " ")).font(.system(size: 10)).foregroundStyle(AgentPalette.coralLt).lineLimit(1)
                        }
                    }
                    .padding(9).csGlass(scheme, corner: 15)
                }.buttonStyle(.plain)
            }
        }
    }

    private var legacySheet: some View {
        NavigationStack {
            ZStack {
                AgentAuroraBackground().ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Original job/data অক্ষত থাকবে; project record ও version snapshot তৈরি হবে।")
                            .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
                        if model.legacyLoading { ProgressView().frame(maxWidth: .infinity).padding() }
                        else if model.legacy.isEmpty { Text("Legacy-তে attach করার মতো asset নেই").font(.caption).foregroundStyle(AgentPalette(scheme).muted) }
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                            ForEach(model.legacy) { item in
                                VStack(alignment: .leading, spacing: 6) {
                                    CSPhoto(url: CS.url(item.previewUrl), ratio: 0.9).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                    Text(item.displayTitle).font(.system(size: 12, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(1)
                                    Button("এই project-এ যোগ") { Task { await model.importLegacy(item) } }
                                        .font(.caption.weight(.bold)).buttonStyle(.borderedProminent).tint(AgentPalette.coral)
                                        .disabled(model.busy || item.pendingActionId == nil)
                                }.padding(9).csGlass(scheme, corner: 15)
                            }
                        }
                    }.padding(16)
                }
            }
            .navigationTitle("Legacy থেকে asset যোগ").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("বন্ধ") { legacyOpen = false } } }
        }
    }
}

@available(iOS 17.0, *)
private struct CSProjectAssetDetailSheet: View {
    let asset: CSProjectAsset
    let model: CSProjectAssetLibraryVM
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var folder: String
    @State private var tags: String

    init(asset: CSProjectAsset, model: CSProjectAssetLibraryVM) {
        self.asset = asset
        self.model = model
        _folder = State(initialValue: asset.folder)
        _tags = State(initialValue: asset.tags.map(\.name).joined(separator: ", "))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AgentAuroraBackground().ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        CSPhoto(url: CS.url(asset.versions.first?.previewUrl ?? asset.previewUrl), ratio: 0.9)
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        Text(asset.displayTitle).font(.headline).foregroundStyle(AgentPalette(scheme).ink)
                        if !model.project.readonly {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Folder ও tag").font(.caption.weight(.bold)).foregroundStyle(AgentPalette(scheme).muted)
                                TextField("Folder", text: $folder).textFieldStyle(.roundedBorder)
                                TextField("approved, eid, hero", text: $tags).textFieldStyle(.roundedBorder)
                                Button("সেভ") { Task { if let _ = await model.saveMetadata(asset: asset, folder: folder, tags: tags) { dismiss() } } }
                                    .buttonStyle(.borderedProminent).tint(AgentPalette.coral).disabled(model.busy || folder.trimmingCharacters(in: .whitespaces).isEmpty)
                            }.padding(13).csGlass(scheme, corner: 15)
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Version history & lineage").font(.caption.weight(.bold)).foregroundStyle(AgentPalette(scheme).muted)
                            if asset.versions.isEmpty { Text("এখনো version নেই").font(.caption).foregroundStyle(AgentPalette(scheme).muted) }
                            ForEach(asset.versions) { v in
                                VStack(alignment: .leading, spacing: 3) {
                                    HStack { Text("v\(v.version)").font(.caption.weight(.bold)); Spacer(); Text(v.createdAt.map { String($0.prefix(10)) } ?? "").font(.caption2).foregroundStyle(AgentPalette(scheme).muted) }
                                    fact("Recipe", v.recipeName.map { "\($0) · v\(v.recipeVersion ?? 1)" } ?? "Legacy / none")
                                    fact("Provider / engine", "\(v.provider ?? "—") / \(v.engine ?? "—")")
                                    fact("Job", v.jobId ?? "—")
                                    fact("Cost", "৳\(almaBn(Int((v.costBdt ?? 0).rounded())))" + (v.costUsd.map { String(format: " · $%.4f", $0) } ?? ""))
                                }
                                .padding(10).background(Color.white.opacity(scheme == .dark ? 0.04 : 0.35), in: RoundedRectangle(cornerRadius: 12))
                            }
                        }.padding(13).csGlass(scheme, corner: 15)
                    }.padding(16)
                }
            }
            .navigationTitle("Asset").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("বন্ধ") { dismiss() } } }
        }
    }

    private func fact(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top) {
            Text(k).foregroundStyle(AgentPalette(scheme).muted); Spacer(minLength: 10)
            Text(v).multilineTextAlignment(.trailing).lineLimit(2).foregroundStyle(AgentPalette(scheme).ink)
        }.font(.caption2)
    }
}

// MARK: - Canvas preset (web project setup step 2)

struct CSCanvasInput: Encodable, Equatable {
    let width: Int; let height: Int; let aspectWidth: Int; let aspectHeight: Int
    static func from(width w: Int, height h: Int) -> CSCanvasInput {
        let width = max(64, min(16_384, w)), height = max(64, min(16_384, h))
        func gcd(_ a: Int, _ b: Int) -> Int { b == 0 ? a : gcd(b, a % b) }
        let d = gcd(width, height)
        var aw = width / d, ah = height / d
        let m = max(aw, ah)
        if m > 100 { let s = 100.0 / Double(m); aw = max(1, Int((Double(aw) * s).rounded())); ah = max(1, Int((Double(ah) * s).rounded())) }
        return .init(width: width, height: height, aspectWidth: aw, aspectHeight: ah)
    }
}

@available(iOS 17.0, *)
struct CSCanvasPresetSheet: View {
    let projectName: String
    let onChoose: (CSCanvasInput) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var preset = "4:5"
    @State private var customW = 1080
    @State private var customH = 1350

    private let presets: [(id: String, label: String, w: Int, h: Int)] = [
        ("4:5", "Portrait", 1080, 1350), ("1:1", "Square", 1080, 1080),
        ("9:16", "Story / Reel", 1080, 1920), ("16:9", "Landscape", 1920, 1080),
    ]
    private var canvas: CSCanvasInput {
        if let p = presets.first(where: { $0.id == preset }) { return .init(width: p.w, height: p.h, aspectWidth: Int(p.id.split(separator: ":")[0])!, aspectHeight: Int(p.id.split(separator: ":")[1])!) }
        return .from(width: customW, height: customH)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AgentAuroraBackground().ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("CANVAS SETUP").font(.system(size: 10, weight: .bold)).tracking(1.2).foregroundStyle(AgentPalette.coralLt)
                            Text(projectName).font(.headline).foregroundStyle(AgentPalette(scheme).ink)
                            Text("Standard preset বা exact custom dimension — এই ধাপে কোনো upload/generate/খরচ নেই।")
                                .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
                        }.padding(14).csGlass(scheme, corner: 16)
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                            ForEach(presets, id: \.id) { p in presetCard(p.id, p.label, "\(p.w) × \(p.h)") }
                            presetCard("custom", "Custom size", "\(customW) × \(customH)")
                        }
                        if preset == "custom" {
                            HStack(spacing: 10) {
                                Stepper("W \(customW)", value: $customW, in: 64...16_384, step: 8)
                                Stepper("H \(customH)", value: $customH, in: 64...16_384, step: 8)
                            }.font(.caption.weight(.semibold)).padding(13).csGlass(scheme, corner: 14)
                        }
                        HStack {
                            Text("\(canvas.width) × \(canvas.height) px · \(canvas.aspectWidth):\(canvas.aspectHeight)")
                                .font(.caption.weight(.bold)).foregroundStyle(AgentPalette(scheme).ink)
                            Spacer()
                            Button("Canvas খুলুন") { onChoose(canvas); dismiss() }
                                .buttonStyle(.borderedProminent).tint(AgentPalette.coral)
                        }
                    }.padding(16)
                }
            }
            .navigationTitle("Versioned canvas").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("বাতিল") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func presetCard(_ id: String, _ label: String, _ meta: String) -> some View {
        Button { preset = id; CSHaptic.tap() } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(id).font(.system(size: 10.5, weight: .black)).foregroundStyle(preset == id ? .white : AgentPalette.coralLt)
                Text(label).font(.system(size: 13.5, weight: .bold)).foregroundStyle(preset == id ? .white : AgentPalette(scheme).ink)
                Text(meta).font(.system(size: 10.5)).foregroundStyle(preset == id ? .white.opacity(0.8) : AgentPalette(scheme).muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background {
                if preset == id { RoundedRectangle(cornerRadius: 14, style: .continuous).fill(CS.cta) }
                else { RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(scheme == .dark ? 0.05 : 0.4)) }
            }
        }.buttonStyle(.plain)
    }
}
