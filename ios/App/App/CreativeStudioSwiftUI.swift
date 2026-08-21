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
//    POST /api/assistant/creative-studio/reference-upload → scoped { id, path }
//    POST /api/assistant/creative-studio/run              → { message, jobs, provider }
//
//  Verify (page session cannot build the app — pbxproj frozen):
//    xcrun swiftc -typecheck -sdk $(xcrun --sdk iphonesimulator --show-sdk-path) \
//      -target arm64-apple-ios17.0-simulator ios/App/App/CreativeStudioSwiftUI.swift \
//      ios/App/App/{AlmaAPI,ClaudeTopFade,AssistantSwiftUI,SpikeNativeShell}.swift …
//

import SwiftUI
import PhotosUI
import AVKit

// MARK: - Wire models (mirror studio-api.ts; all optional so shape drift never fails a decode)

/// Registry availability snapshot for one engine (mirrors `EngineAvailability`).
struct CSEngineAvailability: Decodable, Equatable, Identifiable {
    let id: String
    let label: String?
    let labelBn: String?
    let status: String?
    let configured: Bool?
    let enabled: Bool?
    let runnable: Bool?
    let killed: Bool?
    let singlePersonOnly: Bool?
    let approxCost: String?
    let warningBn: String?
    /// Same truth as the web `engineIsSelectable`.
    var selectable: Bool { configured == true && enabled == true && runnable == true && killed != true }
}

struct CSGenericImageModels: Decodable, Equatable { let standard: String?; let pro: String? }

struct CSStudioConfig: Decodable, Equatable {
    let fashnConfigured: Bool?
    let geminiConfigured: Bool?
    let veoConfigured: Bool?
    let falConfigured: Bool?
    let xaiConfigured: Bool?
    let organization: String?
    let engines: [CSEngineAvailability]?
    let singleVtonDefault: String?
    let genericImageModels: CSGenericImageModels?

    func engine(_ id: String) -> CSEngineAvailability? { engines?.first { $0.id == id } }
    func isSelectable(_ id: String) -> Bool {
        if let e = engine(id) { return e.selectable }
        // Older config payloads (no registry) — fall back to the configured flags.
        switch id {
        case "fashn": return fashnConfigured == true
        case "gemini": return geminiConfigured == true
        case "xai_imagine": return xaiConfigured == true
        case "fal_fashn_v16", "fal_idm_vton", "fal_flux_fill": return falConfigured == true
        default: return false
        }
    }
    var liveEngineCount: Int { engines?.filter(\.selectable).count ?? 0 }
}

/// Decoded-byte evidence for an artifact (mirrors `StudioArtifactDescriptor`).
struct CSArtifactDescriptor: Decodable, Equatable {
    let kind: String?
    let storagePath: String?
    let width: Int?
    let height: Int?
    let format: String?
    let byteSize: Int?
    let requestedTier: String?
    let requestedAspectRatio: String?
    var dimensionLabel: String? {
        guard let width, let height else { return nil }
        return "\(width)×\(height)" + (format.map { " · \($0.uppercased())" } ?? "")
    }
}

struct CSReferenceReceipt: Decodable, Equatable {
    let expectedCount: Int
    let sentCount: Int
    let roles: [String]
    let allRequiredSent: Bool
}

struct CSCoverOption: Decodable, Equatable {
    let path: String
    let url: String?
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
    let archivedToDrive: Bool?
    let modelCreator: String?
    let coverOptions: [CSCoverOption]?
    let error: String?
    // Current-production V4 lineage/lifecycle metadata. Optional keeps legacy jobs
    // decodable while canonical project assets expose truthful review state.
    let projectAssetId: String?
    let assetVersionId: String?
    let projectId: String?
    let brandProfileId: String?
    let assetState: String?
    let reviewState: String?
    let archived: Bool?
    let publishable: Bool?
    let aspectRatio: String?
    let costBdt: Double?
    let costUsd: Double?
    let reviewSequence: Int?
    let engine: String?
    let imageModel: String?
    let qcDetailsBn: String?
    let originalVariant: CSArtifactDescriptor?
    let referenceReceipt: CSReferenceReceipt?
    /// Last finishing inputs (hook/code/theme/layout…) — editor reopens pre-filled.
    let finishParams: CSFinishParams?

    var imageURL: URL? { CS.url(thumbUrl ?? previewUrl ?? brandedUrl) }
    /// Scoped original-download route (web `scopedDownloadUrl`) — only when the
    /// canonical lineage tuple is present; otherwise the preview URL is used.
    var scopedDownloadURL: URL? {
        guard let brandProfileId, let projectId, let projectAssetId, let assetVersionId,
              let reviewSequence else { return nil }
        var parts = URLComponents(url: AlmaAPI.baseURL, resolvingAgainstBaseURL: false)
        parts?.path = "/api/assistant/creative-studio/gallery/download"
        parts?.queryItems = [
            .init(name: "id", value: id), .init(name: "brandProfileId", value: brandProfileId),
            .init(name: "projectId", value: projectId), .init(name: "projectAssetId", value: projectAssetId),
            .init(name: "assetVersionId", value: assetVersionId), .init(name: "reviewSequence", value: String(reviewSequence)),
        ]
        return parts?.url
    }
    /// Gallery "Lifecycle" lane, same mapping as the web `libraryItemFromGallery`.
    var lifecycleBn: String {
        if archived == true { return "Archived" }
        if reviewState == "approved" { return "Approved" }
        if reviewState == "changes_requested" || reviewState == "revised" || reviewState == "draft" { return "Review" }
        return "Recent"
    }
    var previewURL: URL? { CS.url(previewUrl) }
    var brandedURL: URL? { CS.url(brandedUrl) }
    var isVideo: Bool { type == "video_gen" || type == "video_edit" || (storagePath?.hasSuffix(".mp4") ?? false) }
    var isAudio: Bool { type == "audio_gen" }
    var isExecuted: Bool { status == "executed" }
    // mirror web isPendingStatus / isFailedStatus
    var isPending: Bool { status == "approved" || status == "pending" || status == "processing" }
    var isFailed: Bool { status == "failed" || status == "error" || status == "rejected" }
    var title: String { (summary?.isEmpty == false ? summary : nil) ?? CS.modeLabel(mode) }
    var modeLabel: String { CS.modeLabel(mode) }
}

struct CSGalleryResponse: Decodable { let items: [CSGalleryItem]; let hasMore: Bool?; let total: Int?; let nextCursor: String? }

struct CSModel: Decodable, Identifiable, Equatable {
    let id: String
    let name: String?
    let role: String?
    let isDefault: Bool?
    let imageUrl: String?
    /// Storage path of the identity reference (web `imagePath`) — what runs accept as a start frame.
    let imagePath: String?
    var imageURL: URL? { CS.url(imageUrl) }
}
struct CSModelsResponse: Decodable { let models: [CSModel] }

struct CSUploadResponse: Decodable { let path: String?; let storagePath: String?; let url: String? }
struct CSReferenceUploadResponse: Decodable { let id: String; let path: String }
struct CSUploadResult { let path: String; let referenceId: String? }

struct CSProjectProduct: Decodable {
    let code: String
    let name: String?
    let priceBdt: Double?
    let sourceImage: String?
    /// Renderable signed URL (web `previewImage`); `sourceImage` is the storage path sent on runs.
    let previewImage: String?
    var previewURL: URL? {
        // previewImage is either a signed URL or the app-relative product-preview route.
        if let previewImage, !previewImage.isEmpty { return CS.url(previewImage) }
        if let sourceImage, sourceImage.hasPrefix("http"), let u = URL(string: sourceImage) { return u }
        return nil
    }
}
struct CSProjectRecipe: Decodable {
    let id: String
    let name: String
    let version: Int?
    let locked: Bool?
}
struct CSProjectSummary: Decodable, Identifiable {
    let id: String
    let name: String
    let readonly: Bool
    let brandProfileId: String?
    let product: CSProjectProduct?
    let description: String?
    let assetCount: Int?
    let currentRecipeId: String?
    let currentRecipe: CSProjectRecipe?
    let defaultFolder: String?
    let updatedAt: String?
    /// Renderable preview of the linked ERP product — the authenticated
    /// product-preview route (web `hydrateStudioProjectProducts`) when the source is a
    /// private storage path, else the product's own signed/remote URL.
    var productPreviewURL: URL? {
        guard let product else { return nil }
        if let direct = product.previewURL { return direct }
        guard let source = product.sourceImage, !source.hasPrefix("/"), let brandProfileId else { return nil }
        var parts = URLComponents(url: AlmaAPI.baseURL, resolvingAgainstBaseURL: false)
        parts?.path = "/api/assistant/creative-studio/projects/\(id)/product-preview"
        parts?.queryItems = [.init(name: "brandProfileId", value: brandProfileId)]
        return parts?.url
    }
}
struct CSProjectsResponse: Decodable { let projects: [CSProjectSummary] }

/// Signed selection the server pins to an estimate receipt.
struct CSRunSelection: Decodable {
    let mode: String?
    let architecture: String?
    let provider: String?
    let model: String?
    let paidAttemptLimit: Int?
}

struct CSRunResponse: Decodable, Identifiable {
    let message: String?
    let provider: String?
    let actualModel: String?
    let error: String?
    let receipt: String?
    let receiptId: String?
    let confirmBy: String?
    let estimateBdt: Double?
    let estimateUsd: Double?
    let maxCostBdt: Double?
    let selection: CSRunSelection?
    var id: String { receiptId ?? "run-response" }

    /// Owner-facing confirmation copy (engine · exact model · QC attempts · expiry).
    var confirmationBody: String {
        let bdt = estimateBdt ?? maxCostBdt ?? 0
        let usd = estimateUsd ?? 0
        var lines = [String(format: "Server estimate ৳%.0f ($%.3f) · hard cap ৳%.0f", bdt, usd, maxCostBdt ?? bdt)]
        if let p = selection?.provider ?? provider { lines.append("Engine: \(p)") }
        if let m = selection?.model ?? actualModel { lines.append("Model: \(m)") }
        if let a = selection?.paidAttemptLimit { lines.append("QC: সর্বোচ্চ \(almaBn(a))টি paid attempt") }
        if let confirmBy, let date = ISO8601DateFormatter.csFlexible(confirmBy) {
            let f = DateFormatter(); f.dateFormat = "h:mm a"; f.timeZone = TimeZone(identifier: "Asia/Dhaka")
            lines.append("Receipt শেষ: \(f.string(from: date))")
        }
        lines.append("Queued ≠ complete — Gallery-তে verified state দেখুন।")
        return lines.joined(separator: "\n")
    }
}

extension ISO8601DateFormatter {
    static func csFlexible(_ raw: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = iso.date(from: raw) { return d }
        iso.formatOptions = [.withInternetDateTime]
        return iso.date(from: raw)
    }
}

struct CSMaskUploadResponse: Decodable, Equatable {
    let maskPath: String
    let width: Int
    let height: Int
    let coveragePct: Double
    let estimatedCostUsd: Double?
}

/// Manual run payload — nil keys are omitted (matches the web's undefined-omit).
/// AlmaAPI's JSONEncoder skips nil optionals by default, so plain Encodable works.
struct CSRunPayload: Encodable {
    var mode: String
    var provider: String?
    var vtonEngine: String?
    var productImagePath: String?
    var modelImagePath: String?
    var sourceImagePath: String?
    var secondSourceImagePath: String?
    var modelId: String?
    var familyPreset: String?
    var prompt: String?
    var backgroundPrompt: String?
    var aspectRatio: String?
    var resolution: String?
    var generationMode: String?
    var vibe: String?
    var numImages: Int?
    var durationSec: Int?
    var productReferenceId: String?
    var modelReferenceId: String?
    var sourceAssetIds: [String]?
    var sourcePendingActionId: String?
    var maskPath: String?
    var maskPreset: String?
    var baseWidth: Int?
    var baseHeight: Int?
    var brandProfileId: String?
    var projectId: String?
    var productId: String?
    var studioSurface: String? = "legacy"
    var intent: String?
    var receipt: String?
    var confirmed: Bool?
    var idempotencyKey: String?
    var maxCostBdt: Double?
}

/// Auto run — one-tap: server picks default model / prompt / background.
struct CSAutoRunPayload: Encodable {
    var auto = true
    var mode = "try_on"
    var productImagePath: String
    var includeFamily: Bool
    var includeReel: Bool
    var modelId: String?
    var productReferenceId: String?
    var brandProfileId: String?
    var projectId: String?
    var productId: String?
    var studioSurface: String? = "legacy"
    var intent: String?
    var receipt: String?
    var confirmed: Bool?
    var idempotencyKey: String?
    var maxCostBdt: Double?
}

// ── Finishing (logo + code + hook, applyBrandFrame) ─────────────────────────
struct CSFinishPayload: Encodable {
    var storagePath: String
    var hook: String
    var productCode: String?
    var productName: String?
    var price: String?
    var eyebrow: String?
    var offer: String?
    var mode: String?          // lifestyle | model_overlay | product_card
    var theme: String?
    var footer: Bool?
    var fit: String?           // cover | contain
    var pendingActionId: String?
    /// Editor geometry overrides (lifestyle only) — see CSLifestyleEditorSwiftUI.
    var layout: CSLayoutOverridesData? = nil
}
struct CSFinishResponse: Decodable { let framedPath: String?; let framedUrl: String? }

struct CSBrandStatus: Decodable {
    let hasLogo: Bool?
    let logoUrl: String?
    let themes: [String]?
    let brandName: String?
}

// ── Video studio (Phase V1-V3) ───────────────────────────────────────────────
struct CSVideoUpload: Decodable, Identifiable, Equatable {
    let id: String
    let path: String
    let name: String
    let sizeBytes: Int?
    let uploadedAt: String?
}
struct CSVideoUploadsResponse: Decodable { let uploads: [CSVideoUpload]? }

struct CSVideoProgress: Decodable, Equatable { let step: Int?; let total: Int?; let labelBn: String? }
struct CSVideoJobStatus: Decodable, Equatable {
    let id: String?
    let status: String?
    let summary: String?
    let previewUrl: String?
    let storagePath: String?
    let videoProgress: CSVideoProgress?
    let error: String?
}

// Production V4 Timeline Lite wire contract. Keep these concrete instead of
// `[String: AnyEncodable]`: the server owns the same versioned shape and forces
// `preserveVisualSource`/safe-zone truth before the free ffmpeg rerender queues.
struct CSVideoTimelineSegment: Codable, Identifiable, Equatable {
    var id: String
    var startSec: Double
    var endSec: Double
    var order: Int
}

struct CSVideoCrop: Codable, Equatable {
    var aspect: String
    var focusX: Double
    var focusY: Double
    var safeZone: Bool
}

struct CSVideoVolumes: Codable, Equatable {
    var original: Double
    var music: Double
    var voiceover: Double
}

struct CSVideoTranscriptCue: Codable, Identifiable, Equatable {
    var id: String
    var track: String       // caption | voiceover
    var startSec: Double
    var endSec: Double
    var text: String
}

struct CSVideoCoverPoint: Codable, Equatable { var atSec: Double }

struct CSVideoEditContract: Codable, Equatable {
    var version: Int
    var sourceDurationSec: Double
    var preserveVisualSource: Bool
    var segments: [CSVideoTimelineSegment]
    var crop: CSVideoCrop
    var volumes: CSVideoVolumes
    var captionPlacement: String
    var transcript: [CSVideoTranscriptCue]
    var cover: CSVideoCoverPoint
    var rerender: [String]

    static let cropAspects = ["original", "9:16", "4:5", "1:1", "16:9"]
    static let captionPlacements = ["top", "center", "bottom"]
    static let renderTracks = ["visual", "captions", "audio", "cover"]

    static func fresh(durationSec: Double) -> CSVideoEditContract {
        let duration = min(7_200, max(0.5, durationSec.isFinite ? durationSec : 15))
        return CSVideoEditContract(
            version: 1,
            sourceDurationSec: duration,
            preserveVisualSource: true,
            segments: [.init(id: "clip-1", startSec: 0, endSec: duration, order: 0)],
            crop: .init(aspect: "original", focusX: 0.5, focusY: 0.5, safeZone: true),
            volumes: .init(original: 1, music: 0.35, voiceover: 1),
            captionPlacement: "bottom",
            transcript: [],
            cover: .init(atSec: min(0.5, duration)),
            rerender: renderTracks)
    }

    var editedDurationSec: Double {
        segments.reduce(0) { $0 + max(0, $1.endSec - $1.startSec) }
    }

    /// Older persisted drafts may predate unique cue IDs. Repair only editor
    /// identity fields locally so SwiftUI never aliases two editable rows.
    mutating func ensureStableEditorIDs() {
        var segmentIDs = Set<String>()
        for index in segments.indices {
            let id = segments[index].id.trimmingCharacters(in: .whitespacesAndNewlines)
            if id.isEmpty || segmentIDs.contains(id) {
                segments[index].id = "clip-\(UUID().uuidString)"
            }
            segmentIDs.insert(segments[index].id)
        }
        var cueIDs = Set<String>()
        for index in transcript.indices {
            let id = transcript[index].id.trimmingCharacters(in: .whitespacesAndNewlines)
            if id.isEmpty || cueIDs.contains(id) {
                transcript[index].id = "cue-\(UUID().uuidString)"
            }
            cueIDs.insert(transcript[index].id)
        }
    }

    /// Mirrors the server's rejection boundaries so invalid drafts never queue.
    /// The route still re-parses and clamps every value authoritatively.
    var validationMessage: String? {
        guard version == 1, preserveVisualSource else { return "এই edit contract version support করা যাচ্ছে না" }
        guard sourceDurationSec.isFinite, (0.5...7_200).contains(sourceDurationSec) else {
            return "Source duration সঠিক নয়"
        }
        guard !segments.isEmpty else { return "অন্তত একটি clip রাখুন" }
        guard segments.count <= 32 else { return "সর্বোচ্চ ৩২টি clip রাখা যাবে" }
        guard Set(segments.map(\.id)).count == segments.count,
              Set(segments.map(\.order)).count == segments.count else {
            return "Clip order/ID duplicate হয়েছে"
        }
        for segment in segments {
            guard segment.startSec.isFinite, segment.endSec.isFinite,
                  segment.startSec >= 0, segment.endSec <= sourceDurationSec,
                  segment.endSec - segment.startSec >= 0.1 else {
                return "প্রতিটি clip source-এর ভেতরে অন্তত ০.১ সেকেন্ড হতে হবে"
            }
        }
        let outputDuration = editedDurationSec
        guard outputDuration <= 600 else { return "Edited video সর্বোচ্চ ১০ মিনিট হতে পারে" }
        guard Self.cropAspects.contains(crop.aspect),
              crop.focusX.isFinite, crop.focusY.isFinite,
              (0...1).contains(crop.focusX), (0...1).contains(crop.focusY) else {
            return "Crop/focus সঠিক নয়"
        }
        guard [volumes.original, volumes.music, volumes.voiceover]
            .allSatisfy({ $0.isFinite && (0...1).contains($0) }) else {
            return "Track volume ০–১০০% এর মধ্যে রাখুন"
        }
        guard Self.captionPlacements.contains(captionPlacement) else { return "Caption position সঠিক নয়" }
        guard transcript.count <= 100 else { return "সর্বোচ্চ ১০০টি transcript line রাখা যাবে" }
        guard Set(transcript.map(\.id)).count == transcript.count else {
            return "Transcript ID duplicate হয়েছে"
        }
        for cue in transcript {
            let clean = cue.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard ["caption", "voiceover"].contains(cue.track),
                  !clean.isEmpty, clean.count <= 240,
                  cue.startSec.isFinite, cue.endSec.isFinite,
                  cue.startSec >= 0, cue.endSec <= outputDuration,
                  cue.endSec - cue.startSec >= 0.1 else {
                return "প্রতিটি transcript line-এ লেখা ও সঠিক ০.১s+ timing দিন"
            }
        }
        guard !rerender.isEmpty, Set(rerender).isSubset(of: Set(Self.renderTracks)) else {
            return "অন্তত একটি valid render track বাছুন"
        }
        guard cover.atSec.isFinite, cover.atSec >= 0, cover.atSec <= outputDuration else {
            return "Cover point edited duration-এর মধ্যে রাখুন"
        }
        return nil
    }
}

struct CSVideoEditSource: Decodable, Equatable {
    let pendingActionId: String
    let durationSec: Double
    let sourcePath: String
    let editContract: CSVideoEditContract?
}

struct CSPartialVideoFinishResponse: Decodable {
    let pendingActionId: String
    let costBdt: Double?
    let preservedSourcePath: String?
    let rerender: [String]?
    let message: String?
}

struct CSSignedUploadURL: Decodable {
    let uploadUrl: String?
    let path: String?
    let uploadId: String?
    let contentType: String?
    let error: String?
}

struct CSMusicTrack: Decodable, Identifiable, Equatable {
    let id: String
    let path: String?
    let name: String
    let vibe: String?
    let sizeBytes: Int?
}
struct CSMusicResponse: Decodable { let tracks: [CSMusicTrack]? }

struct CSVideoRunJob: Decodable { let pendingActionId: String; let label: String?; let targetSec: Int? }
struct CSVideoRunResponse: Decodable { let jobs: [CSVideoRunJob]?; let message: String?; let error: String? }

// ── Audio Lab (E1) ───────────────────────────────────────────────────────────
struct CSAudioPreset: Decodable, Identifiable, Equatable { let id: String; let labelBn: String? }
struct CSAudioLabStatus: Decodable {
    let voiceCloned: Bool?
    let activeVoiceVersionId: String?
    let activeVoiceVersion: Int?
    let styles: [CSAudioPreset]?
    let occasions: [CSAudioPreset]?
}

/// Studio health (worker/turn-consumer state) — Home "Studio pulse".
struct CSStudioHealthLite: Decodable {
    struct Worker: Decodable { let state: String?; let labelBn: String?; let lastSeenBn: String? }
    let worker: Worker?
}

/// Owner voice (lifecycle registry) — Gallery "Voice" category.
struct CSVoiceLite: Decodable, Identifiable {
    struct Version: Decodable, Identifiable { let id: String; let version: Int; let status: String }
    let id: String
    let name: String
    let provider: String
    let activeVersionId: String?
    let versions: [Version]
}
struct CSVoicesLiteResponse: Decodable { let voices: [CSVoiceLite] }
struct CSAudioQueueResponse: Decodable { let pendingActionId: String?; let costBdt: Int?; let error: String? }
struct CSAudioEstimate: Decodable, Identifiable {
    let requiresConfirmation: Bool?
    let summary: String?
    let provider: String?
    let costBdt: Int
    let maxCostBdt: Int
    let ceilingUsd: Double?
    var id: String { "\(provider ?? "audio"):\(costBdt):\(maxCostBdt)" }
}

// ── Studio settings (CS4) ────────────────────────────────────────────────────
struct CSChildGarment: Decodable, Identifiable, Equatable {
    let key: String
    let role: String?
    let url: String?
    var id: String { key }
}
struct CSStudioSettings: Decodable {
    let qcLevel: String?
    let notifyOnDone: Bool?
    let imageEngine: String?
    let childGarments: [CSChildGarment]?
}

// MARK: - Static content (mirrors constants.ts)

enum CS {
    static func url(_ raw: String?) -> URL? {
        guard let raw, !raw.isEmpty else { return nil }
        if raw.hasPrefix("cs-asset:") { return URL(string: raw) }   // bundled sample image
        return URL(string: raw, relativeTo: AlmaAPI.baseURL)
    }

    struct Mode: Identifiable, Equatable {
        let id: String; let label: String; let bn: String; let icon: String
        let fashnOnly: Bool; let isVideo: Bool
        // input requirements — mirror STUDIO_MODES in constants.ts
        let needsProduct: Bool; let needsModel: Bool; let needsSource: Bool
    }
    static let modes: [Mode] = [
        .init(id: "generate", label: "Generate", bn: "জেনারেট", icon: "sparkles",
              fashnOnly: false, isVideo: false, needsProduct: false, needsModel: false, needsSource: false),
        .init(id: "product_to_model", label: "Product→Model", bn: "প্রোডাক্ট", icon: "hanger",
              fashnOnly: false, isVideo: false, needsProduct: true, needsModel: false, needsSource: false),
        .init(id: "try_on", label: "Try-On", bn: "ট্রাই-অন", icon: "person.fill",
              fashnOnly: false, isVideo: false, needsProduct: true, needsModel: true, needsSource: false),
        .init(id: "model_swap", label: "Model Swap", bn: "সোয়াপ", icon: "arrow.triangle.2.circlepath",
              fashnOnly: true, isVideo: false, needsProduct: false, needsModel: true, needsSource: true),
        .init(id: "face_to_model", label: "Face→Model", bn: "ফেস", icon: "face.smiling",
              fashnOnly: true, isVideo: false, needsProduct: false, needsModel: true, needsSource: false),
        .init(id: "edit", label: "Edit", bn: "এডিট", icon: "wand.and.stars",
              fashnOnly: true, isVideo: false, needsProduct: false, needsModel: false, needsSource: true),
        .init(id: "image_to_video", label: "Image→Video", bn: "রিল", icon: "video.fill",
              fashnOnly: false, isVideo: true, needsProduct: false, needsModel: false, needsSource: true),
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

    /// Which saved roles each family preset needs (mirror FAMILY_REQUIRED_ROLES in
    /// CreativeStudio.tsx) — drives the pre-Run checklist so missing models are
    /// visible up front instead of failing at Run time.
    static let familyRequiredRoles: [String: [String]] = [
        "father_son": ["father", "son"],
        "mother_son": ["mother", "son"],
        "mother_daughter": ["mother", "daughter"],
        "father_daughter": ["father", "daughter"],
        "couple": ["father", "mother"],
        "full_family": ["father", "mother", "son", "daughter"],
    ]
    static let modelRoles: [(id: String, bn: String)] = [
        ("single", "একক / নিজে"), ("father", "বাবা"), ("mother", "মা"),
        ("son", "ছেলে (৫–১২)"), ("daughter", "মেয়ে (৫–১০)"),
    ]
    static func roleBn(_ role: String?) -> String {
        modelRoles.first { $0.id == role }?.bn ?? (role ?? "")
    }

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

    // ── Engine registry (mirror STUDIO_ENGINES + ADVANCED_ENGINE_CAPABILITIES) ──
    struct Engine: Identifiable, Equatable {
        let id: String; let label: String; let short: String
        /// Advanced modes this engine can run (exact capability table, not inferred).
        let modes: Set<String>
        let singlePersonOnly: Bool
        let fidelityBn: [String: String]   // mode → limitation copy (optional)
    }
    static let engines: [Engine] = [
        .init(id: "fashn", label: "FASHN Pro (direct)", short: "FASHN",
              modes: ["product_to_model", "try_on", "model_swap", "face_to_model", "edit"], singlePersonOnly: true,
              fidelityBn: ["product_to_model": "নতুন pose/background তৈরি হবে; বাছাই করা ব্যক্তির পরিচয় face reference হিসেবে ব্যবহৃত হবে। একই pose রাখতে Try-On নিন।"]),
        .init(id: "gemini", label: "Guided image (owner-selected)", short: "Guided",
              modes: ["product_to_model", "try_on", "image_to_video"], singlePersonOnly: false,
              fidelityBn: ["product_to_model": "সাধারণ multi-image edit — রেফারেন্স পাঠানো হবে, তবে pixel-exact পরিচয়/পোশাক গ্যারান্টি নয়।",
                           "try_on": "সাধারণ multi-image edit — রেফারেন্স পাঠানো হবে, তবে pixel-exact পরিচয়/পোশাক গ্যারান্টি নয়।",
                           "image_to_video": "Veo একটি source still গ্রহণ করে; আলাদা product/person pair গ্রহণ করে না।"]),
        .init(id: "fal_fashn_v16", label: "Fal FASHN v1.6", short: "Fal v1.6",
              modes: ["try_on"], singlePersonOnly: true, fidelityBn: [:]),
        .init(id: "fal_idm_vton", label: "IDM-VTON (experimental)", short: "IDM-VTON",
              modes: ["try_on"], singlePersonOnly: true, fidelityBn: [:]),
        .init(id: "fal_flux_fill", label: "FLUX Fill (masked edit)", short: "FLUX Fill",
              modes: ["edit"], singlePersonOnly: false, fidelityBn: ["edit": "Mask repair — Gallery-র ছবিতে \"Precision repair\" থেকে চালান।"]),
        .init(id: "xai_imagine", label: "Grok Imagine (xAI)", short: "Grok",
              modes: ["generate", "product_to_model", "try_on"], singlePersonOnly: false,
              fidelityBn: ["product_to_model": "নির্বাচিত product/person ordered reference হিসেবে যাবে; Grok একটি general editor, dedicated Try-On নয়।"]),
    ]
    /// Engines offered for a mode (web: `engines` memo in StudioV3ImageLab). Multi-person
    /// family renders exclude single-person-only engines except the FASHN chain.
    static func engines(for mode: String, multiPerson: Bool) -> [Engine] {
        engines.filter { e in
            let familyChain = multiPerson && (e.id == "fashn" || e.id == "fal_fashn_v16")
            let supports = e.modes.contains(mode) || (familyChain && (mode == "product_to_model" || mode == "try_on"))
            return supports && !(multiPerson && e.singlePersonOnly && !familyChain)
        }
    }
    static func guidedModelLabel(_ model: String?) -> String {
        switch model {
        case "gpt-image-2": return "GPT Image 2"
        case "seedream-5.0-pro": return "Seedream 5 Pro"
        case "gemini-3.1-flash-image": return "Nano Banana 2"
        case "gemini-3-pro-image": return "Nano Banana Pro"
        default: return model ?? "Guided image"
        }
    }

    // ── Resolution contract (mirror resolution-contract.ts) ──────────────────
    struct ResolutionContract { let kind: String; let tiers: [String]; let aspects: [String]; let labelBn: String }
    static let resolutionContracts: [String: ResolutionContract] = [
        "fashn": .init(kind: "tiered", tiers: ["1k", "2k", "4k"], aspects: ["4:5", "1:1", "9:16", "16:9", "3:4"], labelBn: "FASHN নেটিভ রেজোলিউশন"),
        "fal_fashn_v16": .init(kind: "fixed", tiers: [], aspects: [], labelBn: "নেটিভ 864×1296"),
        "fal_idm_vton": .init(kind: "fixed", tiers: [], aspects: [], labelBn: "প্রোভাইডার নেটিভ সাইজ"),
        "fal_flux_fill": .init(kind: "source", tiers: [], aspects: [], labelBn: "সোর্স ছবির পিক্সেল"),
        "xai_imagine": .init(kind: "tiered", tiers: ["1k", "2k"], aspects: ["3:4", "1:1", "9:16", "16:9"], labelBn: "Grok Imagine নেটিভ 1K/2K"),
        "gemini": .init(kind: "tiered", tiers: ["1k", "2k", "4k"], aspects: ["4:5", "1:1", "9:16", "16:9", "3:4"], labelBn: "Gemini নেটিভ 1K/2K/4K"),
        "gpt": .init(kind: "tiered", tiers: ["1k", "2k", "4k"], aspects: ["4:5", "1:1", "9:16", "16:9", "3:4"], labelBn: "GPT Image 2 exact size"),
        "seedream": .init(kind: "tiered", tiers: ["1k", "2k"], aspects: ["4:5", "1:1", "9:16", "16:9", "3:4"], labelBn: "Seedream নেটিভ 1K/2K"),
    ]
    /// Final-image engine for the resolution contract (mirror resolveFinalStudioImageEngine).
    static func finalImageEngine(mode: String, engine: String, familyPreset: String, guided: String) -> String? {
        if mode == "image_to_video" { return nil }
        let vton = mode == "product_to_model" || mode == "try_on"
        let multi = vton && familyPreset != "single"
        if mode == "generate" || engine == "xai_imagine" { return "xai_imagine" }
        if multi { return guided }
        if mode == "try_on" {
            if engine == "fal_fashn_v16" || engine == "fal_idm_vton" { return engine }
            return guided
        }
        if mode == "product_to_model" { return engine == "gemini" ? guided : "fashn" }
        if engine == "gemini" { return guided }
        return engine
    }
    static func guidedEngineKey(_ imageEngine: String?) -> String {
        switch imageEngine { case "gpt": return "gpt"; case "seedream": return "seedream"; default: return "gemini" }
    }

    // ── Mask presets (exact ids from mask-contract.ts) ───────────────────────
    static let maskPresets: [(id: String, bn: String, hint: String)] = [
        ("replace_background", "ব্যাকগ্রাউন্ড বদলাও", "যে ব্যাকগ্রাউন্ড চান লিখুন (যেমন: warm studio, rooftop)"),
        ("remove_object", "অবজেক্ট/দাগ মুছাও", "কী মুছতে চান (ঐচ্ছিক)"),
        ("repair_hand", "হাত/ছোট জায়গা ঠিক করো", "কী ঠিক করতে হবে (ঐচ্ছিক)"),
        ("contact_shadow", "কন্টাক্ট শ্যাডো যোগ করো", "শ্যাডোর ধরন (ঐচ্ছিক)"),
        ("extend_canvas", "ক্যানভাস বাড়াও", "বাড়ানো অংশে কী থাকবে (ঐচ্ছিক)"),
        ("custom", "নিজের প্রম্পট", "ঠিক কী বদলাবেন — লিখতেই হবে"),
    ]
    /// Background presets WITH their prompts (mirror BACKGROUND_PRESETS in constants.ts).
    static let backgrounds: [(id: String, label: String, prompt: String)] = [
        ("studio", "Studio", "clean professional studio backdrop, soft even lighting"),
        ("outdoor_bd", "Outdoor BD", "Bangladeshi outdoor golden hour, natural street or greenery"),
        ("festival", "Festival", "warm festive Eid atmosphere, tasteful decor"),
        ("lifestyle", "Lifestyle", "relatable Bangladeshi cafe or home interior"),
        ("custom", "Custom", ""),
    ]
    /// 4–8 s = one Veo clip; 16/24 s = deterministic 2×/3× 8 s chain (web VideoLab).
    static let reelDurations = [4, 5, 6, 7, 8, 16, 24]
    static let reelChainDurations = [6, 16, 24]
    /// Client-safe mirror of reelCostBdt (Veo ≈ $0.15/s × 125 BDT/USD).
    static func reelCostBdt(_ seconds: Int) -> Int { Int((Double(seconds) * 0.15 * 125).rounded()) }
    static func longReelCostBdt(_ seconds: Int) -> Int {
        seconds >= 16 ? reelCostBdt(8) * Int((Double(seconds) / 8.0).rounded()) : reelCostBdt(seconds)
    }

    // ── Video recipe engine (mirror VIDEO_RECIPES / video-recipes.ts) ─────────
    struct VideoRecipe: Identifiable, Equatable {
        let id: String; let labelBn: String; let descriptionBn: String
        let targets: [Int]; let defaultTarget: Int
    }
    static let videoRecipes: [VideoRecipe] = [
        .init(id: "family_shoot", labelBn: "ফ্যামিলি শুট",
              descriptionBn: "বাবা-ছেলে / মা-মেয়ে ম্যাচিং শুট — ধীর গতি, নরম ক্রসফেড",
              targets: [15, 30, 60], defaultTarget: 30),
        .init(id: "product_showcase", labelBn: "প্রোডাক্ট শোকেস",
              descriptionBn: "প্রোডাক্ট ঘুরিয়ে দেখানো শুট — মাঝারি গতি, পরিষ্কার কাট",
              targets: [15, 30, 60], defaultTarget: 30),
        .init(id: "offer_promo", labelBn: "অফার প্রোমো",
              descriptionBn: "অফার/ঘোষণা — দ্রুত গতি, ঝটপট কাটে এনার্জি",
              targets: [15, 30], defaultTarget: 15),
    ]
    static let videoAspects: [(id: String, label: String)] =
        [("9:16", "রিল (9:16)"), ("1:1", "স্কয়ার (1:1)"), ("16:9", "ওয়াইড (16:9)")]
    static let audioModes: [(id: String, bn: String)] =
        [("original", "শুটের অডিও"), ("music", "শুধু মিউজিক"), ("music_duck", "কথা + মিউজিক")]
    static let musicVibes: [(id: String, bn: String)] =
        [("celebration", "উৎসব"), ("calm", "শান্ত"), ("energetic", "এনার্জেটিক")]
    static let voiceoverMaxChars = 220

    // ── Finishing themes (labels mirror FinishPanel's themeLabel) ─────────────
    static let finishThemes: [(id: String, bn: String)] =
        [("default", "সাধারণ"), ("eid", "ঈদ"), ("puja", "পূজা"), ("boishakh", "বৈশাখ"), ("winter", "শীত")]
    static let finishModes: [(id: String, bn: String)] =
        [("lifestyle", "পূর্ণ ছবি পোস্টার"), ("model_overlay", "ছবির উপর (overlay)"), ("product_card", "প্রোডাক্ট কার্ড")]

    /// Server 4xx bodies carry the owner-facing Bangla reason as {error} or {message}.
    static func serverMessage(_ body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return (obj["error"] as? String) ?? (obj["message"] as? String)
    }

    // ── Real ALMA storefront photos — inspiration/fallback so NO image slot is ever an
    //    empty grey box (offline / first run / before the live gallery loads). Replaced
    //    by the owner's real creatives the moment they arrive. ────────────────────────
    static let sampleBase = "https://awugvcjezittjjgfysuk.supabase.co/storage/v1/object/public"
    private static let sampleRows: [(mode: String, status: String, summary: String, path: String, video: Bool)] = [
        ("product_to_model", "executed", "ঈদ কাপল সিন",       "/homepage-images/community/6/1780392101632-b6vvu9e3.png", false),
        ("full_family",      "executed", "রয়্যাল পার্পল সেট",  "/homepage-images/family-matching/family-2/1780479017186-qquen24a.jpg", false),
        ("face_to_model",    "executed", "রুফটপ সানসেট",      "/homepage-images/community/2/1780392047620-hwhoa2rg.png", false),
        ("try_on",           "pending",  "ক্যাফে এডিটোরিয়াল",  "/homepage-images/community/3/1780392056751-e38xx8al.png", false),
        ("full_family",      "executed", "লেকসাইড ফ্যামিলি",   "/homepage-images/hero/1780374913900-5c2zmugf.png", false),
        ("full_family",      "executed", "গোল্ডেন ফ্লোরাল",    "/homepage-images/family-matching/family-3/1780479038063-d42lnr7m.jpg", false),
        ("try_on",           "executed", "মেরুন ঘরোয়া",        "/homepage-images/community/1/1780392035487-ajngphwl.png", false),
        ("full_family",      "pending",  "স্টিল ব্লু সেট",      "/homepage-images/family-matching/family-4/1780479054969-gzc3j1ky.jpg", false),
        ("image_to_video",   "executed", "টিল ফ্যামিলি রিল",    "/homepage-images/categories/panjabi/1780298751895-ohymdgcw.jpg", true),
        ("product_to_model", "executed", "গ্রিন ম্যাচিং সেট",   "/homepage-images/family-matching/family-1/1780478990705-ye50ig3w.jpg", false),
        ("product_to_model", "executed", "কোড ২২৩ · বাবা+ছেলে", "/product-images/family-sets/product-code-223/1780475637562-z0fkefqc.jpg", false),
        ("model_swap",       "executed", "কোড ৬০৯ · সেট",       "/product-images/family-sets/product-code-609/1780472405753-1gmn4wtn.jpg", false),
    ]
    private static func esc(_ s: String) -> String { s.replacingOccurrences(of: "\"", with: "\\\"") }
    static var sampleGallery: [CSGalleryItem] {
        // Point at BUNDLED sample photos (cs-asset:) so they render instantly, zero network.
        let items = sampleRows.enumerated().map { i, r in
            "{\"id\":\"sample-\(i)\",\"type\":\"\(r.video ? "video_gen" : "image")\",\"status\":\"\(r.status)\",\"summary\":\"\(esc(r.summary))\",\"mode\":\"\(r.mode)\",\"provider\":\"fashn\",\"previewUrl\":\"cs-asset:cs_sample_\(i)\",\"thumbUrl\":\"cs-asset:cs_sample_\(i)\"}"
        }.joined(separator: ",")
        return (try? JSONDecoder().decode([CSGalleryItem].self, from: Data("[\(items)]".utf8))) ?? []
    }
    static var sampleModels: [CSModel] {
        let rows: [(String, String, Bool)] = [
            ("আয়েশা", "female · 34 shot", true),
            ("রাফি", "male · 21 shot", false),
            ("তানভীর", "male · 18 shot", false),
            ("সাকিব", "male · 12 shot", false),
        ]
        let items = rows.enumerated().map { i, m in
            "{\"id\":\"sm-\(i)\",\"name\":\"\(esc(m.0))\",\"role\":\"\(esc(m.1))\",\"isDefault\":\(m.2),\"imageUrl\":\"cs-asset:cs_model_\(i)\"}"
        }.joined(separator: ",")
        return (try? JSONDecoder().decode(CSModelsResponse.self, from: Data("{\"models\":[\(items)]}".utf8)))?.models ?? []
    }

    /// The brand coral → rose CTA gradient (echoes the aura's coral→pink blobs).
    static var cta: LinearGradient {
        LinearGradient(colors: [Color(red: 0.96, green: 0.63, blue: 0.37),
                                Color(red: 0.85, green: 0.37, blue: 0.53)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    static let ctaGlow = Color(red: 0.91, green: 0.43, blue: 0.36).opacity(0.45)
}

enum CSTab: String, CaseIterable, Identifiable {
    case home, create, gallery, video, audio, library
    var id: String { rawValue }
    var bn: String {
        switch self {
        case .home: return "হোম"; case .create: return "তৈরি"; case .gallery: return "গ্যালারি"
        case .video: return "ভিডিও"; case .audio: return "অডিও"; case .library: return "লাইব্রেরি"
        }
    }
    var icon: String {
        switch self {
        case .home: return "house.fill"; case .create: return "sparkles"; case .gallery: return "photo.on.rectangle.angled"
        case .video: return "film.fill"; case .audio: return "waveform"; case .library: return "person.crop.circle.fill"
        }
    }
}

// MARK: - View model

@available(iOS 17.0, *)
@Observable
final class CreativeStudioVM {
    private struct VideoOwnerScope: Equatable {
        let brandProfileId: String
        let projectId: String
    }

    private enum PendingRun {
        case manual(CSRunPayload)
        case auto(CSAutoRunPayload)
    }
    private enum PendingAudio {
        case audio(label: String, body: [String: AnyEncodable])
        case voiceClone(name: String, samplePaths: [String])
    }

    var config: CSStudioConfig?
    var gallery: [CSGalleryItem] = []
    var models: [CSModel] = []
    var activeProject: CSProjectSummary?
    /// Writable, brand-scoped projects (the same list the web header project picker shows).
    var projects: [CSProjectSummary] = []
    var health: CSStudioHealthLite?
    var voices: [CSVoiceLite] = []
    /// Server cursor for "আরও লোড করুন" (web Gallery load-more).
    var galleryNextCursor: String?
    var galleryHasMore = false
    var galleryLoadingMore = false
    var galleryTotal = 0
    /// Gallery → Create hand-off ("এই ছবি থেকে নতুন তৈরি"): consumed once by the Advanced panel.
    var createSeed: CSGalleryItem?
    /// Home → Video hand-off (start-frame source for a generated reel).
    var reelSeed: CSGalleryItem?
    /// Set only from the system-owner-only unscoped projects response. A V4
    /// project selection alone is not role proof, so collaborators fail closed.
    private var verifiedVideoOwnerScope: VideoOwnerScope?
    var pendingEstimate: CSRunResponse?
    var pendingAudioEstimate: CSAudioEstimate?
    var loading = false
    var authExpired = false
    var generating = false
    /// Transient toast — auto-clears after 3.5s (a stuck pill covered the header
    /// in the build-66 self-test; every setter goes through this observer).
    var toast: String? {
        didSet {
            guard toast != nil else { return }
            toastClearTask?.cancel()
            let shown = toast
            toastClearTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 3_500_000_000)
                guard let self, !Task.isCancelled, self.toast == shown else { return }
                self.toast = nil
            }
        }
    }
    @ObservationIgnored private var toastClearTask: Task<Void, Never>?
    @ObservationIgnored private var pendingRun: PendingRun?
    @ObservationIgnored private var pendingAudio: PendingAudio?

    var galleryFilter = "all"   // all | image | video | audio | avatar | voice | approved | review | archived | executed | pending
    var gallerySearch = ""
    var galleryProvider = "all"
    var galleryAspect = "all"
    var gallerySort = "newest"  // newest | oldest | name | cost
    var galleryDensity = "compact" // compact | comfortable | list
    /// Server only knows newest/oldest; name/cost sort is client-side (web parity).
    private var serverOrder: String { gallerySort == "oldest" ? "oldest" : "newest" }

    // ── Video studio state ────────────────────────────────────────────────
    var videoUploads: [CSVideoUpload] = []
    var musicTracks: [CSMusicTrack] = []
    /// Local list of queued reel/finish jobs this session, polled for ধাপ N/M progress.
    var videoJobs: [(id: String, label: String, status: CSVideoJobStatus?)] = []

    // ── Library extras ────────────────────────────────────────────────────
    var settings: CSStudioSettings?
    var brandStatus: CSBrandStatus?
    var audioStatus: CSAudioLabStatus?

    var filteredGallery: [CSGalleryItem] {
        let lifecycleFiltered: [CSGalleryItem]
        switch galleryFilter {
        case "image": lifecycleFiltered = gallery.filter { !$0.isVideo && !$0.isAudio }
        case "video": lifecycleFiltered = gallery.filter { $0.isVideo }
        case "audio": lifecycleFiltered = gallery.filter { $0.isAudio }
        case "executed": lifecycleFiltered = gallery.filter { $0.isExecuted }
        case "pending": lifecycleFiltered = gallery.filter { !$0.isExecuted }
        case "approved": lifecycleFiltered = gallery.filter { $0.reviewState == "approved" }
        case "review": lifecycleFiltered = gallery.filter { $0.reviewState == "changes_requested" || $0.reviewState == "revised" || $0.reviewState == "draft" }
        case "archived": lifecycleFiltered = gallery.filter { $0.archived == true }
        default: lifecycleFiltered = gallery
        }
        let refined = lifecycleFiltered.filter { item in
            if galleryProvider != "all", item.provider != galleryProvider { return false }
            if galleryAspect != "all", item.aspectRatio != galleryAspect { return false }
            return true
        }
        switch gallerySort {
        case "name": return refined.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case "cost": return refined.sorted { ($0.costUsd ?? $0.costBdt.map { $0 / 125 } ?? -1) > ($1.costUsd ?? $1.costBdt.map { $0 / 125 } ?? -1) }
        default: return refined
        }
    }

    /// Ready (executed) still images — sources for reels, Create hand-off and Finishing.
    var readyImages: [CSGalleryItem] {
        gallery.filter { $0.isExecuted && !$0.isVideo && !$0.isAudio && $0.storagePath != nil && !$0.id.hasPrefix("sample-") }
    }
    var realModels: [CSModel] { models.filter { !$0.id.hasPrefix("sm-") } }
    var needsReviewCount: Int {
        gallery.filter { !$0.id.hasPrefix("sample-") && ($0.assetState == "qc_failed" || $0.assetState == "draft") }.count
    }

    var galleryProviders: [String] {
        Array(Set(gallery.compactMap(\.provider).filter { !$0.isEmpty } +
                  ["fashn", "gemini", "openai", "xai", "fal", "seedream"])).sorted()
    }

    var galleryAspects: [String] {
        Array(Set(gallery.compactMap(\.aspectRatio).filter { !$0.isEmpty } +
                  ["1:1", "3:4", "4:5", "9:16", "16:9"])).sorted()
    }

    private var shouldShowSampleGallery: Bool {
        gallerySearch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && galleryFilter == "all" && galleryProvider == "all" && galleryAspect == "all"
    }

    func loadAll() async {
        loading = true
        defer { loading = false }
        async let c: CSStudioConfig? = try? AlmaAPI.shared.get("/api/assistant/creative-studio/config")
        async let p: CSProjectsResponse? = try? AlmaAPI.shared.get("/api/assistant/creative-studio/projects")
        let (cfg, projects) = await (c, p)
        if let projects {
            let priorProjectID = activeProject?.id
            let writable = projects.projects.filter { !$0.readonly && $0.brandProfileId != nil }
            self.projects = writable
            activeProject = writable.first { $0.id == priorProjectID } ?? writable.first
            verifiedVideoOwnerScope = activeProject.flatMap(videoOwnerScope)
        } else {
            verifiedVideoOwnerScope = nil
        }
        var query = ["page": "1", "limit": "48"]
        if let project = activeProject, let brandProfileId = project.brandProfileId {
            query["brandProfileId"] = brandProfileId
            query["projectId"] = project.id
        }
        let search = gallerySearch.trimmingCharacters(in: .whitespacesAndNewlines)
        if !search.isEmpty { query["q"] = search }
        query["order"] = serverOrder
        applyLifecycleQuery(to: &query)
        let galleryQuery = query
        async let g: CSGalleryResponse? = try? AlmaAPI.shared.get(
            "/api/assistant/creative-studio/gallery", query: galleryQuery)
        async let m: CSModelsResponse? = try? AlmaAPI.shared.get(
            "/api/assistant/brand-models",
            query: activeProject.map { project in
                ["brandProfileId": project.brandProfileId ?? "", "projectId": project.id]
            } ?? [:])
        async let h: CSStudioHealthLite? = try? AlmaAPI.shared.get("/api/assistant/creative-studio/health")
        let (gal, mods, hl) = await (g, m, h)
        if let cfg { config = cfg }
        if let gal { gallery = gal.items; galleryNextCursor = gal.nextCursor; galleryHasMore = gal.hasMore ?? false; galleryTotal = gal.total ?? gal.items.count }
        if let mods { models = mods.models }
        if let hl { health = hl }
        authExpired = (cfg == nil && projects == nil && gal == nil)
        // Never show empty grey slots: fall back to real ALMA sample photos until the
        // owner's own creatives/models load. Replaced automatically when live data arrives.
        if gallery.isEmpty, shouldShowSampleGallery { gallery = CS.sampleGallery }
        if models.isEmpty { models = CS.sampleModels }
    }

    /// Paid-run inputs use the project-scoped reference endpoint so the server
    /// can prove product/model ownership before any provider call is made.
    func uploadImage(_ data: Data, folder: String, referenceKind: String? = nil) async throws -> CSUploadResult {
        if let referenceKind {
            guard let project = activeProject, let brandProfileId = project.brandProfileId else {
                throw AlmaAPIError.http(status: 422, body: "studio_run_scope_required")
            }
            let up: CSReferenceUploadResponse = try await AlmaAPI.shared.uploadMultipart(
                "/api/assistant/creative-studio/reference-upload", fileField: "file",
                filename: "photo.jpg", mime: "image/jpeg", data: data,
                fields: [
                    "brandProfileId": brandProfileId,
                    "projectId": project.id,
                    "kind": referenceKind,
                ])
            return CSUploadResult(path: up.path, referenceId: up.id)
        }

        // Non-generation uploads (finishing/model-library) keep their existing route.
        let up: CSUploadResponse = try await AlmaAPI.shared.uploadMultipart(
            "/api/assistant/upload", fileField: "file",
            filename: "photo.jpg", mime: "image/jpeg", data: data,
            fields: ["conversationId": folder])
        guard let path = up.path ?? up.storagePath ?? up.url else {
            throw AlmaAPIError.http(status: 422, body: "upload_failed")
        }
        return CSUploadResult(path: path, referenceId: nil)
    }

    func refreshGallery() async {
        let requestedProjectID = activeProject?.id
        var query = ["page": "1", "limit": "48"]
        if let project = activeProject, let brandProfileId = project.brandProfileId {
            query["brandProfileId"] = brandProfileId
            query["projectId"] = project.id
        }
        let search = gallerySearch.trimmingCharacters(in: .whitespacesAndNewlines)
        if !search.isEmpty { query["q"] = search }
        query["order"] = serverOrder
        if galleryProvider != "all" { query["provider"] = galleryProvider }
        if galleryAspect != "all" { query["aspectRatio"] = galleryAspect }
        applyLifecycleQuery(to: &query)
        if let g: CSGalleryResponse = try? await AlmaAPI.shared.get(
            "/api/assistant/creative-studio/gallery", query: query) {
            guard activeProject?.id == requestedProjectID else { return }
            gallery = g.items.isEmpty && shouldShowSampleGallery ? CS.sampleGallery : g.items
            galleryNextCursor = g.nextCursor
            galleryHasMore = g.hasMore ?? false
            galleryTotal = g.total ?? g.items.count
        }
    }

    /// Web "Load more production assets": append the next server page by cursor.
    func loadMoreGallery() async {
        guard galleryHasMore, !galleryLoadingMore, let cursor = galleryNextCursor else { return }
        galleryLoadingMore = true
        defer { galleryLoadingMore = false }
        var query = ["limit": "48", "cursor": cursor, "order": serverOrder]
        if let project = activeProject, let brandProfileId = project.brandProfileId {
            query["brandProfileId"] = brandProfileId
            query["projectId"] = project.id
        }
        let search = gallerySearch.trimmingCharacters(in: .whitespacesAndNewlines)
        if !search.isEmpty { query["q"] = search }
        if galleryProvider != "all" { query["provider"] = galleryProvider }
        if galleryAspect != "all" { query["aspectRatio"] = galleryAspect }
        applyLifecycleQuery(to: &query)
        let requestedProjectID = activeProject?.id
        guard let g: CSGalleryResponse = try? await AlmaAPI.shared.get(
            "/api/assistant/creative-studio/gallery", query: query) else { toast = "পরের পেজ আনা গেল না"; return }
        // A project switch mid-flight must not splice the old project's page into the new list.
        guard activeProject?.id == requestedProjectID, galleryNextCursor == cursor else { return }
        let known = Set(gallery.map(\.id))
        gallery.append(contentsOf: g.items.filter { !known.contains($0.id) })
        galleryNextCursor = g.nextCursor
        galleryHasMore = g.hasMore ?? false
    }

    /// Owner voices for the Gallery "Voice" lane (scope-filtered registry).
    func loadVoices() async {
        guard let project = activeProject, let brandID = project.brandProfileId else { voices = []; return }
        if let r: CSVoicesLiteResponse = try? await AlmaAPI.shared.get(
            "/api/assistant/creative-studio/voices", query: ["brandProfileId": brandID, "projectId": project.id]) {
            voices = r.voices
        }
    }

    private func applyLifecycleQuery(to query: inout [String: String]) {
        switch galleryFilter {
        case "approved": query["reviewState"] = "approved"
        case "review": query["reviewState"] = "draft,changes_requested,revised"
        case "archived": query["archived"] = "1"
        case "image": query["media"] = "image"
        case "video": query["media"] = "video"
        case "audio": query["media"] = "audio"
        default: break
        }
    }

    /// A V4 project choice is the same production scope used by Create, Gallery,
    /// saved identities, and every paid confirmation—not a workspace-only filter.
    func activateProject(_ project: CSProjectSummary) async {
        activeProject = project
        verifiedVideoOwnerScope = nil

        // The scoped V4 project list is intentionally available to creators and
        // reviewers. Re-prove owner role through the existing owner-only route;
        // a failed/forbidden lookup leaves video finishing unavailable.
        if let response: CSProjectsResponse = try? await AlmaAPI.shared.get(
            "/api/assistant/creative-studio/projects"),
           let verified = response.projects.first(where: {
               $0.id == project.id
                   && $0.brandProfileId == project.brandProfileId
                   && !$0.readonly
                   && $0.brandProfileId != nil
           }) {
            guard activeProject?.id == project.id,
                  activeProject?.brandProfileId == project.brandProfileId else { return }
            activeProject = verified
            verifiedVideoOwnerScope = videoOwnerScope(for: verified)
        }
        guard activeProject?.id == project.id,
              activeProject?.brandProfileId == project.brandProfileId else { return }
        await refreshGallery()
        guard activeProject?.id == project.id else { return }
        if let brandID = project.brandProfileId,
           let response: CSModelsResponse = try? await AlmaAPI.shared.get(
            "/api/assistant/brand-models", query: ["brandProfileId": brandID, "projectId": project.id]) {
            guard activeProject?.id == project.id else { return }
            models = response.models.isEmpty ? CS.sampleModels : response.models
        }
    }

    /// How many renders are still cooking — drives the banner + polling.
    var pendingCount: Int { gallery.filter { $0.isPending && !$0.id.hasPrefix("sample-") }.count }

    private func scope(_ payload: inout CSRunPayload) throws {
        guard let project = activeProject, let brandProfileId = project.brandProfileId else {
            throw AlmaAPIError.http(status: 422, body: "studio_run_scope_required")
        }
        payload.brandProfileId = brandProfileId
        payload.projectId = project.id
        payload.productId = project.product?.code
    }

    private func scope(_ payload: inout CSAutoRunPayload) throws {
        guard let project = activeProject, let brandProfileId = project.brandProfileId else {
            throw AlmaAPIError.http(status: 422, body: "studio_run_scope_required")
        }
        payload.brandProfileId = brandProfileId
        payload.projectId = project.id
        payload.productId = project.product?.code
    }

    private func showRunError(_ error: Error) {
        if let apiError = error as? AlmaAPIError {
            switch apiError {
            case .notAuthenticated:
                toast = "সেশন শেষ — আবার লগইন করুন"
                authExpired = true
            case let .http(_, body):
                toast = CS.serverMessage(body) ?? "জেনারেট করা গেল না"
            default:
                toast = "জেনারেট করা গেল না"
            }
            return
        }
        toast = "জেনারেট করা গেল না"
    }

    /// First request an exact, receipt-bound estimate. The view presents the
    /// owner confirmation before `confirmPendingRun()` can queue a paid job.
    func run(_ original: CSRunPayload) async -> Bool {
        guard !generating else { return false }
        generating = true
        defer { generating = false }
        do {
            var payload = original
            try scope(&payload)
            payload.intent = "estimate"
            payload.maxCostBdt = 500
            let estimate: CSRunResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/run", body: payload)
            guard estimate.receipt != nil, estimate.receiptId != nil else {
                throw AlmaAPIError.http(status: 422, body: "run_estimate_failed")
            }
            pendingRun = .manual(original)
            pendingEstimate = estimate
            return true
        } catch {
            showRunError(error)
        }
        return false
    }

    /// One-tap Auto still obeys the same estimate → explicit confirmation gate.
    func runAuto(productImagePath: String, productReferenceId: String?, modelId: String?, includeFamily: Bool, includeReel: Bool) async -> Bool {
        guard !generating else { return false }
        generating = true
        defer { generating = false }
        do {
            var payload = CSAutoRunPayload(
                productImagePath: productImagePath,
                includeFamily: includeFamily,
                includeReel: includeReel,
                modelId: modelId,
                productReferenceId: productReferenceId)
            try scope(&payload)
            payload.intent = "estimate"
            payload.maxCostBdt = 500
            let estimate: CSRunResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/run",
                body: payload)
            guard estimate.receipt != nil, estimate.receiptId != nil else {
                throw AlmaAPIError.http(status: 422, body: "run_estimate_failed")
            }
            pendingRun = .auto(payload)
            pendingEstimate = estimate
            return true
        } catch {
            showRunError(error)
        }
        return false
    }

    func cancelPendingRun() {
        pendingEstimate = nil
        pendingRun = nil
    }

    func confirmPendingRun(using estimate: CSRunResponse) async {
        guard !generating,
              let receipt = estimate.receipt, let receiptId = estimate.receiptId,
              let pendingRun else { return }
        generating = true
        defer { generating = false }
        do {
            let response: CSRunResponse
            switch pendingRun {
            case .manual(var payload):
                try scope(&payload)
                payload.intent = "confirm"
                payload.receipt = receipt
                payload.confirmed = true
                payload.idempotencyKey = "studio:\(receiptId)"
                payload.maxCostBdt = estimate.maxCostBdt
                response = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/creative-studio/run", body: payload)
            case .auto(var payload):
                try scope(&payload)
                payload.intent = "confirm"
                payload.receipt = receipt
                payload.confirmed = true
                payload.idempotencyKey = "studio:\(receiptId)"
                payload.maxCostBdt = estimate.maxCostBdt
                response = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/creative-studio/run", body: payload)
            }
            cancelPendingRun()
            toast = response.message ?? "জেনারেশন শুরু হয়েছে — গ্যালারিতে আসবে"
            await refreshGallery()
        } catch {
            showRunError(error)
        }
    }

    /// Production V4 precision finishing: the mask upload is a free preparation
    /// step, followed by the same signed estimate → explicit confirmation gate.
    func uploadRepairMask(_ data: Data, for item: CSGalleryItem) async throws -> CSMaskUploadResponse {
        guard let project = activeProject,
              let brandProfileId = project.brandProfileId,
              let projectAssetId = item.projectAssetId,
              let basePath = item.storagePath else {
            throw AlmaAPIError.http(status: 422, body: "mask_source_scope_required")
        }
        return try await AlmaAPI.shared.uploadMultipart(
            "/api/assistant/creative-studio/mask-upload", fileField: "mask",
            filename: "repair-mask.png", mime: "image/png", data: data,
            fields: [
                "basePath": basePath,
                "brandProfileId": brandProfileId,
                "projectId": project.id,
                "projectAssetId": projectAssetId,
                "pendingActionId": item.id,
            ])
    }

    func repairPayload(for item: CSGalleryItem, mask: CSMaskUploadResponse,
                       preset: String, detail: String) -> CSRunPayload? {
        guard let sourcePath = item.storagePath, let assetID = item.projectAssetId else { return nil }
        var payload = CSRunPayload(mode: "edit")
        // FLUX Fill is a Fal precision-edit engine, not the FASHN try-on API.
        // Keep provider unset so the server pins the explicit engine below.
        payload.provider = nil
        payload.vtonEngine = "fal_flux_fill"
        payload.sourceImagePath = sourcePath
        payload.sourceAssetIds = [assetID]
        payload.sourcePendingActionId = item.id
        payload.maskPath = mask.maskPath
        payload.maskPreset = preset
        payload.prompt = detail
        payload.baseWidth = mask.width
        payload.baseHeight = mask.height
        payload.studioSurface = "v3"
        do { try scope(&payload); return payload } catch { showRunError(error); return nil }
    }

    func estimateRepair(_ original: CSRunPayload) async -> CSRunResponse? {
        guard !generating else { return nil }
        generating = true; defer { generating = false }
        do {
            var payload = original
            try scope(&payload)
            payload.intent = "estimate"
            payload.maxCostBdt = 500
            let estimate: CSRunResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/run", body: payload)
            guard estimate.receipt != nil, estimate.receiptId != nil else {
                throw AlmaAPIError.http(status: 422, body: "run_estimate_failed")
            }
            return estimate
        } catch { showRunError(error); return nil }
    }

    func confirmRepair(_ original: CSRunPayload, estimate: CSRunResponse) async -> Bool {
        guard !generating, let receipt = estimate.receipt, let receiptID = estimate.receiptId else { return false }
        generating = true; defer { generating = false }
        do {
            var payload = original
            try scope(&payload)
            payload.intent = "confirm"
            payload.receipt = receipt
            payload.confirmed = true
            payload.idempotencyKey = "studio:\(receiptID)"
            payload.maxCostBdt = estimate.maxCostBdt
            let response: CSRunResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/run", body: payload)
            toast = response.message ?? "Precision repair queue হয়েছে — Gallery-তে progress দেখুন"
            await refreshGallery()
            return true
        } catch { showRunError(error); return false }
    }

    func flash(_ msg: String) { toast = msg }

    // ── Gallery item actions ─────────────────────────────────────────────────
    func retry(_ item: CSGalleryItem) async {
        do {
            let _: CSOK = try await AlmaAPI.shared.send("POST", "/api/assistant/creative-studio/jobs/\(item.id)/retry")
            toast = "আবার চালানো হচ্ছে, Boss"
            await refreshGallery()
        } catch { toast = "আবার চালানো গেল না" }
    }

    /// Generated reel (Veo) from a ready Gallery image or a saved avatar — the SAME signed
    /// estimate → owner confirmation gate as every paid run (the old direct POST was rejected
    /// by the server with `run_estimate_required`). 16/24 s = deterministic 2×/3× 8 s chain.
    func requestReel(sourcePath: String, sourceItem: CSGalleryItem? = nil, modelId: String? = nil,
                     prompt: String? = nil, vibe: String = "premium", aspect: String = "9:16",
                     seconds: Int) async -> Bool {
        var payload = CSRunPayload(mode: "image_to_video")
        payload.provider = "gemini"
        payload.sourceImagePath = sourcePath
        payload.sourcePendingActionId = sourceItem?.id
        payload.sourceAssetIds = sourceItem?.projectAssetId.map { [$0] }
        payload.modelId = modelId
        payload.prompt = prompt?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? prompt : nil
        payload.vibe = vibe
        payload.aspectRatio = aspect
        payload.durationSec = seconds
        payload.studioSurface = "v3"
        return await run(payload)
    }

    /// One-tap reel from a finished studio image (detail sheet) — estimate first.
    func reelFromImage(_ item: CSGalleryItem, seconds: Int) async -> Bool {
        guard let path = item.storagePath else { return false }
        return await requestReel(sourcePath: path, sourceItem: item, seconds: seconds)
    }

    func finishImage(_ payload: CSFinishPayload) async -> String? {
        do {
            let res: CSFinishResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/finish", body: payload)
            toast = "ফিনিশিং হয়ে গেছে ✅"
            await refreshGallery()
            return res.framedUrl
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "ব্যর্থ হলো" }
        catch { toast = "ফিনিশিং ব্যর্থ" }
        return nil
    }

    /// Delete a gallery creative for good (server removes files + row).
    func deleteItem(_ item: CSGalleryItem) async -> Bool {
        guard !item.id.hasPrefix("sample-") else { toast = "এটা স্যাম্পল ছবি — মোছার কিছু নেই"; return false }
        do {
            let _: CSOK = try await AlmaAPI.shared.send("DELETE", "/api/assistant/creative-studio/jobs/\(item.id)")
            gallery.removeAll { $0.id == item.id }
            if gallery.isEmpty { gallery = CS.sampleGallery }
            toast = "মুছে ফেলা হলো 🗑️"
            return true
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "মুছতে পারলাম না" }
        catch { toast = "মুছতে পারলাম না" }
        return false
    }

    func setReelCover(_ item: CSGalleryItem, coverPath: String) async {
        struct Body: Encodable { let pendingActionId: String; let coverPath: String }
        do {
            let _: CSOK = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/video/cover",
                body: Body(pendingActionId: item.id, coverPath: coverPath))
            toast = "কভার সেট হয়েছে"
        } catch { toast = "কভার সেট করা যায়নি" }
    }

    /// Canonical video actions are owner-scoped exactly like production V4.
    /// A gallery query value never grants access; the server re-proves this tuple.
    private func videoOwnerScope(for project: CSProjectSummary) -> VideoOwnerScope? {
        guard let brandProfileId = project.brandProfileId else { return nil }
        return VideoOwnerScope(brandProfileId: brandProfileId, projectId: project.id)
    }

    func canFinishVideo(_ item: CSGalleryItem) -> Bool {
        guard let project = activeProject,
              let brandProfileId = project.brandProfileId,
              item.projectAssetId != nil,
              item.projectId == project.id,
              item.brandProfileId == brandProfileId else { return false }
        return verifiedVideoOwnerScope == VideoOwnerScope(
            brandProfileId: brandProfileId, projectId: project.id)
    }

    private func videoScope(for item: CSGalleryItem) throws -> (
        brandProfileId: String, projectId: String, projectAssetId: String
    ) {
        guard let project = activeProject,
              let brandProfileId = project.brandProfileId,
              let projectAssetId = item.projectAssetId,
              item.projectId == project.id,
              item.brandProfileId == brandProfileId,
              verifiedVideoOwnerScope == VideoOwnerScope(
                  brandProfileId: brandProfileId, projectId: project.id) else {
            throw AlmaAPIError.http(status: 422, body: "studio_video_scope_required")
        }
        return (brandProfileId, project.id, projectAssetId)
    }

    /// GET validates owner access and returns the immutable source duration plus
    /// the latest persisted edit contract. No rendering or provider cost occurs.
    func fetchVideoEditSource(_ item: CSGalleryItem) async throws -> CSVideoEditSource {
        let scope = try videoScope(for: item)
        return try await AlmaAPI.shared.get(
            "/api/assistant/creative-studio/video/finish",
            query: [
                "pendingActionId": item.id,
                "brandProfileId": scope.brandProfileId,
                "projectId": scope.projectId,
                "projectAssetId": scope.projectAssetId,
            ])
    }

    /// V3/V4 motion-template finishing for a rendered reel.
    func finishVideo(_ item: CSGalleryItem, templates: [String: AnyEncodable]) async -> String? {
        struct Body: Encodable {
            let pendingActionId: String
            let templates: [String: AnyEncodable]
            let brandProfileId: String
            let projectId: String
            let projectAssetId: String
        }
        do {
            let scope = try videoScope(for: item)
            let res: CSPartialVideoFinishResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/video/finish",
                body: Body(
                    pendingActionId: item.id, templates: templates,
                    brandProfileId: scope.brandProfileId,
                    projectId: scope.projectId,
                    projectAssetId: scope.projectAssetId))
            toast = res.message ?? "টেমপ্লেট render queue হয়েছে · ৳0"
            return res.pendingActionId
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "ব্যর্থ হলো" }
        catch { toast = "টেমপ্লেট বসানো শুরু করা যায়নি" }
        return nil
    }

    /// Timeline Lite queues only the selected local ffmpeg tracks at zero cost.
    /// Server parsing remains authoritative and always preserves the visual source.
    func partiallyFinishVideo(_ item: CSGalleryItem, contract: CSVideoEditContract) async -> String? {
        struct Body: Encodable {
            let pendingActionId: String
            let mode = "partial_edit"
            let editContract: CSVideoEditContract
            let brandProfileId: String
            let projectId: String
            let projectAssetId: String
        }
        guard contract.validationMessage == nil else {
            toast = contract.validationMessage
            return nil
        }
        do {
            let scope = try videoScope(for: item)
            let res: CSPartialVideoFinishResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/video/finish",
                body: Body(
                    pendingActionId: item.id,
                    editContract: contract,
                    brandProfileId: scope.brandProfileId,
                    projectId: scope.projectId,
                    projectAssetId: scope.projectAssetId))
            toast = res.message ?? "বাছাই করা track render queue হয়েছে · ৳0"
            return res.pendingActionId
        } catch let AlmaAPIError.http(_, body) {
            toast = CS.serverMessage(body) ?? "Timeline edit শুরু করা যায়নি"
        } catch {
            toast = "Timeline edit শুরু করা যায়নি"
        }
        return nil
    }

    func fetchJob(_ id: String) async -> CSVideoJobStatus? {
        try? await AlmaAPI.shared.get("/api/assistant/creative-studio/jobs/\(id)")
    }

    /// CS4: save an AI-generated brand model portrait into the model library.
    func saveGeneratedModel(_ item: CSGalleryItem) async {
        guard let role = item.modelCreator, let path = item.storagePath else { return }
        struct Body: Encodable {
            let action = "add"; let id: String; let name: String; let imagePath: String; let role: String
        }
        do {
            let _: CSOK = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/brand-models",
                body: Body(id: "brand-\(role)", name: "ALMA \(role)", imagePath: path, role: role))
            toast = "মডেল লাইব্রেরিতে সেভ হয়েছে, Boss"
            if let m: CSModelsResponse = try? await AlmaAPI.shared.get("/api/assistant/brand-models") { models = m.models }
        } catch { toast = "সেভ হয়নি" }
    }

    /// Library: save an uploaded photo as a named model.
    func addModel(name: String, role: String, imagePath: String) async -> Bool {
        struct Body: Encodable {
            let action = "add"; let id: String; let name: String; let imagePath: String; let role: String
        }
        let slug = name.lowercased().replacingOccurrences(of: " ", with: "-")
        do {
            let _: CSOK = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/brand-models",
                body: Body(id: slug, name: name, imagePath: imagePath, role: role))
            toast = "মডেল \"\(name)\" সেভ হলো"
            if let m: CSModelsResponse = try? await AlmaAPI.shared.get("/api/assistant/brand-models") { models = m.models }
            return true
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "ব্যর্থ হলো" }
        catch { toast = "সেভ হয়নি" }
        return false
    }

    /// CS4: generate the brand's FICTIONAL model for a role (no real children's photos).
    func generateBrandModel(role: String, bn: String) async {
        struct Body: Encodable { let role: String }
        do {
            let _: CSAudioQueueResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/model-creator", body: Body(role: role))
            toast = "\(bn) মডেল তৈরি হচ্ছে — Gallery-তে আসবে"
            await refreshGallery()
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "ব্যর্থ হলো" }
        catch { toast = "হয়নি" }
    }

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

    // ── Video studio (Phase V1-V3, web parity) ──────────────────────────────
    func loadVideoStudio() async {
        async let v: CSVideoUploadsResponse? = try? AlmaAPI.shared.get("/api/assistant/creative-studio/video")
        async let m: CSMusicResponse? = try? AlmaAPI.shared.get("/api/assistant/creative-studio/music")
        let (vids, mus) = await (v, m)
        if let vids { videoUploads = vids.uploads ?? [] }
        if let mus { musicTracks = mus.tracks ?? [] }
    }

    /// Big phone shoots go STRAIGHT to storage with a signed URL — Vercel never
    /// sees the body (web parity). Returns the registered upload.
    func uploadVideo(fileURL: URL, name: String, sizeBytes: Int,
                     onProgress: @escaping (Int) -> Void) async -> CSVideoUpload? {
        struct Reg: Encodable { let uploadId: String?; let path: String; let name: String; let sizeBytes: Int }
        struct RegResp: Decodable { let upload: CSVideoUpload?; let error: String? }
        do {
            let signed: CSSignedUploadURL = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/video/upload-url",
                body: ["fileName": AnyEncodable(name), "sizeBytes": AnyEncodable(sizeBytes)])
            guard let urlStr = signed.uploadUrl, let url = URL(string: urlStr), let path = signed.path else {
                toast = signed.error ?? "আপলোড URL পাওয়া গেল না"; return nil
            }
            try await CSDirectUploader.put(fileURL: fileURL, to: url,
                                           contentType: signed.contentType ?? "video/mp4",
                                           onProgress: onProgress)
            let reg: RegResp = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/video",
                body: Reg(uploadId: signed.uploadId, path: path, name: name, sizeBytes: sizeBytes))
            guard let up = reg.upload else { toast = reg.error ?? "রেজিস্টার ব্যর্থ"; return nil }
            videoUploads.insert(up, at: 0)
            toast = "ভিডিও আপলোড হয়েছে, Boss"
            return up
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "আপলোড ব্যর্থ হয়েছে" }
        catch { toast = "আপলোড ব্যর্থ হয়েছে" }
        return nil
    }

    func deleteVideo(_ up: CSVideoUpload) async {
        do {
            let _: CSOK = try await AlmaAPI.shared.send(
                "DELETE", "/api/assistant/creative-studio/video?id=\(up.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? up.id)")
            videoUploads.removeAll { $0.id == up.id }
            toast = "ভিডিও মুছে ফেলা হয়েছে"
        } catch { toast = "মুছতে সমস্যা হলো" }
    }

    func runVideoRecipe(video: CSVideoUpload, recipeId: String, targets: [Int], aspect: String,
                        captions: Bool, audioMode: String, musicTrackId: String,
                        voiceoverText: String, stings: Bool, aiAssist: Bool) async -> Bool {
        struct Options: Encodable {
            let captions: Bool; let audioMode: String; let musicTrackId: String
            let voiceoverText: String?; let stings: Bool; let aiAssist: Bool
        }
        struct Body: Encodable {
            let videoPath: String; let videoName: String; let recipeId: String
            let targets: [Int]; let aspect: String; let options: Options
        }
        do {
            let res: CSVideoRunResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/video/run",
                body: Body(videoPath: video.path, videoName: video.name, recipeId: recipeId,
                           targets: targets, aspect: aspect,
                           options: Options(captions: captions, audioMode: audioMode,
                                            musicTrackId: musicTrackId,
                                            voiceoverText: voiceoverText.isEmpty ? nil : voiceoverText,
                                            stings: stings, aiAssist: aiAssist)))
            for j in res.jobs ?? [] {
                videoJobs.insert((id: j.pendingActionId, label: j.label ?? "রিল", status: nil), at: 0)
            }
            toast = res.message ?? "রিল বানানো শুরু হয়েছে"
            return true
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "রিল বানানো শুরু করা যায়নি" }
        catch { toast = "রিল বানানো শুরু করা যায়নি" }
        return false
    }

    /// Poll active video jobs once (callers loop on a timer while any are active).
    func pollVideoJobs() async {
        for (idx, job) in videoJobs.enumerated() {
            let active = job.status == nil || job.status?.status == "approved" || job.status?.status == "pending" || job.status?.status == "processing"
            guard active else { continue }
            if let st = await fetchJob(job.id) { videoJobs[idx].status = st }
        }
    }
    var hasActiveVideoJobs: Bool {
        videoJobs.contains { $0.status == nil || $0.status?.status == "approved" || $0.status?.status == "pending" || $0.status?.status == "processing" }
    }

    // ── Music library (owner-approved beds only) ────────────────────────────
    func uploadMusic(fileURL: URL, name: String, sizeBytes: Int, vibe: String,
                     onProgress: @escaping (Int) -> Void) async {
        struct Reg: Encodable { let uploadId: String?; let path: String; let name: String; let vibe: String; let sizeBytes: Int }
        struct RegResp: Decodable { let track: CSMusicTrack?; let error: String? }
        do {
            let signed: CSSignedUploadURL = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/music/upload-url",
                body: ["fileName": AnyEncodable(name), "sizeBytes": AnyEncodable(sizeBytes)])
            guard let urlStr = signed.uploadUrl, let url = URL(string: urlStr), let path = signed.path else {
                toast = signed.error ?? "আপলোড URL পাওয়া গেল না"; return
            }
            try await CSDirectUploader.put(fileURL: fileURL, to: url,
                                           contentType: signed.contentType ?? "audio/mpeg",
                                           onProgress: onProgress)
            let reg: RegResp = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/music",
                body: Reg(uploadId: signed.uploadId, path: path, name: name, vibe: vibe, sizeBytes: sizeBytes))
            if let t = reg.track { musicTracks.insert(t, at: 0); toast = "ট্র্যাক যোগ হয়েছে, Boss" }
            else { toast = reg.error ?? "রেজিস্টার ব্যর্থ" }
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "আপলোড ব্যর্থ" }
        catch { toast = "আপলোড ব্যর্থ" }
    }

    func deleteMusic(_ t: CSMusicTrack) async {
        do {
            let _: CSOK = try await AlmaAPI.shared.send(
                "DELETE", "/api/assistant/creative-studio/music?id=\(t.id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? t.id)")
            musicTracks.removeAll { $0.id == t.id }
        } catch { toast = "মুছতে সমস্যা হলো" }
    }

    // ── Audio Lab (E1) ───────────────────────────────────────────────────────
    func loadAudioLab() async {
        if let st: CSAudioLabStatus = try? await AlmaAPI.shared.get("/api/assistant/creative-studio/audio") {
            audioStatus = st
        }
    }

    /// All Audio Lab jobs follow production's estimate → explicit confirmation
    /// contract. The method name is retained so existing native cards stay small.
    func queueAudio(_ label: String, body: [String: AnyEncodable]) async {
        do {
            var estimateBody = body
            estimateBody["intent"] = AnyEncodable("estimate")
            let estimate: CSAudioEstimate = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/audio", body: estimateBody)
            pendingAudio = .audio(label: label, body: body)
            pendingAudioEstimate = estimate
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "হয়নি" }
        catch { toast = "হয়নি" }
    }

    func estimateVoiceClone(samplePaths: [String]) async {
        guard let project = activeProject, let brandID = project.brandProfileId else {
            toast = "আগে production project বেছে নিন"; return
        }
        struct Consent: Encodable { let accepted = true; let statement: String }
        struct Body: Encodable {
            let name: String; let samplePaths: [String]; let consent: Consent
            let intent = "estimate"; let brandProfileId: String; let projectId: String
        }
        let name = "Owner Voice"
        do {
            let estimate: CSAudioEstimate = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/voices",
                body: Body(name: name, samplePaths: samplePaths,
                           consent: Consent(statement: "আমি নিশ্চিত করছি যে এটি আমার নিজের কণ্ঠ এবং কেবল owner-only Creative Studio ব্যবহারের অনুমতি দিচ্ছি।"),
                           brandProfileId: brandID, projectId: project.id))
            pendingAudio = .voiceClone(name: name, samplePaths: samplePaths)
            pendingAudioEstimate = estimate
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "Voice estimate হয়নি" }
        catch { toast = "Voice estimate হয়নি" }
    }

    func cancelPendingAudio() { pendingAudio = nil; pendingAudioEstimate = nil }

    func confirmPendingAudio(_ estimate: CSAudioEstimate) async {
        guard let pendingAudio else { return }
        do {
            let response: CSAudioQueueResponse
            switch pendingAudio {
            case let .audio(label, original):
                var body = original
                body["intent"] = AnyEncodable("queue")
                body["confirmedCostBdt"] = AnyEncodable(estimate.costBdt)
                body["costCapBdt"] = AnyEncodable(estimate.maxCostBdt)
                response = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/creative-studio/audio", body: body)
                toast = "\(label) তৈরি হচ্ছে (~৳\(almaBn(response.costBdt ?? estimate.costBdt))) — Gallery-তে আসবে, Boss"
            case let .voiceClone(name, samplePaths):
                guard let project = activeProject, let brandID = project.brandProfileId else { return }
                struct Consent: Encodable { let accepted = true; let statement: String }
                struct Body: Encodable {
                    let name: String; let samplePaths: [String]; let consent: Consent
                    let intent = "queue"; let confirmedCostBdt: Int; let costCapBdt: Int
                    let brandProfileId: String; let projectId: String
                }
                response = try await AlmaAPI.shared.send(
                    "POST", "/api/assistant/creative-studio/voices",
                    body: Body(name: name, samplePaths: samplePaths,
                               consent: Consent(statement: "আমি নিশ্চিত করছি যে এটি আমার নিজের কণ্ঠ এবং কেবল owner-only Creative Studio ব্যবহারের অনুমতি দিচ্ছি।"),
                               confirmedCostBdt: estimate.costBdt, costCapBdt: estimate.maxCostBdt,
                               brandProfileId: brandID, projectId: project.id))
                toast = "Consented voice version queue হয়েছে (~৳\(almaBn(response.costBdt ?? estimate.costBdt)))"
            }
            cancelPendingAudio()
            await loadAudioLab()
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "Queue হয়নি" }
        catch { toast = "Queue হয়নি" }
    }

    /// Signed direct upload for audio samples; returns the storage path.
    func uploadAudioFile(fileURL: URL, name: String, sizeBytes: Int,
                         onProgress: @escaping (Int) -> Void) async -> String? {
        do {
            let signed: CSSignedUploadURL = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/audio/upload-url",
                body: ["fileName": AnyEncodable(name), "sizeBytes": AnyEncodable(sizeBytes)])
            guard let urlStr = signed.uploadUrl, let url = URL(string: urlStr), let path = signed.path else {
                toast = signed.error ?? "আপলোড URL পাওয়া গেল না"; return nil
            }
            try await CSDirectUploader.put(fileURL: fileURL, to: url,
                                           contentType: signed.contentType ?? "audio/mpeg",
                                           onProgress: onProgress)
            return path
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "আপলোড ব্যর্থ" }
        catch { toast = "আপলোড ব্যর্থ" }
        return nil
    }

    // ── Studio settings + brand (CS4) ───────────────────────────────────────
    func loadLibraryExtras() async {
        async let st: CSStudioSettings? = try? AlmaAPI.shared.get("/api/assistant/creative-studio/settings")
        async let br: CSBrandStatus? = try? AlmaAPI.shared.get("/api/assistant/creative-studio/branding")
        let (s2, b2) = await (st, br)
        if let s2 { settings = s2 }
        if let b2 { brandStatus = b2 }
    }

    func saveSettings(qcLevel: String? = nil, notifyOnDone: Bool? = nil, imageEngine: String? = nil) async {
        var body: [String: AnyEncodable] = [:]
        if let qcLevel { body["qcLevel"] = AnyEncodable(qcLevel) }
        if let notifyOnDone { body["notifyOnDone"] = AnyEncodable(notifyOnDone) }
        if let imageEngine { body["imageEngine"] = AnyEncodable(imageEngine) }
        do {
            let _: CSOK = try await AlmaAPI.shared.send("POST", "/api/assistant/creative-studio/settings", body: body)
            toast = "সেভ হয়েছে"
            if let st: CSStudioSettings = try? await AlmaAPI.shared.get("/api/assistant/creative-studio/settings") { settings = st }
        } catch { toast = "হয়নি" }
    }

    func deleteGarmentCache(_ key: String) async {
        do {
            let _: CSOK = try await AlmaAPI.shared.send(
                "DELETE", "/api/assistant/creative-studio/settings?key=\(key.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? key)")
            if let st = settings {
                settings = CSStudioSettings(qcLevel: st.qcLevel, notifyOnDone: st.notifyOnDone,
                                            imageEngine: st.imageEngine,
                                            childGarments: st.childGarments?.filter { $0.key != key })
            }
        } catch { toast = "হয়নি" }
    }

    /// Upload / replace the ALMA logo (auto-resized server-side).
    func uploadLogo(_ data: Data, filename: String, mime: String) async {
        do {
            let res: CSBrandStatus = try await AlmaAPI.shared.uploadMultipart(
                "/api/assistant/creative-studio/branding", fileField: "logo",
                filename: filename, mime: mime, data: data,
                fields: ["transparent": "1"])
            brandStatus = res
            toast = "লোগো সেভ হয়েছে ✅ — পরের ফিনিশিং-এ এটাই বসবে"
        } catch let AlmaAPIError.http(_, body) { toast = CS.serverMessage(body) ?? "লোগো সেভ ব্যর্থ" }
        catch { toast = "লোগো সেভ ব্যর্থ" }
    }
}

/// Raw PUT to a signed storage URL (outside the cookie session — the URL itself
/// is the auth). Streams from disk so a 500 MB shoot never sits in memory.
enum CSDirectUploader {
    final class ProgressDelegate: NSObject, URLSessionTaskDelegate {
        let onProgress: (Int) -> Void
        init(_ cb: @escaping (Int) -> Void) { onProgress = cb }
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
                        totalBytesExpectedToSend: Int64) {
            guard totalBytesExpectedToSend > 0 else { return }
            let pct = Int((Double(totalBytesSent) / Double(totalBytesExpectedToSend) * 100).rounded())
            DispatchQueue.main.async { self.onProgress(min(pct, 100)) }
        }
    }

    static func put(fileURL: URL, to url: URL, contentType: String,
                    onProgress: @escaping (Int) -> Void) async throws {
        var req = URLRequest(url: url)
        req.httpMethod = "PUT"
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 3600
        let delegate = ProgressDelegate(onProgress)
        let (data, resp) = try await URLSession.shared.upload(for: req, fromFile: fileURL, delegate: delegate)
        guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            throw AlmaAPIError.http(status: status, body: String(data: data, encoding: .utf8) ?? "")
        }
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
    /// Home quick-create → V4 production desk (Projects · Review · Campaign · Voice · Operations).
    @State private var v4Desk: CSV4WorkspaceScreen.Section?
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
                case .home:    CSHomeTab(vm: vm, go: { tab = $0 }, exit: { popNav?() }, openDesk: { v4Desk = $0 })
                case .create:  CSCreateTab(vm: vm, back: { tab = .home })
                case .gallery: CSGalleryTab(vm: vm, go: { tab = $0 })
                case .video:   CSVideoTab(vm: vm)
                case .audio:   CSAudioTab(vm: vm)
                case .library: CSLibraryTab(vm: vm, openWeb: openWeb)
                }
            }
            .transition(.opacity)

            CSTabBar(tab: $tab)
        }
        .animation(.easeInOut(duration: 0.28), value: tab)
        .background(AgentPalette(scheme).bg0.ignoresSafeArea())
        .task { await vm.loadAll() }
        .sheet(item: $v4Desk) { desk in
            CSV4WorkspaceScreen(seedProject: vm.activeProject, initialSection: desk) { project in
                Task { await vm.activateProject(project) }
            }
            .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .overlay(alignment: .top) { CSToastView(message: vm.toast) }
        // S8 audit fix: auth expiry used to surface only as a toast — the one screen
        // without the standard login-recovery card. Banner gives the re-login path.
        .overlay(alignment: .top) {
            if vm.authExpired {
                HStack(spacing: 10) {
                    Image(systemName: "lock.slash").font(.caption.weight(.bold))
                    Text("সেশন পাওয়া যায়নি").font(.caption.weight(.semibold))
                    Spacer()
                    Button("লগইন খুলুন") { openWeb("/login", "Login") }
                        .font(.caption.weight(.bold))
                        .buttonStyle(.borderedProminent)
                        .controlSize(.mini)
                        .tint(CS.cta)
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(.orange.opacity(0.45), lineWidth: 1))
                .padding(.horizontal, 16).padding(.top, 54)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
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
    /// Opens the V4 production workspace sheet on a specific desk (Projects · Review · Campaign · Voice · Operations).
    var openDesk: (CSV4WorkspaceScreen.Section) -> Void = { _ in }
    @Environment(\.colorScheme) private var scheme
    @State private var filter = "সব"
    @State private var search = ""

    private var query: String { search.trimmingCharacters(in: .whitespaces).lowercased() }
    private func matches(_ text: String) -> Bool { query.isEmpty || text.lowercased().contains(query) }

    /// Chip filter (was decorative before): ছবি / ভিডিও / ফ্যামিলি / লাইফস্টাইল.
    private func passesChip(_ item: CSGalleryItem) -> Bool {
        switch filter {
        case "ছবি": return !item.isVideo && !item.isAudio
        case "ভিডিও": return item.isVideo
        case "ফ্যামিলি": return (item.familyPreset != nil && item.familyPreset != "single") || item.mode == "full_family"
        case "লাইফস্টাইল": return item.brandedUrl != nil || (item.finishParams?.mode == "lifestyle")
        default: return true
        }
    }
    private var pool: [CSGalleryItem] {
        vm.gallery.filter { passesChip($0) && matches("\($0.title) \($0.provider ?? "") \($0.mode ?? "")") }
    }
    private var hero: CSGalleryItem? { pool.first { !$0.isVideo } ?? pool.first ?? vm.gallery.first }
    private var recents: [CSGalleryItem] { Array(pool.prefix(8)) }
    private var projects: [CSProjectSummary] {
        vm.projects.filter { matches("\($0.name) \($0.product?.code ?? "") \($0.description ?? "")") }
    }
    private var models: [CSModel] { vm.realModels.filter { matches("\($0.name ?? "") \($0.role ?? "")") } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                projectSwitcher.padding(.top, 12)
                searchField.padding(.top, 10)
                CSChipRow(items: ["সব", "ছবি", "ভিডিও", "ফ্যামিলি", "লাইফস্টাইল"], selection: $filter)
                    .padding(.top, 12).padding(.horizontal, -18)

                if query.isEmpty { heroCard.padding(.top, 16) }

                CSSectionHeader(title: "তৈরি করুন", trailing: "কোনো খরচ confirmation ছাড়া হয় না", action: nil)
                createGrid

                if !query.isEmpty || !models.isEmpty {
                    CSSectionHeader(title: "সেভ করা identity", trailing: "সব", action: { go(.library) })
                    identityStrip
                }

                CSSectionHeader(title: "শুরু করুন", trailing: "সব মোড") { go(.create) }
                featureList

                CSSectionHeader(title: "সাম্প্রতিক তৈরি", trailing: "গ্যালারি") { go(.gallery) }
                recentStrip

                CSSectionHeader(title: "সাম্প্রতিক project", trailing: "সব project", action: { openDesk(.projects) })
                projectList

                CSSectionHeader(title: "Studio pulse", trailing: "Operations", action: { openDesk(.operations) })
                pulseCard

                if query.isEmpty {
                    CSSectionHeader(title: "ট্রেন্ডিং সিন", trailing: nil, action: nil)
                    trendingGrid
                }
                Color.clear.frame(height: 96)
            }
            .padding(.horizontal, 18)
        }
        .claudeTopFade(useNativeEdgeEffect: false)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await vm.loadAll() }
    }

    private var header: some View {
        HStack(spacing: 11) {
            Button { exit(); CSHaptic.tap() } label: {
                Image(systemName: "chevron.left")
                    .accessibilityLabel("পেছনে").font(.system(size: 17, weight: .semibold))
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
                Text("\(almaBn(vm.gallery.filter { !$0.id.hasPrefix("sample-") }.count))টি").font(.system(size: 12.5, weight: .bold)).monospacedDigit()
            }
            .foregroundStyle(AgentPalette(scheme).ink)
            .padding(.vertical, 7).padding(.horizontal, 12)
            .csGlass(scheme, corner: 999)
        }
        .padding(.top, 58)
    }

    /// Web header brand/project picker — the active project is the production scope for
    /// Create, Gallery, saved identities and every paid confirmation.
    private var projectSwitcher: some View {
        Menu {
            if vm.projects.isEmpty {
                Text("কোনো writable project নেই")
            }
            ForEach(vm.projects) { p in
                Button {
                    Task { await vm.activateProject(p) }
                } label: {
                    if p.id == vm.activeProject?.id {
                        Label("\(p.name)\(p.product.map { " · \($0.code)" } ?? "")", systemImage: "checkmark")
                    } else {
                        Text("\(p.name)\(p.product.map { " · \($0.code)" } ?? "")")
                    }
                }
            }
            Divider()
            Button { openDesk(.projects) } label: { Label("নতুন project / সব project", systemImage: "folder.badge.plus") }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "lock.shield.fill").font(.system(size: 14)).foregroundStyle(AgentPalette.coralLt)
                VStack(alignment: .leading, spacing: 1) {
                    Text("PRODUCTION SCOPE").font(.system(size: 9, weight: .bold)).tracking(1).foregroundStyle(AgentPalette.coralLt)
                    Text(vm.activeProject?.name ?? "Project বাছুন").font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(1)
                    Text(vm.activeProject.map { "\($0.product?.code ?? "No ERP product") · \($0.currentRecipe?.name ?? "No recipe") · \(almaBn($0.assetCount ?? 0)) assets" } ?? "Create/Gallery/paid run সব এই scope-এ")
                        .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted).lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            }
            .padding(.vertical, 10).padding(.horizontal, 13).csGlass(scheme, corner: 16)
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(AgentPalette(scheme).muted)
            TextField("Project, asset, product code, provider খুঁজুন…", text: $search)
                .textInputAutocapitalization(.never).autocorrectionDisabled().font(.system(size: 12.5))
                .submitLabel(.search)
                .onSubmit { vm.gallerySearch = search; Task { await vm.refreshGallery() } }
            if !search.isEmpty {
                Button { search = ""; vm.gallerySearch = ""; Task { await vm.refreshGallery() } } label: { Image(systemName: "xmark.circle.fill") }
                    .foregroundStyle(AgentPalette(scheme).muted)
            }
        }
        .padding(.horizontal, 12).frame(height: 42).csGlass(scheme, corner: 13)
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
                    CSPill(text: hero?.originalVariant?.dimensionLabel ?? (hero?.aspectRatio ?? "HD"), icon: nil, filled: false)
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

    /// Web Home "Start creating" cards — every V4 desk reachable from Home.
    private var createGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            createCard("ছবি", "Auto বা Advanced · FASHN · Guided · Grok", "photo.on.rectangle.angled") { go(.create) }
            createCard("ভিডিও / রিল", "Gallery ছবি, avatar বা নিজের শুট থেকে", "film.fill") { go(.video) }
            createCard("অ্যাভাটার ও মডেল", "Saved identity · AI brand model", "person.crop.circle.fill") { go(.library) }
            createCard("ভয়েস", "Consent · version · activate", "waveform.badge.mic") { openDesk(.voice) }
            createCard("অডিও", "মিউজিক · dubbing · SFX · ভয়েস", "waveform") { go(.audio) }
            createCard("Campaign Pack", "Manifest → 2 draft → pack", "shippingbox.fill") { openDesk(.campaign) }
            createCard("Long-form", "Versioned canvas · Creative Agent", "rectangle.3.group") { openDesk(.projects) }
            createCard("Review", "Exact pin · ৳0 render/export", "checkmark.seal.fill") { openDesk(.review) }
        }
    }

    private func createCard(_ title: String, _ sub: String, _ icon: String, _ tap: @escaping () -> Void) -> some View {
        Button { tap(); CSHaptic.tap() } label: {
            VStack(alignment: .leading, spacing: 8) {
                Image(systemName: icon).font(.system(size: 17, weight: .semibold)).foregroundStyle(AgentPalette.coralLt)
                    .frame(width: 36, height: 36).background(AgentPalette.coral.opacity(0.12), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                Text(title).font(.system(size: 14, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                Text(sub).font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted).lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(12).csGlass(scheme, corner: AlmaSwiftTheme.rCard)
        }.buttonStyle(.plain)
    }

    private var identityStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                if models.isEmpty {
                    Text("কোনো identity মেলেনি").font(.system(size: 12)).foregroundStyle(AgentPalette(scheme).muted)
                        .padding(12).csGlass(scheme, corner: 14)
                }
                ForEach(models.prefix(8)) { m in
                    Button { go(.create); CSHaptic.tap() } label: {
                        HStack(spacing: 9) {
                            CSPhoto(url: m.imageURL, ratio: 1).frame(width: 38, height: 38).clipShape(Circle())
                            VStack(alignment: .leading, spacing: 1) {
                                Text(m.name ?? "মডেল").font(.system(size: 12.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(1)
                                Text(m.isDefault == true ? "Default · \(CS.roleBn(m.role))" : CS.roleBn(m.role)).font(.system(size: 10)).foregroundStyle(AgentPalette(scheme).muted).lineLimit(1)
                            }
                        }.padding(.vertical, 8).padding(.horizontal, 11).csGlass(scheme, corner: 999)
                    }.buttonStyle(.plain)
                }
            }.padding(.vertical, 2)
        }
    }

    private var featureList: some View {
        VStack(spacing: 12) {
            CSFeatureRow(image: vm.gallery.first?.imageURL, name: "Product→Model", badge: "নতুন",
                         desc: "প্রোডাক্ট ছবি → রিয়েল মডেল শট", credits: "FASHN / Guided / Grok") { go(.create) }
            CSFeatureRow(image: vm.gallery.dropFirst(1).first?.imageURL, name: "ফ্যামিলি সেট", badge: "প্রিমিয়াম",
                         desc: "বাবা+ছেলে / মা+মেয়ে — লাইব্রেরির মডেল দিয়ে", credits: "FASHN chain + Gemini") { go(.create) }
            CSFeatureRow(image: vm.gallery.dropFirst(2).first?.imageURL, name: "Generate", badge: nil,
                         desc: "শুধু প্রম্পট থেকে ক্যাম্পেইন ভিজ্যুয়াল", credits: "Grok Imagine (xAI)") { go(.create) }
        }
        .padding(.top, 2)
    }

    private var recentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 11) {
                Button { go(.create) } label: {
                    VStack(spacing: 8) {
                        ZStack { RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous).fill(CS.cta).frame(width: 40, height: 40)
                            Image(systemName: "plus").font(.system(size: 20, weight: .bold)).foregroundStyle(.white) }
                        Text("নতুন").font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                    }
                    .frame(width: 116, height: 150).csGlass(scheme, corner: 18)
                }.buttonStyle(.plain)
                if recents.isEmpty {
                    Text(query.isEmpty ? "এই filter-এ কিছু নেই" : "\"\(search)\" মেলেনি").font(.system(size: 12)).foregroundStyle(AgentPalette(scheme).muted)
                        .frame(height: 150).padding(.horizontal, 14).csGlass(scheme, corner: 18)
                }
                ForEach(recents) { item in
                    Button { go(.gallery); CSHaptic.tap() } label: {
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
                    }.buttonStyle(.plain)
                }
            }.padding(.vertical, 2)
        }
    }

    private var projectList: some View {
        VStack(spacing: 9) {
            if projects.isEmpty {
                Text(vm.projects.isEmpty ? "এই brand-এ writable project নেই — Projects desk থেকে নতুন তৈরি করুন" : "\"\(search)\" কোনো project-এ মেলেনি")
                    .font(.system(size: 12)).foregroundStyle(AgentPalette(scheme).muted)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12).csGlass(scheme, corner: 14)
            }
            ForEach(projects.prefix(5)) { p in
                Button { Task { await vm.activateProject(p) }; CSHaptic.tap() } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "folder.fill").font(.system(size: 15)).foregroundStyle(AgentPalette.coralLt)
                            .frame(width: 34, height: 34).background(AgentPalette.coral.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(p.name).font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(1)
                            Text("\(p.product?.code ?? "No ERP product") · \(p.defaultFolder ?? "Creative Studio") · \(almaBn(p.assetCount ?? 0)) assets")
                                .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted).lineLimit(1)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text(p.currentRecipe?.name ?? "No recipe").font(.system(size: 10.5, weight: .bold)).foregroundStyle(AgentPalette.coralLt).lineLimit(1)
                            Text(p.updatedAt.map { String($0.prefix(10)) } ?? "").font(.system(size: 9.5)).foregroundStyle(AgentPalette(scheme).muted)
                        }
                        if p.id == vm.activeProject?.id {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(AgentPalette.coral)
                        }
                    }
                    .padding(11).csGlass(scheme, corner: 15)
                }.buttonStyle(.plain)
            }
        }
    }

    /// Web "Studio pulse" — worker state, needs-review, live engines (truthful snapshot).
    private var pulseCard: some View {
        let workerState = vm.health?.worker?.state ?? "unknown"
        let workerOK = workerState == "healthy" || workerState == "ok"
        let engines = (vm.config?.engines ?? []).prefix(5)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                pulseMetric("Worker", vm.health?.worker?.labelBn ?? workerState, tone: workerOK ? AgentPalette.teal : .orange)
                pulseMetric("Needs review", almaBn(vm.needsReviewCount), tone: vm.needsReviewCount > 0 ? .orange : AgentPalette.teal)
                pulseMetric("Live engines", almaBn(vm.config?.liveEngineCount ?? 0), tone: AgentPalette.coralLt)
            }
            if let seen = vm.health?.worker?.lastSeenBn, !seen.isEmpty {
                Text(seen).font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
            }
            if !engines.isEmpty {
                Divider().opacity(0.25)
                Text("Provider integrity").font(.system(size: 11, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                ForEach(Array(engines)) { e in
                    HStack {
                        Circle().fill(e.selectable ? AgentPalette.teal : (e.killed == true ? Color.red : Color.orange)).frame(width: 7, height: 7)
                        Text(e.labelBn ?? e.label ?? e.id).font(.system(size: 12, weight: .semibold)).foregroundStyle(AgentPalette(scheme).ink)
                        Spacer()
                        Text(e.killed == true ? "killed" : (e.selectable ? "live" : (e.status ?? "unavailable").replacingOccurrences(of: "_", with: " ")))
                            .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                    }
                }
            } else {
                Text("Engine snapshot নেই — server config দেখুন").font(.system(size: 11)).foregroundStyle(AgentPalette(scheme).muted)
            }
        }
        .padding(13).csGlass(scheme, corner: 16)
    }
    private func pulseMetric(_ label: String, _ value: String, tone: Color) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased()).font(.system(size: 9, weight: .bold)).tracking(0.8).foregroundStyle(AgentPalette(scheme).muted)
            Text(value).font(.system(size: 14, weight: .heavy)).foregroundStyle(tone).lineLimit(1).minimumScaleFactor(0.7)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var trendingGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            ForEach(Array(pool.prefix(6))) { item in
                Button { go(.gallery); CSHaptic.tap() } label: { CSGalleryTile(item: item) }.buttonStyle(.plain)
            }
        }
    }
}

// MARK: - CREATE (full web parity: Auto + Advanced with every slot)

/// One image input slot: local preview + uploaded storage path.
@available(iOS 17.0, *)
@Observable
final class CSSlot {
    var picked: PhotosPickerItem?
    var image: UIImage?
    var path: String?
    var referenceId: String?
    var uploading = false
    /// Remote preview (project ERP product / Gallery source) — no upload happened.
    var remoteURL: URL?
    /// Gallery source lineage (sourcePendingActionId / sourceAssetIds on the run).
    var sourceItem: CSGalleryItem?
    /// Owner-facing origin label ("আপলোড", "প্রজেক্ট প্রোডাক্ট", "গ্যালারি", "ক্লিপবোর্ড").
    var origin: String?

    var hasImage: Bool { image != nil || remoteURL != nil }

    func clear() {
        picked = nil; image = nil; path = nil; referenceId = nil; uploading = false
        remoteURL = nil; sourceItem = nil; origin = nil
    }

    /// Use the active project's ERP catalog image directly (web Auto "Gallery" product tray).
    func useProjectProduct(_ product: CSProjectProduct, previewURL: URL? = nil) {
        guard let source = product.sourceImage else { return }
        clear()
        path = source
        remoteURL = previewURL ?? product.previewURL
        origin = "প্রজেক্ট প্রোডাক্ট · \(product.code)"
    }

    /// Use a ready Gallery image as the source (web "Continue from a recent image").
    func useGallery(_ item: CSGalleryItem) {
        guard let storage = item.storagePath else { return }
        clear()
        path = storage
        remoteURL = item.previewURL ?? item.imageURL
        sourceItem = item
        origin = "গ্যালারি · \(item.title)"
    }

    /// Clipboard image (web "Paste") — uploads like a picked photo.
    @MainActor
    func pasteFromClipboard(vm: CreativeStudioVM, folder: String, referenceKind: String?) async -> Bool {
        guard let ui = UIPasteboard.general.image else { return false }
        await load(image: ui, vm: vm, folder: folder, referenceKind: referenceKind, origin: "ক্লিপবোর্ড")
        return true
    }

    /// Downscale + JPEG (web parity with prepareImageForUpload: HEIC → jpg, max 2048).
    static func jpegData(_ ui: UIImage) -> Data? {
        let MAX: CGFloat = 2048
        let scale = min(1, MAX / max(ui.size.width, ui.size.height))
        if scale >= 1 { return ui.jpegData(compressionQuality: 0.9) }
        let size = CGSize(width: ui.size.width * scale, height: ui.size.height * scale)
        let fmt = UIGraphicsImageRendererFormat.default(); fmt.scale = 1
        let img = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in
            ui.draw(in: CGRect(origin: .zero, size: size))
        }
        return img.jpegData(compressionQuality: 0.9)
    }

    @MainActor
    func load(_ item: PhotosPickerItem?, vm: CreativeStudioVM, folder: String, referenceKind: String?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self),
              let ui = UIImage(data: data) else { return }
        await load(image: ui, vm: vm, folder: folder, referenceKind: referenceKind, origin: "আপলোড")
    }

    @MainActor
    func load(image ui: UIImage, vm: CreativeStudioVM, folder: String, referenceKind: String?, origin: String) async {
        image = ui
        path = nil
        referenceId = nil
        remoteURL = nil
        sourceItem = nil
        self.origin = origin
        uploading = true
        defer { uploading = false }
        guard let jpeg = CSSlot.jpegData(ui) else { vm.flash("ছবি পড়া গেল না"); return }
        do {
            let upload = try await vm.uploadImage(jpeg, folder: folder, referenceKind: referenceKind)
            path = upload.path
            referenceId = upload.referenceId
        }
        catch { vm.flash("আপলোড ব্যর্থ হলো") }
    }
}

@available(iOS 17.0, *)
private struct CSCreateTab: View {
    let vm: CreativeStudioVM
    let back: () -> Void
    @Environment(\.colorScheme) private var scheme

    @State private var isAdvanced = false
    /// Per-run engine (web `engine` state): fashn · gemini (guided) · fal_fashn_v16 ·
    /// fal_idm_vton · fal_flux_fill · xai_imagine. Seeded from the server default.
    @State private var engineId = "fashn"
    /// Guided-model choice (kv `imageEngine`: gemini | gpt | seedream) — owner 2026-07-12:
    /// picking a render model writes the kv so native = web = worker.
    @State private var guidedIdx = 0
    @State private var engineSeeded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                CSSegment(items: ["✦ Auto — এক ট্যাপ", "⚙ Advanced"], index: Binding(
                    get: { isAdvanced ? 1 : 0 }, set: { isAdvanced = ($0 == 1) }))
                    .padding(.horizontal, 18).padding(.top, 14)
                if isAdvanced {
                    CSAdvancedPanel(vm: vm, engineId: $engineId, guidedIdx: $guidedIdx)
                } else {
                    engineRow
                    CSAutoPanel(vm: vm)
                }
                Color.clear.frame(height: 130)
            }
        }
        .claudeTopFade(useNativeEdgeEffect: false)
        .scrollDismissesKeyboard(.interactively)
        // The engine chips need the saved settings even when the Library tab was
        // never opened this session.
        .task {
            if vm.settings == nil { await vm.loadLibraryExtras() }
            if !engineSeeded {
                engineSeeded = true
                switch vm.settings?.imageEngine {
                case "gpt": guidedIdx = 1
                case "seedream": guidedIdx = 2
                default: guidedIdx = 0
                }
                // Auto row offers FASHN + the guided lane; Advanced widens to the full registry.
                let preferred = vm.config?.singleVtonDefault ?? "fashn"
                if vm.config?.isSelectable("fashn") == true { engineId = "fashn" }
                else if vm.config?.isSelectable(preferred) == true { engineId = preferred }
                else if let live = CS.engines.first(where: { vm.config?.isSelectable($0.id) == true }) { engineId = live.id }
            }
            // Gallery → Create hand-off lands in Advanced with the source pre-selected.
            if vm.createSeed != nil { isAdvanced = true }
        }
        .onChange(of: vm.createSeed?.id) { _, new in if new != nil { isAdvanced = true } }
        .csEstimateAlert(vm: vm)
    }

    /// Auto engine row: FASHN Pro (try-on) or the owner-selected guided render model.
    /// Picking a render model writes the cs_image_models kv (native = web = worker).
    private var engineRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ইঞ্জিন")
                .font(.system(size: 11, weight: .bold)).tracking(0.6)
                .foregroundStyle(AgentPalette(scheme).muted)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 148), spacing: 6)], alignment: .leading, spacing: 6) {
                CSChip(text: "FASHN Pro (মডেল-শট)", on: engineId == "fashn") {
                    if vm.config?.isSelectable("fashn") == true { engineId = "fashn" }
                    else { vm.flash("FASHN Pro এখন configure করা নেই") }
                }
                CSChip(text: "Nano Banana (ফটোরিয়াল)", on: engineId == "gemini" && guidedIdx == 0) {
                    engineId = "gemini"; guidedIdx = 0
                    Task { await vm.saveSettings(imageEngine: "gemini") }
                }
                CSChip(text: "GPT Image 2 (প্রোডাক্ট/পোস্টার)", on: engineId == "gemini" && guidedIdx == 1) {
                    engineId = "gemini"; guidedIdx = 1
                    Task { await vm.saveSettings(imageEngine: "gpt") }
                }
                CSChip(text: "Seedream 5.0 Pro (2K · নতুন)", on: engineId == "gemini" && guidedIdx == 2) {
                    engineId = "gemini"; guidedIdx = 2
                    Task { await vm.saveSettings(imageEngine: "seedream") }
                }
                if engineId != "fashn" && engineId != "gemini", let e = CS.engines.first(where: { $0.id == engineId }) {
                    CSChip(text: "\(e.short) (Advanced)", on: true) { isAdvanced = true }
                }
            }
            Text(engineId == "fashn"
                 ? "Try-on/মডেল-শট FASHN-এ — best realism। ছবি/পোস্টার রেন্ডার পাশের মডেলগুলোতে।"
                 : "পরের রেন্ডার থেকে কার্যকর · Advanced-এ আরও ইঞ্জিন (Fal · IDM-VTON · Grok) আছে")
                .font(.system(size: 10)).foregroundStyle(AgentPalette(scheme).muted)
        }
        .padding(.horizontal, 18).padding(.top, 12)
    }

    private var header: some View {
        HStack(spacing: 11) {
            Button { back(); CSHaptic.tap() } label: {
                Image(systemName: "chevron.left")
                    .accessibilityLabel("পেছনে").font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(AgentPalette(scheme).ink).frame(width: 38, height: 38).csGlass(scheme, corner: 999)
            }.buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 2) {
                Text("নতুন জেনারেশন").font(.system(size: 10, weight: .bold)).tracking(1.2).foregroundStyle(AgentPalette.coralLt)
                Text("ক্রিয়েটিভ বানাও").font(.system(size: 19, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
            }
            Spacer()
            if vm.config?.fashnConfigured == true {
                Text("FASHN Pro").font(.system(size: 11, weight: .bold)).foregroundStyle(AgentPalette.teal)
                    .padding(.vertical, 6).padding(.horizontal, 11).csGlass(scheme, corner: 999)
            }
        }
        .padding(.top, 58).padding(.horizontal, 18)
    }
}

// ── AUTO: product photo + default model + family/reel toggles → auto:true ────

@available(iOS 17.0, *)
private struct CSAutoPanel: View {
    let vm: CreativeStudioVM
    @Environment(\.colorScheme) private var scheme
    @State private var product = CSSlot()
    @State private var includeFamily = false
    @State private var includeReel = false
    @State private var modelSheet = false

    /// Real saved identities only — the bundled sample models (`sm-*`) must never
    /// reach a paid run (pre-fix Auto sent `modelId: "sm-0"` when the library was empty).
    private var realModels: [CSModel] { vm.realModels }
    private var defaultModel: CSModel? { realModels.first { $0.isDefault == true } ?? realModels.first }
    private var familyAvailable: Bool {
        let roles = Set(realModels.compactMap(\.role))
        return (roles.contains("father") && roles.contains("son"))
            || (roles.contains("mother") && roles.contains("son"))
            || (roles.contains("mother") && roles.contains("daughter"))
    }
    private var canRun: Bool { product.path != nil && defaultModel != nil && !product.uploading }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(spacing: 5) {
                Text("Product দিন — বাকিটা AI করবে").font(.system(size: 19, weight: .heavy))
                    .foregroundStyle(AgentPalette(scheme).ink).frame(maxWidth: .infinity)
                Text("শুধু পণ্যের ছবি দিন। সেভ করা মডেল, prompt, ব্যাকগ্রাউন্ড — সব AI নিজেই ঠিক রাখবে।")
                    .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).muted)
                    .multilineTextAlignment(.center).frame(maxWidth: .infinity)
            }.padding(.top, 18)

            CSUploadTile(slot: product, vm: vm, label: "Product ছবি", folder: "studio-product",
                         referenceKind: "product", required: true, height: 240,
                         allowPaste: true, projectProduct: vm.activeProject?.product,
                         projectProductPreview: vm.activeProject?.productPreviewURL)
            if let project = vm.activeProject {
                Text("স্কোপ: \(project.name)\(project.product.map { " · \($0.code)" } ?? "") — product, model ও Gallery reference এই project-এর ভেতরেই থাকবে")
                    .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
            }

            // Model — tappable: choose which saved model Auto uses (promotes to default)
            if let m = defaultModel {
                Button { modelSheet = true; CSHaptic.tap() } label: {
                    HStack(spacing: 12) {
                        CSPhoto(url: m.imageURL, ratio: 1).frame(width: 46, height: 46).clipShape(Circle())
                        VStack(alignment: .leading, spacing: 2) {
                            Text("মডেল: \(m.name ?? "—")").font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                            Text(vm.config?.fashnConfigured == true ? "🟢 FASHN — best realism engine চালু" : "Gemini engine")
                                .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                        }
                        Spacer()
                        Text("বদলান").font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette.coral)
                            .padding(.vertical, 6).padding(.horizontal, 11)
                            .background(AgentPalette.coral.opacity(0.13), in: Capsule())
                    }
                    .padding(12).csGlass(scheme, corner: 18)
                }.buttonStyle(.plain)
            } else {
                Text("⚠ এখনো কোনো মডেল সেভ করা নেই — লাইব্রেরি ট্যাবে একটি মডেলের ছবি সেভ করুন, তারপর শুধু product দিলেই হবে। নতুন মডেল ছবি দিয়ে এখনই বানাতে চাইলে Advanced → Product→Model নিন।")
                    .font(.system(size: 12)).foregroundStyle(Color(red: 0.95, green: 0.75, blue: 0.3))
                    .padding(13).frame(maxWidth: .infinity, alignment: .leading).csGlass(scheme, corner: 16)
            }

            if familyAvailable {
                CSInlineToggle(title: "পরিবার ভ্যারিয়েন্টও বানাও",
                               sub: "বাবা+ছেলে / মা+মেয়ে — যাদের মডেল সেভ আছে", on: $includeFamily)
            }
            CSInlineToggle(title: "🎬 ছোট রিলও বানাও",
                           sub: "৬ সেকেন্ড 9:16 প্রোডাক্ট রিল (Veo) · আলাদা খরচ", on: $includeReel)

            Button {
                CSHaptic.tap()
                Task {
                    guard let path = product.path else { return }
                    _ = await vm.runAuto(productImagePath: path,
                                         productReferenceId: product.referenceId,
                                         modelId: defaultModel?.id,
                                         includeFamily: includeFamily && familyAvailable,
                                         includeReel: includeReel)
                }
            } label: {
                HStack(spacing: 9) {
                    if vm.generating { ProgressView().tint(.white) }
                    else { Image(systemName: "wand.and.stars").font(.system(size: 17, weight: .semibold)) }
                    Text(vm.generating ? "তৈরি হচ্ছে…" : "✨ Generate").font(.system(size: 16, weight: .bold))
                }
                .foregroundStyle(.white).frame(maxWidth: .infinity).padding(16)
                .background(CS.cta, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .shadow(color: CS.ctaGlow, radius: 16, y: 9)
                .opacity(canRun && !vm.generating ? 1 : 0.45)
            }
            .buttonStyle(.plain).disabled(!canRun || vm.generating)
            Text("Run-এর আগে exact estimate দেখাবে · actual খরচ Gallery-তে settle হবে\(includeReel ? " · রিলে আলাদা ভিডিও খরচ" : "")")
                .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted).frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 18)
        .sheet(isPresented: $modelSheet) {
            CSModelPickerSheet(title: "Auto কোন মডেল ব্যবহার করবে", models: realModels,
                               selectedId: defaultModel?.id ?? "") { id in
                Task { await vm.setDefaultModel(id) }
            }
        }
    }
}

// ── ADVANCED: every web mode with its real input slots ───────────────────────

@available(iOS 17.0, *)
private struct CSAdvancedPanel: View {
    let vm: CreativeStudioVM
    @Environment(\.colorScheme) private var scheme

    @State private var mode = CS.modes[1]     // Product→Model (web default)
    @State private var familyIdx = 0
    @State private var product = CSSlot()
    @State private var model = CSSlot()      // uploaded model photo (clears modelId)
    @State private var source = CSSlot()
    @State private var source2 = CSSlot()    // full_family merge: 2nd image
    @State private var modelId = ""          // saved model pick (clears model upload)
    @State private var prompt = ""
    @State private var bgIdx = 0
    @State private var aspect = 0
    @State private var resolution = 1
    @State private var genMode = 1
    @State private var numImages = 1
    @State private var vibe = 0
    @State private var durationSec = 6
    /// Per-run engine + guided render model (shared with the Create header).
    @Binding var engineId: String
    @Binding var guidedIdx: Int
    @State private var modelSheet = false
    @State private var addRoleSheet: String?  // family checklist "add" role
    @State private var seededFromGallery: String?

    private var realModels: [CSModel] { vm.realModels }
    private var familyId: String { CS.familyIds[familyIdx] }
    private var supportsFamily: Bool { mode.id == "product_to_model" || mode.id == "try_on" }
    /// full_family merge: combine two already-shot images into one frame.
    private var isFamilyMerge: Bool { supportsFamily && familyId == "full_family" }
    /// Role-based preset (বাবা+ছেলে…): members resolved from the library BY ROLE.
    private var familyActive: Bool {
        supportsFamily && !isFamilyMerge && familyId != "single" && CS.familyRequiredRoles[familyId] != nil
    }
    /// Multi-person renders always run on the Gemini chain (FASHN is single-person only).
    private var isMultiPersonFamily: Bool { supportsFamily && familyId != "single" }
    private var needsPrompt: Bool { mode.id == "generate" || mode.id == "edit" }

    // ── Engine truth (mirror StudioV3ImageLab) ───────────────────────────────
    private var engineOptions: [CS.Engine] { CS.engines(for: mode.id, multiPerson: isMultiPersonFamily) }
    private var selectedEngine: CS.Engine? { CS.engines.first { $0.id == engineId } }
    private var guidedKvKey: String { ["gemini", "gpt", "seedream"][min(max(guidedIdx, 0), 2)] }
    private var guidedModelId: String? {
        guard let cfg = vm.config?.genericImageModels else { return nil }
        return genMode == 0 ? cfg.standard : cfg.pro
    }
    private var guidedLabel: String {
        if let m = guidedModelId { return CS.guidedModelLabel(m) }
        return ["Nano Banana", "GPT Image 2", "Seedream 5.0"][min(max(guidedIdx, 0), 2)]
    }
    private func engineLabel(_ e: CS.Engine) -> String { e.id == "gemini" ? "Guided · \(guidedLabel)" : e.label }
    private var engineSelectable: Bool { vm.config?.isSelectable(engineId) ?? (engineId == "fashn" || engineId == "gemini") }
    /// Web `provider` — gemini lane vs fashn lane; vtonEngine carries the exact engine.
    private var provider: String { engineId == "gemini" ? "gemini" : "fashn" }
    private var engineShort: String {
        if engineId == "gemini" { return guidedLabel }
        return selectedEngine?.short ?? engineId
    }

    // ── Resolution truth (mirror buildStudioResolutionUiState) ───────────────
    private var finalEngine: String? {
        CS.finalImageEngine(mode: mode.id, engine: engineId, familyPreset: supportsFamily ? familyId : "single",
                            guided: CS.guidedEngineKey(guidedKvKey))
    }
    private var contract: CS.ResolutionContract? { finalEngine.flatMap { CS.resolutionContracts[$0] } }
    private var sourceDerivedAspect: Bool { finalEngine == "fashn" && (mode.id == "model_swap" || mode.id == "edit") }
    private var allowedAspects: [String] {
        guard let contract, contract.kind == "tiered", !sourceDerivedAspect else { return [] }
        if finalEngine == "fashn" && mode.id == "face_to_model" {
            return contract.aspects.filter { ["1:1", "4:5", "3:4", "2:3", "9:16"].contains($0) }
        }
        return contract.aspects
    }
    private var allowedTiers: [String] { contract?.kind == "tiered" ? (contract?.tiers ?? []) : [] }
    private var resolutionNote: String {
        guard let contract else { return "" }
        switch contract.kind {
        case "tiered": return sourceDerivedAspect ? "\(contract.labelBn) · আউটপুট অনুপাত সোর্স ছবি থেকে" : contract.labelBn
        case "fixed": return "\(contract.labelBn) — রেজোলিউশন/অনুপাত বাছাই প্রযোজ্য নয়"
        case "source": return contract.labelBn
        default: return contract.labelBn
        }
    }

    // mirror the web's ready/canRun exactly
    private var canRun: Bool {
        if product.uploading || model.uploading || source.uploading || source2.uploading { return false }
        if !engineOptions.contains(where: { $0.id == engineId }) || !engineSelectable { return false }
        if engineId == "fal_flux_fill" { return false } // mask repair runs from Gallery
        if needsPrompt && prompt.trimmingCharacters(in: .whitespaces).isEmpty { return false }
        if mode.id == "generate" { return true }
        if mode.id == "image_to_video" { return source.path != nil || product.path != nil || model.path != nil }
        if isFamilyMerge { return (source.path ?? product.path) != nil && source2.path != nil }
        if familyActive {
            if mode.needsProduct && product.path == nil { return false }
            return (CS.familyRequiredRoles[familyId] ?? []).allSatisfy { savedRoles.contains($0) }
        }
        if mode.needsProduct && product.path == nil { return false }
        if mode.needsModel && model.path == nil && modelId.isEmpty { return false }
        if mode.needsSource && source.path == nil { return false }
        return true
    }
    private var savedRoles: Set<String> { Set(realModels.compactMap(\.role)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            stepLabel("১ · মোড")
            modeChips
            if supportsFamily {
                stepLabel("২ · ফ্যামিলি প্রিসেট")
                familyRail
            }
            stepLabel(supportsFamily ? "৩ · ছবি যোগ করুন" : "২ · ছবি যোগ করুন")
            slots
            stepLabel(needsPrompt ? "প্রম্পট (আবশ্যক)" : "প্রম্পট (ঐচ্ছিক)")
            TextField(mode.id == "generate" ? "ক্যাম্পেইন ভিজ্যুয়ালটা বর্ণনা করুন…" : "যেমন: studio photoshoot, festive mood…",
                      text: $prompt, axis: .vertical)
                .font(.system(size: 13.5)).foregroundStyle(AgentPalette(scheme).ink)
                .padding(13).csGlass(scheme, corner: 16).padding(.horizontal, 18)
            stepLabel("ইঞ্জিন · মডেল")
            enginePicker
            options
            readiness
            runButton
        }
        .sheet(isPresented: $modelSheet) {
            CSModelPickerSheet(title: "মডেল বেছে নিন", models: realModels, selectedId: modelId,
                               allowClear: !modelId.isEmpty || model.path != nil,
                               onClear: { modelId = ""; model.clear() }) { id in
                modelId = id; model.clear()
            }
        }
        .sheet(item: Binding(get: { addRoleSheet.map { CSRoleBox(role: $0) } },
                             set: { addRoleSheet = $0?.role })) { box in
            CSAddModelSheet(vm: vm, lockedRole: box.role)
        }
        .onAppear { consumeSeed(); reconcileEngine(); reconcileResolution() }
        .onChange(of: vm.createSeed?.id) { _, _ in consumeSeed() }
        .onChange(of: mode) { _, _ in reconcileEngine(); reconcileResolution() }
        .onChange(of: familyIdx) { _, _ in reconcileEngine(); reconcileResolution() }
        .onChange(of: engineId) { _, _ in reconcileResolution() }
        .onChange(of: guidedIdx) { _, _ in reconcileResolution() }
        .onChange(of: genMode) { _, _ in reconcileResolution() }
    }

    /// Gallery → Create hand-off: the picked image becomes the source of an Edit run.
    private func consumeSeed() {
        guard let seed = vm.createSeed, seededFromGallery != seed.id else { return }
        seededFromGallery = seed.id
        vm.createSeed = nil
        if let edit = CS.modes.first(where: { $0.id == "edit" }) { mode = edit }
        product.clear(); model.clear(); source2.clear(); modelId = ""
        source.useGallery(seed)
        vm.flash("গ্যালারির ছবি source হিসেবে বসেছে — মোড বদলাতে পারেন")
    }

    /// Keep the engine inside the mode's capability set and on a live engine (web effect).
    private func reconcileEngine() {
        let options = engineOptions
        if options.contains(where: { $0.id == engineId && (vm.config?.isSelectable($0.id) ?? true) }) { return }
        if let live = options.first(where: { vm.config?.isSelectable($0.id) ?? true }) { engineId = live.id }
        else if let first = options.first { engineId = first.id }
    }

    /// Snap aspect/resolution onto the engine's contract (no false 4K promise).
    private func reconcileResolution() {
        let aspects = allowedAspects
        if !aspects.isEmpty, !aspects.contains(CS.aspects[aspect]) {
            if let i = CS.aspects.firstIndex(where: { aspects.contains($0) }) { aspect = i }
        }
        let tiers = allowedTiers
        if !tiers.isEmpty, !tiers.contains(CS.resolutions[resolution].lowercased()) {
            resolution = tiers.contains("2k") ? 1 : (CS.resolutions.firstIndex { tiers.contains($0.lowercased()) } ?? 0)
        }
    }

    private var modeChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(CS.modes) { m in
                    let locked = m.fashnOnly && vm.config?.isSelectable("fashn") != true
                    Button {
                        guard !locked else { vm.flash("এই mode-এর জন্য FASHN Pro দরকার — এখন configure করা নেই"); return }
                        if mode != m {
                            mode = m
                            // stale uploads from another mode must not flow into the next Run
                            product.clear(); model.clear(); source.clear(); source2.clear(); modelId = ""
                        }
                        CSHaptic.tap()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: m.icon).font(.system(size: 12, weight: .semibold))
                            Text(m.label).font(.system(size: 12.5, weight: mode.id == m.id ? .bold : .medium))
                            if locked { Image(systemName: "lock.fill").font(.system(size: 9)) }
                        }
                        .foregroundStyle(mode.id == m.id ? Color.white : AgentPalette(scheme).muted)
                        .padding(.vertical, 9).padding(.horizontal, 13)
                        .background {
                            if mode.id == m.id { Capsule().fill(CS.cta).shadow(color: CS.ctaGlow, radius: 6, y: 3) }
                            else { Capsule().fill(Color.white.opacity(scheme == .dark ? 0.06 : 0.5)) }
                        }
                        .opacity(locked ? 0.45 : 1)
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 18)
        }
    }

    private var familyRail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 9) {
                ForEach(Array(CS.families.enumerated()), id: \.offset) { i, name in
                    let sel = familyIdx == i
                    Button { familyIdx = i; CSHaptic.tap() } label: {
                        HStack(spacing: 7) {
                            Image(systemName: CS.familyIcons[i]).font(.system(size: 13, weight: .semibold))
                            Text(name).font(.system(size: 12.5, weight: sel ? .bold : .medium))
                        }
                        .foregroundStyle(sel ? Color.white : AgentPalette(scheme).muted)
                        .padding(.vertical, 9).padding(.horizontal, 13)
                        .background {
                            if sel { Capsule().fill(AgentPalette.coral).shadow(color: CS.ctaGlow, radius: 6, y: 3) }
                            else { Capsule().fill(Color.white.opacity(scheme == .dark ? 0.06 : 0.5)) }
                        }
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 18)
        }
    }

    @ViewBuilder
    private var slots: some View {
        VStack(spacing: 12) {
            if mode.id == "generate" {
                Text("Generate-এ কোনো product/model reference লাগে না — শুধু প্রম্পট। Grok Imagine (xAI) চালায়।")
                    .font(.system(size: 12)).foregroundStyle(AgentPalette(scheme).muted)
                    .padding(13).frame(maxWidth: .infinity, alignment: .leading).csGlass(scheme, corner: 16)
            } else if isFamilyMerge {
                CSUploadTile(slot: product, vm: vm, label: "বাবা + ছেলে ছবি (১ম)", folder: "studio-product",
                             referenceKind: "product", required: true, allowPaste: true, galleryPick: vm.readyImages)
                CSUploadTile(slot: source2, vm: vm, label: "মা + মেয়ে ছবি (২য়)", folder: "studio-source2", required: true,
                             galleryPick: vm.readyImages)
            } else {
                if mode.needsProduct || mode.id == "edit" {
                    CSUploadTile(slot: product, vm: vm,
                                 label: mode.needsProduct ? "Product / mannequin" : "Product (optional)",
                                 folder: "studio-product", referenceKind: "product", required: mode.needsProduct,
                                 allowPaste: true, projectProduct: vm.activeProject?.product,
                                 projectProductPreview: vm.activeProject?.productPreviewURL)
                }
                if familyActive {
                    familyChecklist
                } else if mode.needsModel || mode.id == "product_to_model" {
                    modelSlot
                }
                if mode.needsSource {
                    CSUploadTile(slot: source, vm: vm,
                                 label: mode.id == "image_to_video" ? "Source image for reel" : "Source image",
                                 folder: "studio-source", referenceKind: "product", required: true,
                                 allowPaste: true, galleryPick: vm.readyImages)
                }
            }
        }.padding(.horizontal, 18)
    }

    /// Unified model input: saved model OR uploaded photo (mutually exclusive).
    private var modelSlot: some View {
        Button { modelSheet = true; CSHaptic.tap() } label: {
            HStack(spacing: 12) {
                Group {
                    if let m = realModels.first(where: { $0.id == modelId }) {
                        CSPhoto(url: m.imageURL, ratio: 1)
                    } else if let ui = model.image {
                        Image(uiImage: ui).resizable().scaledToFill()
                    } else {
                        Image(systemName: "person.fill").font(.system(size: 20))
                            .foregroundStyle(AgentPalette(scheme).muted)
                    }
                }
                .frame(width: 54, height: 54).background(Color.white.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    if let m = realModels.first(where: { $0.id == modelId }) {
                        Text(m.name ?? "মডেল").font(.system(size: 14, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                        Text("সেভ করা মডেল · \(CS.roleBn(m.role))").font(.system(size: 11)).foregroundStyle(AgentPalette(scheme).muted)
                    } else if model.image != nil {
                        Text(model.uploading ? "আপলোড হচ্ছে…" : "নতুন আপলোড করা ছবি").font(.system(size: 14, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                        Text("ট্যাপ করে বদলান").font(.system(size: 11)).foregroundStyle(AgentPalette(scheme).muted)
                    } else {
                        Text("Model\(mode.needsModel ? " *" : "")").font(.system(size: 14, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                        Text("ট্যাপ করুন — সেভ করা মডেল বা নতুন ছবি").font(.system(size: 11)).foregroundStyle(AgentPalette(scheme).muted)
                    }
                }
                Spacer()
                Text(modelId.isEmpty && model.image == nil ? "বেছে নিন" : "বদলান")
                    .font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette.coral)
                    .padding(.vertical, 6).padding(.horizontal, 11)
                    .background(AgentPalette.coral.opacity(0.13), in: Capsule())
            }
            .padding(11).csGlass(scheme, corner: 18)
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.4, dash: [6]))
                .foregroundStyle(AgentPalette.coral.opacity(modelId.isEmpty && model.image == nil ? 0.35 : 0)))
        }.buttonStyle(.plain)
    }

    /// Pre-Run family checklist — roles come from the library; missing → add sheet.
    private var familyChecklist: some View {
        let required = CS.familyRequiredRoles[familyId] ?? []
        let byRole = Dictionary(grouping: realModels.filter { $0.role != nil }, by: { $0.role! }).compactMapValues(\.first)
        let missing = required.filter { byRole[$0] == nil }
        return VStack(alignment: .leading, spacing: 8) {
            Text("এই ফ্যামিলি শটে যা লাগবে \(missing.isEmpty ? "· সব প্রস্তুত ✅" : "· \(almaBn(missing.count))টি বাকি")")
                .font(.system(size: 12.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
            ForEach(required, id: \.self) { role in
                HStack(spacing: 10) {
                    Group {
                        if let m = byRole[role] { CSPhoto(url: m.imageURL, ratio: 1) }
                        else { Image(systemName: "person.fill").font(.system(size: 14)).foregroundStyle(AgentPalette(scheme).muted) }
                    }
                    .frame(width: 38, height: 38).background(Color.white.opacity(0.05))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(CS.roleBn(role)).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(AgentPalette(scheme).ink)
                        Text(byRole[role]?.name ?? "সেভ করা নেই").font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                    }
                    Spacer()
                    if byRole[role] != nil {
                        Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(AgentPalette.teal)
                    } else {
                        Button { addRoleSheet = role; CSHaptic.tap() } label: {
                            Text("যোগ করুন").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                                .padding(.vertical, 6).padding(.horizontal, 12)
                                .background(AgentPalette.coral, in: Capsule())
                        }.buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(13).csGlass(scheme, corner: 18)
    }

    /// Web "Provider / model" select: exact engines for the mode with Live / Unavailable /
    /// Killed truth from the registry; the guided lane shows the owner-selected render model.
    private var enginePicker: some View {
        VStack(alignment: .leading, spacing: 9) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(engineOptions) { e in
                        let avail = vm.config?.engine(e.id)
                        let live = vm.config?.isSelectable(e.id) ?? (e.id == "fashn" || e.id == "gemini")
                        let status = avail?.killed == true ? "Killed" : (live ? "Live" : "Unavailable")
                        Button {
                            if live { engineId = e.id; CSHaptic.tap() }
                            else { vm.flash("\(e.label) এখন \(status) — \(avail?.warningBn ?? "server config দেখুন")") }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(engineLabel(e)).font(.system(size: 12.5, weight: engineId == e.id ? .bold : .semibold))
                                HStack(spacing: 4) {
                                    Circle().fill(live ? AgentPalette.teal : Color.orange).frame(width: 6, height: 6)
                                    Text(status + (avail?.approxCost.map { " · \($0)" } ?? ""))
                                        .font(.system(size: 10)).lineLimit(1)
                                }
                            }
                            .foregroundStyle(engineId == e.id ? Color.white : AgentPalette(scheme).muted)
                            .padding(.vertical, 8).padding(.horizontal, 12)
                            .background {
                                if engineId == e.id { RoundedRectangle(cornerRadius: 13, style: .continuous).fill(CS.cta).shadow(color: CS.ctaGlow, radius: 6, y: 3) }
                                else { RoundedRectangle(cornerRadius: 13, style: .continuous).fill(Color.white.opacity(scheme == .dark ? 0.06 : 0.5)) }
                            }
                            .opacity(live ? 1 : 0.55)
                        }.buttonStyle(.plain)
                    }
                }.padding(.horizontal, 18)
            }
            if engineId == "gemini" {
                HStack(spacing: 6) {
                    ForEach(Array(["Nano Banana", "GPT Image 2", "Seedream 5.0"].enumerated()), id: \.offset) { i, name in
                        CSChip(text: name, on: guidedIdx == i) {
                            guidedIdx = i
                            Task { await vm.saveSettings(imageEngine: ["gemini", "gpt", "seedream"][i]) }
                        }
                    }
                }.padding(.horizontal, 18)
            }
            if let note = selectedEngine?.fidelityBn[mode.id] {
                Label(note, systemImage: "info.circle").font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                    .padding(.horizontal, 18)
            }
            if engineId == "fal_flux_fill" {
                Label("Mask repair Gallery-র যেকোনো ছবির \"Precision repair\" থেকে চালান।", systemImage: "paintbrush.pointed")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(AgentPalette.coral).padding(.horizontal, 18)
            }
        }
    }

    @ViewBuilder
    private var options: some View {
        if mode.id == "image_to_video" {
            stepLabel("ভাইব")
            CSChipRow(items: CS.vibes.map(\.bn), selectionIndex: $vibe)
            stepLabel("রিলের দৈর্ঘ্য")
            HStack(spacing: 8) {
                ForEach(CS.reelDurations, id: \.self) { d in
                    CSChip(text: "\(almaBn(d))s", on: durationSec == d) { durationSec = d }
                }
            }.padding(.horizontal, 18)
            Text(durationSec >= 16 ? "\(durationSec == 16 ? "২" : "৩") × ৮ সেকেন্ড Veo chain, তারপর deterministic ffmpeg assembly · 720p delivery"
                                   : "এক Veo clip · 720p verified delivery · অনুপাত 9:16")
                .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted).padding(.horizontal, 18).padding(.top, 8)
        } else {
            stepLabel("ব্যাকগ্রাউন্ড")
            CSChipRow(items: CS.backgrounds.map(\.label), selectionIndex: $bgIdx)
            stepLabel("অ্যাসপেক্ট · রেজোলিউশন · কোয়ালিটি")
            if allowedAspects.isEmpty && allowedTiers.isEmpty {
                Text(resolutionNote).font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).muted)
                    .padding(13).frame(maxWidth: .infinity, alignment: .leading).csGlass(scheme, corner: 14).padding(.horizontal, 18)
            } else {
                if !allowedAspects.isEmpty { aspectRow } else {
                    Text(resolutionNote).font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted).padding(.horizontal, 18)
                }
                HStack(spacing: 8) {
                    ForEach(Array(CS.resolutions.enumerated()), id: \.offset) { i, r in
                        let ok = allowedTiers.contains(r.lowercased())
                        CSChip(text: ok ? r : "\(r) ✕", on: resolution == i) {
                            if ok { resolution = i } else { vm.flash("\(r) এই ইঞ্জিনে delivered হয় না — \(contract?.labelBn ?? "")") }
                        }.opacity(ok ? 1 : 0.45)
                    }
                }.padding(.horizontal, 18).padding(.top, 10)
                Text("\(resolutionNote) · delivered pixels Gallery-তে verify হবে")
                    .font(.system(size: 10)).foregroundStyle(AgentPalette(scheme).muted).padding(.horizontal, 18).padding(.top, 6)
            }
            CSSegment(items: CS.genModes, index: $genMode).padding(.horizontal, 18).padding(.top, 10)
            stepLabel("কয়টি ছবি")
            HStack(spacing: 10) {
                ForEach(1...4, id: \.self) { n in
                    CSChip(text: almaBn(n), on: numImages == n) { numImages = n }
                }
            }.padding(.horizontal, 18)
        }
    }

    private var aspectRow: some View {
        HStack(spacing: 10) {
            ForEach(Array(CS.aspects.enumerated()), id: \.offset) { i, r in
                let sel = aspect == i
                let ok = allowedAspects.contains(r)
                let sz = CS.ratioBox(r, maxSide: 30)
                Button {
                    if ok { aspect = i; CSHaptic.tap() } else { vm.flash("\(r) এই ইঞ্জিনে সমর্থিত নয়") }
                } label: {
                    VStack(spacing: 7) {
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(sel ? AgentPalette.coral.opacity(0.22) : Color.white.opacity(0.06))
                            .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous)
                                .strokeBorder(sel ? AgentPalette.coral : Color.white.opacity(0.32), lineWidth: sel ? 2 : 1.5))
                            .frame(width: sz.width, height: sz.height)
                            .frame(height: 34)
                        Text(r).font(.system(size: 11.5, weight: sel ? .bold : .medium))
                            .foregroundStyle(sel ? AgentPalette.coral : AgentPalette(scheme).muted)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                    .background(RoundedRectangle(cornerRadius: AlmaSwiftTheme.rControl, style: .continuous)
                        .fill(sel ? AgentPalette.coral.opacity(0.1) : Color.white.opacity(scheme == .dark ? 0.03 : 0.28)))
                    .opacity(ok ? 1 : 0.4)
                }.buttonStyle(.plain)
            }
        }.padding(.horizontal, 18)
    }

    /// Web readiness strip: what blocks the run, and the fidelity truth of the engine.
    private var readiness: some View {
        HStack(spacing: 10) {
            Image(systemName: canRun ? "checkmark.seal.fill" : "lock.fill")
                .foregroundStyle(canRun ? AgentPalette.teal : Color.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(canRun ? "Configuration ready — owner cost review পরের ধাপ" : "প্রয়োজনীয় context এখনো অসম্পূর্ণ")
                    .font(.system(size: 12.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                Text(canRun ? "\(engineShort) · \(resolutionNote.isEmpty ? "video" : resolutionNote) · \(CS.genModes[genMode])"
                            : blockerText)
                    .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted).lineLimit(2)
            }
            Spacer()
        }
        .padding(12).csGlass(scheme, corner: 14).padding(.horizontal, 18).padding(.top, 18)
    }
    private var blockerText: String {
        if !engineSelectable { return "\(selectedEngine?.label ?? engineId) এখন চালু নেই — অন্য ইঞ্জিন বাছুন" }
        if engineId == "fal_flux_fill" { return "FLUX Fill শুধু Gallery-র Precision repair থেকে চলে" }
        if needsPrompt && prompt.trimmingCharacters(in: .whitespaces).isEmpty { return "প্রম্পট লিখুন" }
        if mode.needsProduct && product.path == nil { return "Product ছবি দিন (Paste / প্রজেক্ট প্রোডাক্ট / আপলোড)" }
        if mode.needsModel && model.path == nil && modelId.isEmpty { return "সেভ করা মডেল বাছুন বা মডেল ছবি দিন" }
        if mode.needsSource && source.path == nil { return "Source ছবি দিন (গ্যালারি বা আপলোড)" }
        if familyActive { return "ফ্যামিলি রোলের সব মডেল লাইব্রেরিতে লাগবে" }
        return "ছবি আপলোড শেষ হতে দিন"
    }

    private var runButton: some View {
        VStack(spacing: 7) {
            Button { CSHaptic.tap(); Task { await run() } } label: {
                HStack(spacing: 9) {
                    if vm.generating { ProgressView().tint(.white) }
                    else { Image(systemName: "wand.and.stars").font(.system(size: 17, weight: .semibold)) }
                    Text(vm.generating ? "Estimate আনা হচ্ছে…" : "Review & generate — \(engineShort)")
                        .font(.system(size: 16, weight: .bold))
                }
                .foregroundStyle(.white).frame(maxWidth: .infinity).padding(16)
                .background(CS.cta, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                .shadow(color: CS.ctaGlow, radius: 16, y: 9)
                .opacity(canRun && !vm.generating ? 1 : 0.45)
            }
            .buttonStyle(.plain).disabled(!canRun || vm.generating)
            Text(isMultiPersonFamily && engineId == "fashn"
                 ? "একাধিক মানুষ — FASHN chain + Gemini rescene দিয়ে হবে"
                 : "Run-এর আগে signed estimate ও owner confirmation দেখাবে")
                .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted).frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 18).padding(.top, 14)
    }

    private func run() async {
        guard canRun else { vm.flash(blockerText); return }
        let bg = CS.backgrounds[bgIdx]
        var payload = CSRunPayload(mode: mode.id)
        payload.studioSurface = "v3"
        payload.provider = provider
        let isVton = mode.id == "product_to_model" || mode.id == "try_on"
        // Web buildRequest: vtonEngine carries the exact engine for VTON modes and Grok.
        payload.vtonEngine = (engineId == "xai_imagine" || isVton) ? engineId : nil
        payload.productImagePath = product.path ?? (mode.id == "image_to_video" ? source.path : nil)
        payload.productReferenceId = product.referenceId ?? source.referenceId
        payload.modelImagePath = model.path
        payload.modelReferenceId = model.referenceId
        payload.sourceImagePath = source.path ?? (mode.needsSource ? (product.path ?? model.path) : nil)
        payload.secondSourceImagePath = isFamilyMerge ? source2.path : nil
        payload.modelId = (modelId.isEmpty || model.path != nil) ? nil : modelId
        payload.familyPreset = supportsFamily ? familyId : nil
        payload.prompt = prompt.isEmpty ? nil : prompt
        payload.backgroundPrompt = bg.id != "custom" ? bg.prompt : (prompt.isEmpty ? nil : prompt)
        // Gallery source lineage (sourcePendingActionId / sourceAssetIds on the run).
        if let seed = source.sourceItem ?? product.sourceItem {
            payload.sourcePendingActionId = seed.id
            payload.sourceAssetIds = seed.projectAssetId.map { [$0] }
        }
        if mode.id == "image_to_video" {
            payload.vibe = CS.vibes[vibe].id
            payload.durationSec = durationSec
        } else if mode.id == "generate" {
            payload.aspectRatio = allowedAspects.isEmpty ? nil : CS.aspects[aspect]
            payload.resolution = allowedTiers.isEmpty ? nil : CS.resolutions[resolution].lowercased()
            payload.generationMode = CS.genModes[genMode].lowercased()
            payload.numImages = numImages
        } else {
            if !allowedAspects.isEmpty { payload.aspectRatio = CS.aspects[aspect] }
            if !allowedTiers.isEmpty { payload.resolution = CS.resolutions[resolution].lowercased() }
            payload.generationMode = CS.genModes[genMode].lowercased()
            payload.numImages = numImages
        }
        _ = await vm.run(payload)
    }

    private func stepLabel(_ s: String) -> some View {
        Text(s.uppercased()).font(.system(size: 12, weight: .bold)).tracking(0.6)
            .foregroundStyle(AgentPalette(scheme).muted).padding(.horizontal, 22).padding(.top, 20).padding(.bottom, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}


/// Identifiable box so a plain role string can drive a .sheet(item:).
private struct CSRoleBox: Identifiable { let role: String; var id: String { role } }

// ── Shared: photo upload tile bound to a CSSlot ──────────────────────────────

@available(iOS 17.0, *)
struct CSUploadTile: View {
    @Bindable var slot: CSSlot
    let vm: CreativeStudioVM
    let label: String
    let folder: String
    var referenceKind: String? = nil
    var required = false
    var height: CGFloat = 190
    /// Extra source actions (web source card: Paste · project product · Gallery).
    var allowPaste = false
    var projectProduct: CSProjectProduct? = nil
    var projectProductPreview: URL? = nil
    var galleryPick: [CSGalleryItem]? = nil
    @Environment(\.colorScheme) private var scheme
    @State private var galleryOpen = false

    var body: some View {
        VStack(spacing: 8) {
            PhotosPicker(selection: $slot.picked, matching: .images) {
                ZStack {
                    if slot.hasImage {
                        Group {
                            if let ui = slot.image {
                                Image(uiImage: ui).resizable().scaledToFill()
                            } else {
                                CSPhoto(url: slot.remoteURL, ratio: 1)
                            }
                        }
                        .frame(height: height).frame(maxWidth: .infinity).clipped()
                        .overlay(alignment: .bottomLeading) {
                            Label(slot.uploading ? "আপলোড হচ্ছে…" : (slot.origin ?? "ছবি যোগ হয়েছে"),
                                  systemImage: slot.uploading ? "arrow.up.circle" : "checkmark")
                                .font(.system(size: 12, weight: .bold)).foregroundStyle(.white).lineLimit(1)
                                .padding(.vertical, 7).padding(.horizontal, 13)
                                .background(.black.opacity(0.55), in: Capsule()).padding(12)
                        }
                        .overlay(alignment: .bottomTrailing) {
                            Text("বদলান").font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                                .padding(.vertical, 7).padding(.horizontal, 14)
                                .background(.white.opacity(0.18), in: Capsule()).padding(12)
                        }
                    } else {
                        VStack(spacing: 10) {
                            ZStack { RoundedRectangle(cornerRadius: 16).fill(CS.cta).frame(width: 50, height: 50)
                                Image(systemName: "plus").font(.system(size: 22, weight: .bold)).foregroundStyle(.white) }
                                .shadow(color: CS.ctaGlow, radius: 11, y: 6)
                            Text(label + (required ? " *" : "")).font(.system(size: 14.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                            Text("ট্যাপ করে ছবি দিন").font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).muted)
                        }
                        .frame(maxWidth: .infinity).frame(height: height)
                    }
                }
                .background(AgentPalette(scheme).glassFill)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.6, dash: slot.hasImage ? [] : [7]))
                    .foregroundStyle(slot.hasImage ? AgentPalette.coral.opacity(0.5) : Color.white.opacity(0.2)))
            }
            .buttonStyle(.plain)
            .onChange(of: slot.picked) { _, new in
                Task { await slot.load(new, vm: vm, folder: folder, referenceKind: referenceKind) }
            }

            if allowPaste || projectProduct != nil || galleryPick != nil {
                HStack(spacing: 8) {
                    if allowPaste {
                        sourceChip("Paste", "doc.on.clipboard") {
                            Task {
                                if await !slot.pasteFromClipboard(vm: vm, folder: folder, referenceKind: referenceKind) {
                                    vm.flash("ক্লিপবোর্ডে কোনো ছবি নেই")
                                }
                            }
                        }
                    }
                    if let projectProduct, projectProduct.sourceImage != nil {
                        sourceChip("প্রজেক্ট প্রোডাক্ট · \(projectProduct.code)", "tag") { slot.useProjectProduct(projectProduct, previewURL: projectProductPreview) }
                    }
                    if galleryPick != nil {
                        sourceChip("গ্যালারি", "photo.on.rectangle.angled") { galleryOpen = true }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .sheet(isPresented: $galleryOpen) {
            CSGalleryPickerSheet(title: "গ্যালারি থেকে ছবি বাছুন", items: galleryPick ?? [],
                                 selectedId: slot.sourceItem?.id) { item in slot.useGallery(item) }
        }
    }

    private func sourceChip(_ title: String, _ icon: String, _ tap: @escaping () -> Void) -> some View {
        Button { tap(); CSHaptic.tap() } label: {
            Label(title, systemImage: icon).font(.system(size: 11.5, weight: .bold)).lineLimit(1)
                .foregroundStyle(AgentPalette.coral)
                .padding(.vertical, 7).padding(.horizontal, 11)
                .background(AgentPalette.coral.opacity(0.12), in: Capsule())
        }.buttonStyle(.plain)
    }
}

// ── Shared: saved-model picker sheet (Auto + Advanced + Library reuse) ───────

@available(iOS 17.0, *)
struct CSModelPickerSheet: View {
    let title: String
    let models: [CSModel]
    let selectedId: String
    var allowClear = false
    var onClear: (() -> Void)? = nil
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(title).font(.system(size: 17, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
                    .padding(.top, 20)
                if models.isEmpty {
                    Text("লাইব্রেরিতে কোনো সেভ করা মডেল নেই — লাইব্রেরি ট্যাবে গিয়ে মডেল সেভ করুন।")
                        .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).muted)
                        .padding(13).frame(maxWidth: .infinity, alignment: .leading).csGlass(scheme, corner: 14)
                } else {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                        ForEach(models) { m in
                            Button { onPick(m.id); dismiss(); CSHaptic.tap() } label: {
                                CSPhoto(url: m.imageURL, ratio: 0.75)
                                    .overlay(alignment: .bottomLeading) {
                                        Text(m.name ?? "").font(.system(size: 10.5, weight: .bold)).foregroundStyle(.white)
                                            .lineLimit(1).padding(7).frame(maxWidth: .infinity, alignment: .leading)
                                            .background(LinearGradient(colors: [.black.opacity(0.8), .clear], startPoint: .bottom, endPoint: .top))
                                    }
                                    .overlay(alignment: .topTrailing) {
                                        if selectedId == m.id {
                                            Image(systemName: "checkmark").font(.system(size: 10, weight: .heavy)).foregroundStyle(.white)
                                                .padding(5).background(AgentPalette.coral, in: Circle()).padding(6)
                                        }
                                    }
                                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                                        .strokeBorder(selectedId == m.id ? AgentPalette.coral : .white.opacity(0.1),
                                                      lineWidth: selectedId == m.id ? 2 : 1))
                            }.buttonStyle(.plain)
                        }
                    }
                }
                if allowClear, let onClear {
                    Button { onClear(); dismiss() } label: {
                        Text("বাছাই বাদ দিন").font(.system(size: 12.5, weight: .semibold))
                            .foregroundStyle(AgentPalette(scheme).muted)
                            .frame(maxWidth: .infinity).padding(12).csGlass(scheme, corner: 14)
                    }.buttonStyle(.plain)
                }
            }.padding(.horizontal, 18).padding(.bottom, 30)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationBackground { AgentAuroraBackground() }
    }
}

// ── Shared: add-model sheet (Create family checklist + Library) ─────────────

@available(iOS 17.0, *)
struct CSAddModelSheet: View {
    let vm: CreativeStudioVM
    var lockedRole: String? = nil
    @State private var slot = CSSlot()
    @State private var name = ""
    @State private var role: String
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme

    init(vm: CreativeStudioVM, lockedRole: String? = nil) {
        self.vm = vm
        self.lockedRole = lockedRole
        _role = State(initialValue: lockedRole ?? "single")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(lockedRole.map { "\(CS.roleBn($0)) মডেল যোগ করুন" } ?? "নতুন মডেল যোগ করুন")
                    .font(.system(size: 17, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
                    .padding(.top, 20)
                CSUploadTile(slot: slot, vm: vm, label: "ফুল-বডি ছবি", folder: "model-library", required: true, height: 220)
                VStack(alignment: .leading, spacing: 6) {
                    Text("নাম").font(.system(size: 11, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                    TextField("যেমন: Maruf", text: $name)
                        .font(.system(size: 14)).foregroundStyle(AgentPalette(scheme).ink)
                        .padding(12).csGlass(scheme, corner: 14)
                }
                if lockedRole == nil {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("ধরন").font(.system(size: 11, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                        CSRoleChips(items: CS.modelRoles.map(\.bn), selectedIdx: CS.modelRoles.firstIndex { $0.id == role } ?? 0) { i in
                            role = CS.modelRoles[i].id
                        }
                    }
                } else {
                    Text("ধরন: \(CS.roleBn(lockedRole))").font(.system(size: 12.5, weight: .bold)).foregroundStyle(AgentPalette.coral)
                }
                Button {
                    CSHaptic.tap()
                    Task {
                        guard let path = slot.path, !name.trimmingCharacters(in: .whitespaces).isEmpty else {
                            vm.flash("নাম আর ছবি — দুটোই দরকার"); return
                        }
                        saving = true
                        let ok = await vm.addModel(name: name.trimmingCharacters(in: .whitespaces), role: role, imagePath: path)
                        saving = false
                        if ok { dismiss() }
                    }
                } label: {
                    HStack(spacing: 8) {
                        if saving || slot.uploading { ProgressView().tint(.white) }
                        Text(saving ? "সেভ হচ্ছে…" : slot.uploading ? "ছবি আপলোড হচ্ছে…" : "সেভ করুন")
                            .font(.system(size: 15, weight: .bold))
                    }
                    .foregroundStyle(.white).frame(maxWidth: .infinity).padding(15)
                    .background(CS.cta, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .opacity(slot.path != nil && !name.trimmingCharacters(in: .whitespaces).isEmpty && !saving ? 1 : 0.45)
                }
                .buttonStyle(.plain)
                .disabled(slot.path == nil || name.trimmingCharacters(in: .whitespaces).isEmpty || saving || slot.uploading)
            }.padding(.horizontal, 18).padding(.bottom, 30)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground { AgentAuroraBackground() }
    }
}

/// Simple wrapping chip row used by the add-model role picker.
@available(iOS 17.0, *)
private struct CSRoleChips: View {
    let items: [String]
    let selectedIdx: Int
    let onPick: (Int) -> Void
    var body: some View {
        // few items — a wrapping HStack pair suffices without a layout engine
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) { chips(0..<min(3, items.count)) }
            if items.count > 3 { HStack(spacing: 8) { chips(3..<items.count) } }
        }
    }
    @ViewBuilder private func chips(_ range: Range<Int>) -> some View {
        ForEach(Array(range), id: \.self) { i in
            CSChip(text: items[i], on: selectedIdx == i) { onPick(i) }
        }
    }
}

@available(iOS 17.0, *)
private struct CSInlineToggle: View {
    let title: String; let sub: String
    @Binding var on: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Button { on.toggle(); CSHaptic.tap() } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                    Text(sub).font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                }
                Spacer()
                Capsule().fill(on ? AgentPalette.coral : Color.white.opacity(0.15))
                    .frame(width: 40, height: 24)
                    .overlay(alignment: on ? .trailing : .leading) {
                        Circle().fill(.white).frame(width: 20, height: 20).padding(2)
                    }
            }
            .padding(13).csGlass(scheme, corner: 18)
        }.buttonStyle(.plain)
    }
}

// MARK: - GALLERY (web parity: pending progress, retry, branded toggle, finishing)

@available(iOS 17.0, *)
private struct CSGalleryTab: View {
    let vm: CreativeStudioVM
    var go: (CSTab) -> Void = { _ in }
    @Environment(\.colorScheme) private var scheme
    @State private var detail: CSGalleryItem?
    @State private var deleteTarget: CSGalleryItem?

    private var columns: [GridItem] {
        vm.galleryDensity == "comfortable"
            ? [GridItem(.flexible())]
            : [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]
    }

    /// Category lanes (web: All · Image · Video · Audio · Voice · Avatar) + lifecycle
    /// (Recent · Approved · Review · Archived) + the native posted/pending split.
    private let filterMap: [(bn: String, key: String)] =
        [("সব", "all"), ("ছবি", "image"), ("ভিডিও", "video"), ("অডিও", "audio"), ("অ্যাভাটার", "avatar"), ("ভয়েস", "voice"),
         ("Approved", "approved"), ("Review", "review"), ("Archived", "archived"), ("পোস্ট হয়েছে", "executed"), ("পেন্ডিং", "pending")]
    private var identityLane: Bool { vm.galleryFilter == "avatar" || vm.galleryFilter == "voice" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(almaBn(max(vm.galleryTotal, vm.gallery.filter { !$0.id.hasPrefix("sample-") }.count)))টি server result · \(vm.activeProject?.name ?? "সব project")")
                        .font(.system(size: 10, weight: .bold)).tracking(1.2)
                        .foregroundStyle(AgentPalette.coralLt).lineLimit(1)
                    Text("গ্যালারি").font(.system(size: 30, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
                }.padding(.top, 58).padding(.horizontal, 18)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(filterMap.enumerated()), id: \.offset) { _, f in
                            CSChip(text: f.bn, on: vm.galleryFilter == f.key) {
                                vm.galleryFilter = f.key
                                CSHaptic.tap()
                                if f.key == "voice" { Task { await vm.loadVoices() } }
                                else if f.key != "avatar" { Task { await vm.refreshGallery() } }
                            }
                        }
                    }.padding(.horizontal, 18)
                }.padding(.top, 14)

                VStack(spacing: 10) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(AgentPalette(scheme).muted)
                        TextField("Title, product code, mode বা provider", text: Binding(
                            get: { vm.gallerySearch }, set: { vm.gallerySearch = $0 }))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .submitLabel(.search)
                            .onSubmit { Task { await vm.refreshGallery() } }
                            .font(.system(size: 12.5))
                        if !vm.gallerySearch.isEmpty {
                            Button {
                                vm.gallerySearch = ""
                                Task { await vm.refreshGallery() }
                            } label: { Image(systemName: "xmark.circle.fill") }
                                .foregroundStyle(AgentPalette(scheme).muted)
                        }
                    }
                    .padding(.horizontal, 12).frame(height: 42).csGlass(scheme, corner: 13)

                    HStack(spacing: 8) {
                        galleryMenu("Provider", value: vm.galleryProvider,
                                    values: vm.galleryProviders) { vm.galleryProvider = $0; Task { await vm.refreshGallery() } }
                        galleryMenu("Aspect", value: vm.galleryAspect,
                                    values: vm.galleryAspects) { vm.galleryAspect = $0; Task { await vm.refreshGallery() } }
                        Menu {
                            Button("Newest") { vm.gallerySort = "newest"; Task { await vm.refreshGallery() } }
                            Button("Oldest") { vm.gallerySort = "oldest"; Task { await vm.refreshGallery() } }
                            Button("Name") { vm.gallerySort = "name" }
                            Button("Cost") { vm.gallerySort = "cost" }
                        } label: {
                            Label(["oldest": "Oldest", "name": "Name", "cost": "Cost"][vm.gallerySort] ?? "Newest",
                                  systemImage: "arrow.up.arrow.down")
                        }
                        .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(AgentPalette(scheme).ink)
                        Spacer(minLength: 0)
                        Menu {
                            Button("Compact grid") { vm.galleryDensity = "compact" }
                            Button("Comfortable") { vm.galleryDensity = "comfortable" }
                            Button("List") { vm.galleryDensity = "list" }
                        } label: {
                            Image(systemName: vm.galleryDensity == "list" ? "list.bullet" : "square.grid.2x2")
                                .font(.system(size: 14, weight: .bold))
                        }.foregroundStyle(AgentPalette.coralLt)
                    }
                }.padding(.horizontal, 18).padding(.top, 10)

                // Live "still cooking" banner — the owner KNOWS work is happening after Run.
                if vm.pendingCount > 0 {
                    HStack(spacing: 10) {
                        ProgressView().tint(AgentPalette.coral).controlSize(.small)
                        Text("\(almaBn(vm.pendingCount))টি ছবি/ভিডিও তৈরি হচ্ছে… একটু পর নিচে দেখা যাবে, Boss")
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(AgentPalette.coral)
                    }
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .csGlass(scheme, corner: 14).padding(.horizontal, 18).padding(.top, 12)
                }

                if identityLane {
                    identityLaneView.padding(18)
                } else if vm.gallery.isEmpty {
                    CSEmpty(loading: vm.loading).padding(.top, 40)
                } else {
                    Group {
                        if vm.galleryDensity == "list" {
                            LazyVStack(spacing: 10) {
                                ForEach(vm.filteredGallery) { item in galleryItem(item, list: true) }
                            }
                        } else {
                            LazyVGrid(columns: columns, spacing: 12) {
                                ForEach(vm.filteredGallery) { item in galleryItem(item, list: false) }
                            }
                        }
                    }.padding(18)
                    if vm.galleryHasMore {
                        Button { Task { await vm.loadMoreGallery() }; CSHaptic.tap() } label: {
                            HStack(spacing: 8) {
                                if vm.galleryLoadingMore { ProgressView().tint(AgentPalette.coral).controlSize(.small) }
                                Text(vm.galleryLoadingMore ? "লোড হচ্ছে…" : "আরও production asset লোড করুন")
                                    .font(.system(size: 13, weight: .bold))
                            }
                            .foregroundStyle(AgentPalette.coral).frame(maxWidth: .infinity).padding(13)
                            .csGlass(scheme, corner: 14)
                        }.buttonStyle(.plain).disabled(vm.galleryLoadingMore).padding(.horizontal, 18)
                    }
                }
                Color.clear.frame(height: 96)
            }
        }
        .claudeTopFade(useNativeEdgeEffect: false)
        .refreshable { await vm.loadAll() }
        // Poll ONLY while something is rendering (web parity: 4s rhythm, stop when idle).
        .task(id: vm.pendingCount > 0) {
            guard vm.pendingCount > 0 else { return }
            while !Task.isCancelled && vm.pendingCount > 0 {
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                await vm.refreshGallery()
            }
        }
        .sheet(item: $detail) { item in
            CSDetailSheet(item: item, vm: vm, siblings: vm.filteredGallery.filter { $0.previewUrl != nil },
                          onCreateFrom: { seed in
                              vm.createSeed = seed
                              detail = nil
                              go(.create)
                          },
                          onReelFrom: { seed in
                              vm.reelSeed = seed
                              detail = nil
                              go(.video)
                          })
                .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .alert("ছবিটা একেবারে মুছে যাবে — নিশ্চিত?",
               isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } })) {
            Button("বাতিল", role: .cancel) {}
            Button("মুছে ফেলুন", role: .destructive) {
                if let t = deleteTarget { Task { _ = await vm.deleteItem(t) } }
            }
        } message: { Text("ফাইলটাও স্টোরেজ থেকে মুছে যাবে, ফেরত আনা যাবে না।") }
    }

    /// Avatar / Voice lanes — identity is production context, not generic media (web Gallery).
    @ViewBuilder private var identityLaneView: some View {
        if vm.galleryFilter == "avatar" {
            if vm.realModels.isEmpty {
                Text("এই scope-এ saved identity নেই — লাইব্রেরি ট্যাবে মডেল সেভ করুন।")
                    .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).muted)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(13).csGlass(scheme, corner: 14)
            } else {
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(vm.realModels) { m in
                        CSPhoto(url: m.imageURL, ratio: 0.78)
                            .overlay(alignment: .bottomLeading) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(m.name ?? "মডেল").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                                    Text(CS.roleBn(m.role).isEmpty ? (m.role ?? "identity") : CS.roleBn(m.role))
                                        .font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.7))
                                    Button { go(.create); CSHaptic.tap() } label: {
                                        Label("Create-এ ব্যবহার", systemImage: "arrow.right").font(.system(size: 10.5, weight: .bold))
                                            .foregroundStyle(.white).padding(.vertical, 6).padding(.horizontal, 10)
                                            .background(AgentPalette.coral, in: Capsule())
                                    }.buttonStyle(.plain)
                                }.padding(11).frame(maxWidth: .infinity, alignment: .leading)
                                .background(LinearGradient(colors: [.black.opacity(0.85), .clear], startPoint: .bottom, endPoint: .center))
                            }
                            .overlay(alignment: .topLeading) {
                                if m.isDefault == true {
                                    Text("Default").font(.system(size: 9.5, weight: .bold)).foregroundStyle(Color(red: 0.17, green: 0.12, blue: 0))
                                        .padding(.vertical, 4).padding(.horizontal, 8)
                                        .background(Color(red: 0.91, green: 0.72, blue: 0.27), in: Capsule()).padding(9)
                                }
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    }
                }
            }
        } else {
            if vm.voices.isEmpty {
                Text("এই scope-এ owner voice নেই — অডিও ট্যাবে consented sample দিয়ে clone করুন।")
                    .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).muted)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(13).csGlass(scheme, corner: 14)
            } else {
                VStack(spacing: 10) {
                    ForEach(vm.voices) { v in
                        HStack(spacing: 12) {
                            Image(systemName: "waveform.badge.mic").font(.system(size: 20)).foregroundStyle(AgentPalette.coralLt).frame(width: 40)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(v.name).font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                                Text("\(v.provider) · \(almaBn(v.versions.count)) version · active \(v.activeVersionId.map { id in v.versions.first { $0.id == id }.map { "v\($0.version)" } ?? "—" } ?? "none")")
                                    .font(.system(size: 11)).foregroundStyle(AgentPalette(scheme).muted)
                            }
                            Spacer()
                            Text(v.activeVersionId == nil ? "Inactive" : "Active").font(.system(size: 9.5, weight: .bold))
                                .foregroundStyle(v.activeVersionId == nil ? AgentPalette.coralLt : .green)
                                .padding(.horizontal, 8).padding(.vertical, 4).background(Color.white.opacity(0.08), in: Capsule())
                        }
                        .padding(12).csGlass(scheme, corner: 15)
                    }
                    Text("Activate / revoke / delete → লাইব্রেরি → V4 Production Workspace → Voice").font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                }
            }
        }
    }

    private func galleryMenu(_ label: String, value: String, values: [String], set: @escaping (String) -> Void) -> some View {
        Menu {
            Button("All \(label.lowercased())s") { set("all") }
            ForEach(values, id: \.self) { option in Button(option) { set(option) } }
        } label: {
            Text(value == "all" ? label : value).lineLimit(1)
        }
        .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(AgentPalette(scheme).ink)
    }

    @ViewBuilder private func galleryItem(_ item: CSGalleryItem, list: Bool) -> some View {
        Group {
            if list {
                HStack(spacing: 11) {
                    CSGalleryTile(item: item, onRetry: { Task { await vm.retry(item) } })
                        .frame(width: 112)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.title).font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(2)
                        Text([item.provider, item.aspectRatio, item.assetState].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(AgentPalette(scheme).muted).lineLimit(2)
                        Text(item.publishable == true ? "Publish-ready" : item.modeLabel)
                            .font(.caption2.weight(.semibold)).foregroundStyle(item.publishable == true ? .green : AgentPalette.coralLt)
                    }
                    Spacer()
                }.padding(10).csGlass(scheme, corner: 15)
            } else {
                CSGalleryTile(item: item, onRetry: { Task { await vm.retry(item) } })
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { if item.previewUrl != nil { detail = item; CSHaptic.tap() } }
        .contextMenu {
            if !item.id.hasPrefix("sample-") {
                Button(role: .destructive) { deleteTarget = item } label: { Label("মুছে ফেলুন", systemImage: "trash") }
            }
        }
    }
}

/// Web GeneratingTile twin: a rising fill + Bangla percent that climbs 1→95%
/// (eased by elapsed time; 100% only lands with the real image).
@available(iOS 17.0, *)
struct CSGeneratingTile: View {
    let createdAt: String?
    var label = "তৈরি হচ্ছে…"
    @State private var pct: Double = 3

    private var startDate: Date {
        guard let createdAt else { return Date() }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return iso.date(from: createdAt)
            ?? { iso.formatOptions = [.withInternetDateTime]; return iso.date(from: createdAt) ?? Date() }()
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                LinearGradient(colors: [Color(red: 0.16, green: 0.15, blue: 0.22), Color(red: 0.24, green: 0.16, blue: 0.24)],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
                LinearGradient(colors: [AgentPalette.coral.opacity(0.45), AgentPalette.coral.opacity(0.06)],
                               startPoint: .bottom, endPoint: .top)
                    .frame(height: geo.size.height * pct / 100)
                    .animation(.easeOut(duration: 0.25), value: pct)
                VStack(spacing: 3) {
                    Text("\(almaBn(Int(pct.rounded())))%")
                        .font(.system(size: 26, weight: .heavy)).monospacedDigit().foregroundStyle(.white)
                    Text(label).font(.system(size: 10.5, weight: .medium)).foregroundStyle(.white.opacity(0.7))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            let start = startDate
            let EST = 38.0   // typical render ≈38s — approach 95% asymptotically
            while !Task.isCancelled {
                let elapsed = Date().timeIntervalSince(start)
                let target = 95 * (1 - exp(-elapsed / EST))
                if target > pct { pct += (target - pct) * 0.25 }
                try? await Task.sleep(nanoseconds: 150_000_000)
            }
        }
    }
}

// MARK: - VIDEO (Phase V1-V2 parity: real uploads → recipes → reels + music library)

/// PhotosPicker movie transferable — copies to tmp so a 500 MB shoot streams
/// from disk (never loaded into memory).
struct CSMovieFile: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent("cs-upload-\(UUID().uuidString).\(ext)")
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.copyItem(at: received.file, to: dest)
            return Self(url: dest)
        }
    }
}

@available(iOS 17.0, *)
private struct CSVideoTab: View {
    let vm: CreativeStudioVM
    @Environment(\.colorScheme) private var scheme

    @State private var pickedVideo: PhotosPickerItem?
    @State private var uploadPct: Int?
    @State private var selected: CSVideoUpload?
    @State private var recipe = CS.videoRecipes[0]
    @State private var targets: Set<Int> = [30]
    @State private var aspect = "9:16"
    @State private var captions = false
    @State private var audioMode = 0
    @State private var musicTrackId = "auto"
    @State private var voiceover = ""
    @State private var stings = false
    @State private var aiAssist = false
    @State private var running = false
    @State private var showMusicLib = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("রিল স্টুডিও · zero-LLM রেসিপি").font(.system(size: 10, weight: .bold)).tracking(1.1).foregroundStyle(AgentPalette.coralLt)
                    Text("ভিডিও").font(.system(size: 30, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
                }.padding(.top, 58).padding(.horizontal, 18)

                Text("Gallery ছবি/avatar থেকে Veo রিল, অথবা নিজের শুট করা ভিডিও → zero-LLM রেসিপি। দুটোই Gallery-তে আসে।")
                    .font(.system(size: 12)).foregroundStyle(AgentPalette(scheme).muted)
                    .padding(.horizontal, 18).padding(.top, 6)

                CSReelComposer(vm: vm).padding(.horizontal, 18).padding(.top, 16)

                VStack(alignment: .leading, spacing: 2) {
                    Text("🎞️ নিজের শুট → রেসিপি").font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                    Text("Deterministic ffmpeg · ৳0 API spend · source অক্ষত").font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                }.padding(.horizontal, 18).padding(.top, 22)
                uploadSection.padding(.horizontal, 18).padding(.top, 10)
                uploadsList
                if selected != nil { recipeSection }
                musicSection.padding(.horizontal, 18).padding(.top, 18)
                jobsSection
                Color.clear.frame(height: 110)
            }
        }
        .claudeTopFade(useNativeEdgeEffect: false)
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await vm.loadVideoStudio() }
        .task { await vm.loadVideoStudio() }
        .csEstimateAlert(vm: vm)
        // Poll running reel jobs every 4s (same rhythm as the gallery).
        .task(id: vm.hasActiveVideoJobs) {
            guard vm.hasActiveVideoJobs else { return }
            while !Task.isCancelled && vm.hasActiveVideoJobs {
                await vm.pollVideoJobs()
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
        .onChange(of: pickedVideo) { _, new in Task { await handlePick(new) } }
    }

    // ── Upload ────────────────────────────────────────────────────────────
    @ViewBuilder private var uploadSection: some View {
        if let pct = uploadPct {
            VStack(alignment: .leading, spacing: 8) {
                Text("আপলোড হচ্ছে… \(almaBn(pct))%").font(.system(size: 12.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                GeometryReader { geo in
                    Capsule().fill(Color.white.opacity(0.1))
                        .overlay(alignment: .leading) {
                            Capsule().fill(AgentPalette.coral).frame(width: geo.size.width * CGFloat(pct) / 100)
                        }
                }.frame(height: 8)
                Text("বড় ভিডিওতে কয়েক মিনিট লাগতে পারে — অ্যাপ খোলা রাখুন।")
                    .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
            }
            .padding(14).csGlass(scheme, corner: 18)
        } else {
            PhotosPicker(selection: $pickedVideo, matching: .videos) {
                Label("ভিডিও আপলোড করুন (১–২ মিনিটের শুট)", systemImage: "video.badge.plus")
                    .font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette.coral)
                    .frame(maxWidth: .infinity).padding(.vertical, 16)
                    .background(AgentPalette.coral.opacity(0.08), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(style: StrokeStyle(lineWidth: 1.4, dash: [6]))
                        .foregroundStyle(AgentPalette.coral.opacity(0.4)))
            }.buttonStyle(.plain)
        }
    }

    private func handlePick(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        uploadPct = 0
        defer { pickedVideo = nil }
        guard let movie = try? await item.loadTransferable(type: CSMovieFile.self) else {
            uploadPct = nil; vm.flash("ভিডিও পড়া গেল না"); return
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: movie.url.path)[.size] as? Int) ?? 0
        let name = movie.url.lastPathComponent
        let up = await vm.uploadVideo(fileURL: movie.url, name: name, sizeBytes: size) { pct in
            uploadPct = pct
        }
        uploadPct = nil
        try? FileManager.default.removeItem(at: movie.url)
        if let up { selected = up; targets = [recipe.defaultTarget] }
    }

    // ── Uploaded shoots ───────────────────────────────────────────────────
    @ViewBuilder private var uploadsList: some View {
        if !vm.videoUploads.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("আপলোড করা শুট").font(.system(size: 12, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                ForEach(vm.videoUploads) { up in
                    HStack(spacing: 10) {
                        Button { selected = up; targets = [recipe.defaultTarget]; CSHaptic.tap() } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "film").font(.system(size: 15))
                                    .foregroundStyle(selected?.id == up.id ? .white : AgentPalette.coralLt)
                                    .frame(width: 34, height: 34)
                                    .background(selected?.id == up.id ? AnyShapeStyle(CS.cta) : AnyShapeStyle(Color.white.opacity(0.07)),
                                                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(up.name).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(1)
                                    Text(fmtSize(up.sizeBytes ?? 0)).font(.system(size: 10)).foregroundStyle(AgentPalette(scheme).muted)
                                }
                                Spacer()
                            }
                        }.buttonStyle(.plain)
                        Button { Task { await vm.deleteVideo(up) }; CSHaptic.tap() } label: {
                            Image(systemName: "xmark")
                                .accessibilityLabel("ভিডিও মুছুন").font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(AgentPalette(scheme).muted).frame(width: 28, height: 28)
                        }.buttonStyle(.plain)
                    }
                    .padding(9)
                    .background(selected?.id == up.id ? AgentPalette.coral.opacity(0.1) : Color.white.opacity(scheme == .dark ? 0.03 : 0.25),
                                in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(selected?.id == up.id ? AgentPalette.coral.opacity(0.5) : .white.opacity(0.06), lineWidth: 1))
                }
            }.padding(.horizontal, 18).padding(.top, 14)
        }
    }
    private func fmtSize(_ b: Int) -> String {
        b > 1024 * 1024 ? "\(b / (1024 * 1024)) MB" : "\(b / 1024) KB"
    }

    // ── Recipe + options ──────────────────────────────────────────────────
    private var recipeSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("রেসিপি বাছুন — বাকিটা সিস্টেম করবে").font(.system(size: 12, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            ForEach(CS.videoRecipes) { r in
                Button {
                    recipe = r
                    targets = Set(targets.filter { r.targets.contains($0) })
                    if targets.isEmpty { targets = [r.defaultTarget] }
                    CSHaptic.tap()
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(r.labelBn).font(.system(size: 13.5, weight: .bold))
                            .foregroundStyle(recipe.id == r.id ? AgentPalette.coral : AgentPalette(scheme).ink)
                        Text(r.descriptionBn).font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    .background(recipe.id == r.id ? AgentPalette.coral.opacity(0.1) : Color.white.opacity(scheme == .dark ? 0.03 : 0.25),
                                in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(recipe.id == r.id ? AgentPalette.coral.opacity(0.55) : .white.opacity(0.06), lineWidth: 1))
                }.buttonStyle(.plain)
            }

            Text("রিলের দৈর্ঘ্য").font(.system(size: 12, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            HStack(spacing: 8) {
                ForEach(recipe.targets, id: \.self) { t in
                    CSChip(text: "\(almaBn(t))s", on: targets.contains(t)) {
                        if targets.contains(t) { if targets.count > 1 { targets.remove(t) } }
                        else { targets.insert(t) }
                    }
                }
            }
            Text("সাইজ").font(.system(size: 12, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            HStack(spacing: 8) {
                ForEach(CS.videoAspects, id: \.id) { a in
                    CSChip(text: a.label, on: aspect == a.id) { aspect = a.id }
                }
            }

            // V2: caption + audio layer (hard toggles, no prompts)
            VStack(alignment: .leading, spacing: 12) {
                Toggle("বাংলা ক্যাপশন", isOn: $captions).font(.system(size: 13, weight: .semibold)).tint(AgentPalette.coral)
                Text("সাউন্ড").font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                CSSegment(items: CS.audioModes.map(\.bn), index: $audioMode)
                if CS.audioModes[audioMode].id != "original" {
                    Text("মিউজিক ট্র্যাক (আপনার অনুমোদিত লাইব্রেরি)")
                        .font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                    if vm.musicTracks.isEmpty {
                        Text("লাইব্রেরি খালি — নিচের \"মিউজিক লাইব্রেরি\" থেকে ট্র্যাক আপলোড করুন।")
                            .font(.system(size: 11.5)).foregroundStyle(Color(red: 0.95, green: 0.75, blue: 0.3))
                    } else {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                CSChip(text: "অটো", on: musicTrackId == "auto") { musicTrackId = "auto" }
                                ForEach(vm.musicTracks) { t in
                                    CSChip(text: t.name, on: musicTrackId == t.id) { musicTrackId = t.id }
                                }
                            }
                        }
                    }
                }
                Text("ভয়েসওভার (ঐচ্ছিক — আপনার লেখা লাইন, এজেন্টের বাংলা ভয়েসে)")
                    .font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                TextField("যেমন: বাবা-ছেলের ম্যাচিং পাঞ্জাবি — অর্ডার করতে ইনবক্স করুন",
                          text: Binding(get: { voiceover }, set: { voiceover = String($0.prefix(CS.voiceoverMaxChars)) }),
                          axis: .vertical)
                    .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).ink)
                    .padding(11).background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                Toggle("ALMA লোগো intro/outro", isOn: $stings).font(.system(size: 13, weight: .semibold)).tint(AgentPalette.coral)
                Toggle("AI হাইলাইট সাজেশন (বিটা)", isOn: $aiAssist).font(.system(size: 13, weight: .semibold)).tint(AgentPalette.coral)
            }
            .padding(13).csGlass(scheme, corner: 16)

            Button { CSHaptic.tap(); Task { await run() } } label: {
                HStack(spacing: 8) {
                    if running { ProgressView().tint(.white) }
                    Text(running ? "শুরু হচ্ছে…" : "রিল বানাও (\(targets.sorted().map { "\(almaBn($0))s" }.joined(separator: " + ")))")
                        .font(.system(size: 15, weight: .bold))
                }
                .foregroundStyle(.white).frame(maxWidth: .infinity).padding(15)
                .background(CS.cta, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .shadow(color: CS.ctaGlow, radius: 14, y: 8)
            }.buttonStyle(.plain).disabled(running || targets.isEmpty)
        }
        .padding(.horizontal, 18).padding(.top, 18)
    }

    private func run() async {
        guard let selected else { return }
        running = true
        defer { running = false }
        _ = await vm.runVideoRecipe(video: selected, recipeId: recipe.id,
                                    targets: targets.sorted(), aspect: aspect,
                                    captions: captions, audioMode: CS.audioModes[audioMode].id,
                                    musicTrackId: musicTrackId, voiceoverText: voiceover,
                                    stings: stings, aiAssist: aiAssist)
    }

    // ── Music library (owner-approved beds only — Islamic guardrail) ──────
    private var musicSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { withAnimation { showMusicLib.toggle() }; CSHaptic.tap() } label: {
                HStack {
                    Text("🎵 মিউজিক লাইব্রেরি (\(almaBn(vm.musicTracks.count)))")
                        .font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                    Spacer()
                    Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(AgentPalette(scheme).muted)
                        .rotationEffect(.degrees(showMusicLib ? 180 : 0))
                }
            }.buttonStyle(.plain)
            if showMusicLib { CSMusicLibrary(vm: vm) }
        }
        .padding(14).csGlass(scheme, corner: 18)
    }

    /// Extracted from the jobs row — the inline nested ternary+flatMap chain made
    /// the Release type-checker time out ("unable to type-check in reasonable time").
    private static func jobSubtitle(_ j: (id: String, label: String, status: CSVideoJobStatus?), done: Bool, failed: Bool) -> String {
        if failed { return j.status?.error ?? "ব্যর্থ হয়েছে" }
        if done { return "রেডি — Gallery-তে দেখুন" }
        if let p = j.status?.videoProgress, let st = p.step, let total = p.total {
            return "ধাপ \(almaBn(st))/\(almaBn(total)): \(p.labelBn ?? "")"
        }
        return "অপেক্ষায়…"
    }

    // ── Running / finished jobs ────────────────────────────────────────────
    @ViewBuilder private var jobsSection: some View {
        if !vm.videoJobs.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("চলমান কাজ").font(.system(size: 12, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                ForEach(Array(vm.videoJobs.enumerated()), id: \.offset) { _, j in
                    let done = j.status?.status == "executed"
                    let failed = j.status?.status == "failed"
                    HStack(spacing: 10) {
                        if done { Text("✅") } else if failed { Text("❌") }
                        else { ProgressView().tint(AgentPalette.coral).controlSize(.small) }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(j.label).font(.system(size: 12, weight: .semibold)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(1)
                            Text(Self.jobSubtitle(j, done: done, failed: failed))
                                .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted).lineLimit(1)
                        }
                        Spacer()
                    }
                    .padding(11).csGlass(scheme, corner: 14)
                }
            }.padding(.horizontal, 18).padding(.top, 16)
        }
    }
}

/// Owner-approved music beds: upload (signed direct), tag by vibe, delete.
@available(iOS 17.0, *)
private struct CSMusicLibrary: View {
    let vm: CreativeStudioVM
    @Environment(\.colorScheme) private var scheme
    @State private var vibe = CS.musicVibes[0].id
    @State private var pct: Int?
    @State private var importing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("শুধু আপনার অনুমোদিত ট্র্যাকই রিলে বসে — সিস্টেম নিজে কোথাও থেকে মিউজিক আনে না।")
                .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
            HStack(spacing: 8) {
                ForEach(CS.musicVibes, id: \.id) { v in
                    CSChip(text: v.bn, on: vibe == v.id) { vibe = v.id }
                }
            }
            if let pct {
                GeometryReader { geo in
                    Capsule().fill(Color.white.opacity(0.1))
                        .overlay(alignment: .leading) {
                            Capsule().fill(AgentPalette.coral).frame(width: geo.size.width * CGFloat(pct) / 100)
                        }
                }.frame(height: 8)
            } else {
                Button { importing = true; CSHaptic.tap() } label: {
                    Text("+ ট্র্যাক আপলোড (\(CS.musicVibes.first { $0.id == vibe }?.bn ?? "") হিসেবে)")
                        .font(.system(size: 12, weight: .bold)).foregroundStyle(AgentPalette.coral)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(AgentPalette.coral.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(style: StrokeStyle(lineWidth: 1.2, dash: [5]))
                            .foregroundStyle(AgentPalette.coral.opacity(0.4)))
                }.buttonStyle(.plain)
            }
            ForEach(vm.musicTracks) { t in
                HStack(spacing: 8) {
                    Text(t.name).font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).ink).lineLimit(1)
                    Spacer()
                    Text(CS.musicVibes.first { $0.id == t.vibe }?.bn ?? (t.vibe ?? ""))
                        .font(.system(size: 9.5)).foregroundStyle(AgentPalette(scheme).muted)
                        .padding(.vertical, 3).padding(.horizontal, 7)
                        .background(Color.white.opacity(0.08), in: Capsule())
                    Button { Task { await vm.deleteMusic(t) }; CSHaptic.tap() } label: {
                        Image(systemName: "xmark")
                            .accessibilityLabel("অডিও মুছুন").font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(AgentPalette(scheme).muted)
                    }.buttonStyle(.plain)
                }
                .padding(.vertical, 8).padding(.horizontal, 10)
                .background(Color.white.opacity(scheme == .dark ? 0.03 : 0.25), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.audio]) { result in
            guard case .success(let url) = result else { return }
            Task {
                let secured = url.startAccessingSecurityScopedResource()
                defer { if secured { url.stopAccessingSecurityScopedResource() } }
                // copy to tmp so the upload task owns a stable file
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent("cs-music-\(UUID().uuidString).\(url.pathExtension.isEmpty ? "mp3" : url.pathExtension)")
                try? FileManager.default.removeItem(at: tmp)
                do { try FileManager.default.copyItem(at: url, to: tmp) } catch { vm.flash("ফাইল পড়া গেল না"); return }
                let size = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? Int) ?? 0
                pct = 0
                await vm.uploadMusic(fileURL: tmp, name: url.lastPathComponent, sizeBytes: size, vibe: vibe) { pct = $0 }
                pct = nil
                try? FileManager.default.removeItem(at: tmp)
            }
        }
    }
}

// MARK: - AUDIO LAB (E1 parity — ElevenLabs presets, owner-typed lines only)

@available(iOS 17.0, *)
private struct CSAudioTab: View {
    let vm: CreativeStudioVM
    @Environment(\.colorScheme) private var scheme

    @State private var musicStyle = "celebration"
    @State private var musicLine = ""
    @State private var musicSec = 30
    @State private var occasion = "birthday"
    @State private var wishName = ""
    @State private var voiceText = ""
    @State private var sfxText = ""
    @State private var pct: Int?
    @State private var busy = false
    @State private var importKind: AudioImportKind?
    @State private var dubLanguage = "bn"
    @State private var dubSeconds = 60
    @State private var changeSeconds = 30

    enum AudioImportKind: String, Identifiable { case clone, cleanNote, dub, voiceChange; var id: String { rawValue } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("মিউজিক · ভয়েস · SFX").font(.system(size: 10, weight: .bold)).tracking(1.1).foregroundStyle(AgentPalette.coralLt)
                    Text("অডিও ল্যাব").font(.system(size: 30, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
                }.padding(.top, 58)
                Text("মিউজিক, উইশ গান, আপনার ভয়েস — সব এক জায়গায়। খরচ আগে দেখানো হয়; ফলাফল Gallery-তে আসে।")
                    .font(.system(size: 12)).foregroundStyle(AgentPalette(scheme).muted)

                voiceCloneCard
                musicCard
                wishCard
                ownerVoiceCard
                dubbingCard
                voiceChangerCard
                cleanNoteCard
                sfxCard
                Color.clear.frame(height: 100)
            }.padding(.horizontal, 18)
        }
        .claudeTopFade(useNativeEdgeEffect: false)
        .scrollDismissesKeyboard(.interactively)
        .task { await vm.loadAudioLab() }
        .refreshable { await vm.loadAudioLab() }
        .alert(item: Binding(get: { vm.pendingAudioEstimate }, set: { vm.pendingAudioEstimate = $0 })) { estimate in
            Alert(
                title: Text("খরচ নিশ্চিত করুন"),
                message: Text("\(estimate.summary ?? "Audio job")\nProvider: \(estimate.provider ?? "production provider")\nEstimate: ৳\(almaBn(estimate.costBdt))\nসর্বোচ্চ cap: ৳\(almaBn(estimate.maxCostBdt))"),
                primaryButton: .cancel(Text("বাতিল")) { vm.cancelPendingAudio() },
                secondaryButton: .default(Text("Confirm & Queue")) { Task { await vm.confirmPendingAudio(estimate) } }
            )
        }
        .fileImporter(isPresented: Binding(get: { importKind != nil }, set: { if !$0 { importKind = nil } }),
                      allowedContentTypes: [.audio], allowsMultipleSelection: importKind == .clone) { result in
            guard case .success(let urls) = result, let kind = importKind else { return }
            Task { await handleImport(urls: Array(urls.prefix(3)), kind: kind) }
        }
    }

    private var cloned: Bool { vm.audioStatus?.voiceCloned == true }

    private func handleImport(urls: [URL], kind: AudioImportKind) async {
        var paths: [String] = []
        pct = 0
        for url in urls {
            let secured = url.startAccessingSecurityScopedResource()
            defer { if secured { url.stopAccessingSecurityScopedResource() } }
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent("cs-audio-\(UUID().uuidString).\(url.pathExtension.isEmpty ? "m4a" : url.pathExtension)")
            try? FileManager.default.removeItem(at: tmp)
            do { try FileManager.default.copyItem(at: url, to: tmp) } catch { continue }
            let size = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? Int) ?? 0
            if let path = await vm.uploadAudioFile(fileURL: tmp, name: url.lastPathComponent, sizeBytes: size, onProgress: { pct = $0 }) {
                paths.append(path)
            }
            try? FileManager.default.removeItem(at: tmp)
        }
        pct = nil
        guard !paths.isEmpty else { return }
        switch kind {
        case .clone:
            await vm.estimateVoiceClone(samplePaths: paths)
            await vm.loadAudioLab()
        case .cleanNote:
            await vm.queueAudio("ভয়েস ক্লিনআপ", body: ["kind": AnyEncodable("clean_voice"), "sourcePath": AnyEncodable(paths[0])])
        case .dub:
            await vm.queueAudio("Dubbing → \(dubLanguage.uppercased())", body: [
                "kind": AnyEncodable("dub"), "sourcePath": AnyEncodable(paths[0]),
                "targetLanguage": AnyEncodable(dubLanguage), "seconds": AnyEncodable(dubSeconds),
            ])
        case .voiceChange:
            // Same owner-only usage context as the owner-voice card; the route rejects
            // voice_change without it (owner_voice_context_forbidden).
            var body: [String: AnyEncodable] = [
                "kind": AnyEncodable("voice_change"), "sourcePath": AnyEncodable(paths[0]),
                "seconds": AnyEncodable(changeSeconds),
                "usageContext": AnyEncodable("owner_studio"),
            ]
            if let active = vm.audioStatus?.activeVoiceVersionId { body["voiceVersionId"] = AnyEncodable(active) }
            await vm.queueAudio("Voice changer", body: body)
        }
    }

    /// Web "🌐 Dubbing" — ElevenLabs Dubbing · source voice clone off · $1 ceiling estimate first.
    private var dubbingCard: some View {
        card("🌐 Dubbing", "Provider: ElevenLabs Dubbing · source voice clone বন্ধ থাকে · Queue-র আগে $1 ceiling-এর ভেতরে estimate দেখাবে।") {
            HStack(spacing: 8) {
                ForEach([("bn", "বাংলা"), ("en", "English"), ("hi", "हिन्दी"), ("ar", "العربية")], id: \.0) { id, bn in
                    CSChip(text: bn, on: dubLanguage == id) { dubLanguage = id }
                }
            }
            HStack(spacing: 8) {
                ForEach([30, 60, 120], id: \.self) { s2 in
                    CSChip(text: "\(almaBn(s2))s", on: dubSeconds == s2) { dubSeconds = s2 }
                }
                Spacer()
                actionBtn(pct.map { "আপলোড \(almaBn($0))%" } ?? "Audio দিন ও estimate দেখুন", disabled: busy || pct != nil) { importKind = .dub }
            }
        }
    }

    /// Web "🎭 Voice changer → Active owner voice" — emotion/timing kept, voice = active owner-only version.
    private var voiceChangerCard: some View {
        let active = vm.audioStatus?.activeVoiceVersionId != nil
        return card("🎭 Voice changer → আমার active ভয়েস",
                    active ? "Provider: ElevenLabs Voice Changer · emotion/timing থাকবে, voice হবে active owner-only version (v\(almaBn(vm.audioStatus?.activeVoiceVersion ?? 0)))।"
                           : "আগে একটি voice version activate করুন (লাইব্রেরি → V4 Workspace → Voice)।") {
            HStack(spacing: 8) {
                ForEach([15, 30, 60], id: \.self) { s2 in
                    CSChip(text: "\(almaBn(s2))s", on: changeSeconds == s2) { changeSeconds = s2 }
                }
                Spacer()
                actionBtn(pct.map { "আপলোড \(almaBn($0))%" } ?? "Audio দিন", disabled: busy || pct != nil || !active) { importKind = .voiceChange }
            }
        }
    }

    private func queue(_ label: String, _ body: [String: AnyEncodable]) {
        CSHaptic.tap()
        Task { busy = true; await vm.queueAudio(label, body: body); busy = false }
    }

    // ── cards ─────────────────────────────────────────────────────────────
    private var voiceCloneCard: some View {
        card("🧬 আপনার ভয়েস" + (cloned ? " — ক্লোন করা আছে ✓" : " — এখনো ক্লোন হয়নি"),
             "১-৩টা পরিষ্কার ভয়েস রেকর্ডিং দিন (একবারই লাগবে)। এই ভয়েস শুধু আপনার নিজের কাজে ব্যবহার হবে।") {
            actionBtn(pct.map { "আপলোড \(almaBn($0))%" } ?? (cloned ? "আবার ক্লোন করাও" : "স্যাম্পল দিয়ে ক্লোন করাও"),
                      disabled: busy || pct != nil) { importKind = .clone }
        }
    }

    private var musicCard: some View {
        card("🎵 মিউজিক বানাও", nil) {
            HStack(spacing: 8) {
                ForEach(vm.audioStatus?.styles ?? [CSAudioPreset(id: "celebration", labelBn: "উৎসব")]) { st in
                    CSChip(text: st.labelBn ?? st.id, on: musicStyle == st.id) { musicStyle = st.id }
                }
            }
            field("মুড/থিম এক লাইনে (ঐচ্ছিক)", text: $musicLine)
            HStack(spacing: 8) {
                ForEach([30, 60], id: \.self) { s2 in
                    CSChip(text: "\(almaBn(s2))s", on: musicSec == s2) { musicSec = s2 }
                }
                Spacer()
                actionBtn("বানাও", disabled: busy) {
                    queue("মিউজিক", ["kind": AnyEncodable("music"), "styleId": AnyEncodable(musicStyle),
                                     "line": AnyEncodable(musicLine), "seconds": AnyEncodable(musicSec)])
                }
            }
        }
    }

    private var wishCard: some View {
        card("🎁 উইশ গান", "ফিক্সড লিরিক — শুধু নাম বসে") {
            HStack(spacing: 8) {
                ForEach(vm.audioStatus?.occasions ?? [CSAudioPreset(id: "birthday", labelBn: "জন্মদিন")]) { o in
                    CSChip(text: o.labelBn ?? o.id, on: occasion == o.id) { occasion = o.id }
                }
            }
            HStack(spacing: 8) {
                field("নাম", text: $wishName)
                actionBtn("বানাও", disabled: busy || wishName.trimmingCharacters(in: .whitespaces).isEmpty) {
                    queue("উইশ গান", ["kind": AnyEncodable("wish_song"), "occasionId": AnyEncodable(occasion),
                                      "name": AnyEncodable(wishName), "seconds": AnyEncodable(30)])
                }
            }
        }
    }

    private var ownerVoiceCard: some View {
        card("🎙️ আমার ভয়েসে বলাও", nil) {
            TextField("যা বলাতে চান লিখুন…", text: Binding(get: { voiceText }, set: { voiceText = String($0.prefix(600)) }), axis: .vertical)
                .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).ink)
                .padding(11).background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            actionBtn(cloned ? "বলাও" : "আগে ভয়েস ক্লোন করুন",
                      disabled: busy || !cloned || voiceText.trimmingCharacters(in: .whitespaces).isEmpty) {
                queue("ভয়েস লাইন", [
                    "kind": AnyEncodable("owner_voice"),
                    "text": AnyEncodable(voiceText),
                    "usageContext": AnyEncodable("owner_studio"),
                ])
            }
        }
    }

    private var cleanNoteCard: some View {
        card("🎧 ভয়েস নোট → স্টুডিও কোয়ালিটি", nil) {
            actionBtn(pct.map { "আপলোড \(almaBn($0))%" } ?? "ভয়েস নোট দিন", disabled: busy || pct != nil) { importKind = .cleanNote }
        }
    }

    private var sfxCard: some View {
        card("🔊 সাউন্ড ইফেক্ট (রিলের জন্য)", nil) {
            HStack(spacing: 8) {
                field("যেমন: whoosh, চুড়ির টুংটাং", text: $sfxText)
                actionBtn("বানাও", disabled: busy || sfxText.trimmingCharacters(in: .whitespaces).isEmpty) {
                    queue("SFX", ["kind": AnyEncodable("sfx"), "text": AnyEncodable(sfxText), "seconds": AnyEncodable(3)])
                }
            }
        }
    }

    // ── helpers ───────────────────────────────────────────────────────────
    @ViewBuilder
    private func card(_ title: String, _ sub: String?, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
            if let sub { Text(sub).font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted) }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14).csGlass(scheme, corner: 18)
    }
    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).ink)
            .padding(11).background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    private func actionBtn(_ label: String, disabled: Bool, _ tap: @escaping () -> Void) -> some View {
        Button { tap() } label: {
            Text(label).font(.system(size: 12.5, weight: .bold)).foregroundStyle(.white)
                .padding(.vertical, 10).padding(.horizontal, 16)
                .background(CS.cta, in: Capsule())
                .opacity(disabled ? 0.45 : 1)
        }.buttonStyle(.plain).disabled(disabled)
    }
}

// MARK: - LIBRARY (models + creator + finishing + settings + logo — full parity)

@available(iOS 17.0, *)
private struct CSLibraryTab: View {
    let vm: CreativeStudioVM
    let openWeb: (_ path: String, _ title: String) -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var confirmDelete: CSModel?
    @State private var addSheet = false
    @State private var finishSlot = CSSlot()
    @State private var finishedUrl: String?
    @State private var logoPicked: PhotosPickerItem?
    @State private var logoSaving = false
    @State private var v4Workspace = false
    @State private var assetLibrary = false
    // NP-4 (AG-12.drive): native Drive connect state
    @State private var driveConnected = false
    @State private var driveEmail: String? = nil
    @State private var driveBusy = false

    private var realModels: [CSModel] { vm.models.filter { !$0.id.hasPrefix("sm-") } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("মডেল + ফিনিশিং + সেটিংস").font(.system(size: 10, weight: .bold)).tracking(1.1).foregroundStyle(AgentPalette.coralLt)
                    Text("লাইব্রেরি").font(.system(size: 30, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
                }.padding(.top, 58).padding(.horizontal, 18)

                v4WorkspaceCard.padding(.horizontal, 18).padding(.top, 14)

                CSSectionHeader(title: "সেভ করা মডেল", trailing: "\(almaBn(realModels.count))টি", action: nil).padding(.horizontal, 18)
                modelGrid
                modelCreatorCard.padding(.horizontal, 18).padding(.top, 14)

                CSSectionHeader(title: "ছবি আপলোড করে ফিনিশিং", trailing: "logo · code · hook", action: nil).padding(.horizontal, 18)
                finishSection.padding(.horizontal, 18)

                CSSectionHeader(title: "ব্র্যান্ড লোগো", trailing: nil, action: nil).padding(.horizontal, 18)
                logoSection.padding(.horizontal, 18)

                CSSectionHeader(title: "স্টুডিও সেটিংস", trailing: nil, action: nil).padding(.horizontal, 18)
                settingsSection.padding(.horizontal, 18)

                CSSectionHeader(title: "আরও", trailing: nil, action: nil).padding(.horizontal, 18)
                VStack(spacing: 10) {
                    // Web Projects desk → "Open asset library" (folders · tags · version lineage · Legacy import).
                    if let project = vm.activeProject {
                        Button { assetLibrary = true; CSHaptic.tap() } label: {
                            HStack(spacing: 13) {
                                Image(systemName: "archivebox.fill").font(.system(size: 17))
                                    .foregroundStyle(AgentPalette.coralLt).frame(width: 30)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Project asset library").font(.system(size: 14.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                                    Text("\(project.name) · folder · tag · version lineage · Legacy import")
                                        .font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).muted).lineLimit(1)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
                            }.padding(14).csGlass(scheme, corner: AlmaSwiftTheme.rCard)
                        }.buttonStyle(.plain)
                    }
                    // ড্র্যাগ-এডিটর এখন পুরো নেটিভ — Gallery-তে যেকোনো ছবির "এডিটর" বাটনে।
                    // NP-4 (AG-12.drive): Drive connect runs in ASWebAuthenticationSession
                    // (system handoff) — the whole web Studio no longer opens for it.
                    driveRow
                }.padding(.horizontal, 18)
                .task { await loadDriveStatus() }
                Color.clear.frame(height: 110)
            }
        }
        .claudeTopFade(useNativeEdgeEffect: false)
        .refreshable { await vm.loadAll(); await vm.loadLibraryExtras() }
        .task { await vm.loadLibraryExtras() }
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $addSheet) { CSAddModelSheet(vm: vm) }
        .sheet(isPresented: $assetLibrary) {
            if let project = vm.activeProject { CSProjectAssetLibrarySheet(project: project) }
        }
        .sheet(isPresented: $v4Workspace) {
            CSV4WorkspaceScreen(seedProject: vm.activeProject) { project in
                Task { await vm.activateProject(project) }
            }
                .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
        .onChange(of: logoPicked) { _, new in Task { await saveLogo(new) } }
        .alert("মডেল মুছবেন?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })) {
            Button("বাতিল", role: .cancel) {}
            Button("মুছুন", role: .destructive) { if let m = confirmDelete { Task { await vm.removeModel(m.id) } } }
        } message: { Text(confirmDelete?.name ?? "") }
    }

    private var v4WorkspaceCard: some View {
        Button { v4Workspace = true; CSHaptic.tap() } label: {
            HStack(spacing: 13) {
                Image(systemName: "square.grid.3x3.square").font(.system(size: 17))
                    .foregroundStyle(AgentPalette.coralLt).frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("V4 Production Workspace").font(.system(size: 14.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                    Text("Projects · Review · Campaign · Voice · Operations")
                        .font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).muted)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.system(size: 13, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
            }.padding(14).csGlass(scheme, corner: AlmaSwiftTheme.rCard)
        }.buttonStyle(.plain)
    }

    // ── Saved models ──────────────────────────────────────────────────────
    private var modelGrid: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
            ForEach(vm.models) { m in
                CSPhoto(url: m.imageURL, ratio: 0.75)
                    .overlay(alignment: .bottomLeading) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(m.name ?? "মডেল").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            Text(CS.roleBn(m.role).isEmpty ? (m.role ?? "brand model") : CS.roleBn(m.role))
                                .font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.66))
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
        Button { addSheet = true; CSHaptic.tap() } label: {
            VStack(spacing: 9) {
                ZStack { RoundedRectangle(cornerRadius: 14).fill(CS.cta).frame(width: 44, height: 44)
                    Image(systemName: "plus").font(.system(size: 22, weight: .bold)).foregroundStyle(.white) }
                Text("নতুন মডেল").font(.system(size: 13, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
                Text("ফুল-বডি ছবি যোগ করুন").font(.system(size: 9.5)).foregroundStyle(AgentPalette(scheme).muted)
            }
            .frame(maxWidth: .infinity).aspectRatio(0.75, contentMode: .fit)
            .csGlass(scheme, corner: 20)
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: 1.4, dash: [6])).foregroundStyle(.white.opacity(0.2)))
        }.buttonStyle(.plain)
    }

    /// CS4 — generate the brand's FICTIONAL models once (no real children's photos).
    private var modelCreatorCard: some View {
        let roles: [(id: String, bn: String)] = [("father", "বাবা"), ("mother", "মা"), ("son", "ছেলে"), ("daughter", "মেয়ে")]
        let have = Set(realModels.compactMap(\.role))
        return VStack(alignment: .leading, spacing: 8) {
            Text("🧑‍🎨 AI দিয়ে ব্র্যান্ড মডেল বানাও").font(.system(size: 13, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
            Text("একবার বানালে একই মুখ প্রতিবার ফিরে আসবে — বাচ্চার আসল ছবি লাগবে না। তৈরি হলে Gallery-তে গিয়ে \"মডেল হিসেবে সেভ\" চাপুন।")
                .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
            HStack(spacing: 8) {
                ForEach(roles, id: \.id) { r in
                    Button { Task { await vm.generateBrandModel(role: r.id, bn: r.bn) }; CSHaptic.tap() } label: {
                        Text("\(r.bn)\(have.contains(r.id) ? " ✓" : "")")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(have.contains(r.id) ? AgentPalette(scheme).muted : .white)
                            .padding(.vertical, 9).padding(.horizontal, 14)
                            .background(have.contains(r.id) ? AnyShapeStyle(Color.white.opacity(0.08)) : AnyShapeStyle(AgentPalette.coral), in: Capsule())
                    }.buttonStyle(.plain)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14).csGlass(scheme, corner: 18)
    }

    // ── Upload-and-finish ────────────────────────────────────────────────
    @ViewBuilder private var finishSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("নিজের একটা ছবি আপলোড করুন, তারপর সেই ছবির কোড আর hook লিখে ফিনিশিং করুন — আসল ছবি অক্ষত থাকে।")
                .font(.system(size: 11)).foregroundStyle(AgentPalette(scheme).muted)
            CSUploadTile(slot: finishSlot, vm: vm, label: "ছবি আপলোড করুন", folder: "finishing", height: 180)
            if let path = finishSlot.path, finishedUrl == nil {
                CSFinishPanel(item: uploadedItem(path), vm: vm) { framed in finishedUrl = framed }
            }
            if let finishedUrl, let url = CS.url(finishedUrl) {
                CSPhoto(url: url, ratio: 1)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                HStack(spacing: 10) {
                    Button {
                        CSHaptic.tap()
                        Task {
                            guard let data = try? await CSMediaSaver.fetch(url) else { vm.flash("ডাউনলোড হয়নি"); return }
                            let ok = await CSMediaSaver.saveToPhotos(
                                data, ext: CSMediaSaver.ext(url, isVideo: false), isVideo: false)
                            vm.flash(ok ? "ছবি ফটো অ্যাপে সেভ হয়েছে ✅" : "Photos-এ সেভের অনুমতি দেওয়া নেই")
                        }
                    } label: {
                        Text("ডাউনলোড").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(12)
                            .background(AgentPalette.coral, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }.buttonStyle(.plain)
                    Button { self.finishedUrl = nil } label: {
                        Text("আবার ফিনিশিং").font(.system(size: 13, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
                            .padding(12).csGlass(scheme, corner: 14)
                    }.buttonStyle(.plain)
                }
            }
        }
    }
    /// A synthetic gallery item so CSFinishPanel can finish a fresh upload.
    private func uploadedItem(_ path: String) -> CSGalleryItem {
        let json = "{\"id\":\"sample-upload\",\"storagePath\":\"\(path.replacingOccurrences(of: "\"", with: ""))\"}"
        return (try? JSONDecoder().decode(CSGalleryItem.self, from: Data(json.utf8)))
            ?? CS.sampleGallery[0]
    }

    // ── Brand logo ────────────────────────────────────────────────────────
    private var logoSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("যেকোনো সাইজ চলবে — সিস্টেম নিজে রিসাইজ করে নেবে। সবচেয়ে ভালো: PNG (transparent)। লোগো, রং, ফন্ট ফিনিশিং-এ এখান থেকেই বসে।")
                .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
            if vm.brandStatus?.hasLogo != true {
                Text("⚠️ এখনো কোনো লোগো আপলোড করা হয়নি — লোগো ছাড়া ফিনিশিং-এ শুধু লেখা বসবে।")
                    .font(.system(size: 11)).foregroundStyle(Color(red: 0.95, green: 0.75, blue: 0.3))
            }
            PhotosPicker(selection: $logoPicked, matching: .images) {
                Group {
                    if let logo = vm.brandStatus?.logoUrl, let url = CS.url(logo) {
                        CSPhoto(url: url, ratio: 2.2)
                    } else {
                        Text(logoSaving ? "লোগো সেভ হচ্ছে…" : "লোগো আপলোড করুন")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
                            .frame(maxWidth: .infinity).frame(height: 90)
                    }
                }
                .frame(maxWidth: .infinity)
                .background(AgentPalette(scheme).glassFill)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: 1.4, dash: [6])).foregroundStyle(.white.opacity(0.2)))
            }.buttonStyle(.plain)
            if vm.brandStatus?.hasLogo == true {
                Text("✅ লোগো সেভ আছে — বদলাতে চাইলে নতুন একটা সিলেক্ট করুন।")
                    .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
            }
        }
        .padding(14).csGlass(scheme, corner: 18)
    }
    private func saveLogo(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self) else { return }
        logoSaving = true
        await vm.uploadLogo(data, filename: "logo.png", mime: "image/png")
        logoSaving = false
        logoPicked = nil
    }

    // ── Studio settings (CS4) ────────────────────────────────────────────
    private var settingsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("ছবির QC (মান যাচাই)").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(AgentPalette(scheme).ink)
                Spacer()
                HStack(spacing: 6) {
                    ForEach([("off", "বন্ধ"), ("normal", "নরমাল"), ("strict", "কড়া")], id: \.0) { id, bn in
                        CSChip(text: bn, on: (vm.settings?.qcLevel ?? "normal") == id) {
                            Task { await vm.saveSettings(qcLevel: id) }
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("ইমেজ ইঞ্জিন").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(AgentPalette(scheme).ink)
                // 3 engines don't fit one row on smaller widths — wrap in a grid.
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 6)], alignment: .leading, spacing: 6) {
                    CSChip(text: "Nano Banana (ফটোরিয়াল)", on: (vm.settings?.imageEngine ?? "gemini") == "gemini") {
                        Task { await vm.saveSettings(imageEngine: "gemini") }
                    }
                    CSChip(text: "GPT Image 2 (প্রোডাক্ট/পোস্টার)", on: vm.settings?.imageEngine == "gpt") {
                        Task { await vm.saveSettings(imageEngine: "gpt") }
                    }
                    CSChip(text: "Seedream 5.0 Pro (2K · নতুন)", on: vm.settings?.imageEngine == "seedream") {
                        Task { await vm.saveSettings(imageEngine: "seedream") }
                    }
                }
                Text("পরের রেন্ডার থেকে কার্যকর · try-on (FASHN) এতে বদলায় না")
                    .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
            }
            Toggle("কাজ শেষ হলে Telegram-এ জানাও", isOn: Binding(
                get: { vm.settings?.notifyOnDone ?? false },
                set: { v in Task { await vm.saveSettings(notifyOnDone: v) } }))
                .font(.system(size: 12.5, weight: .semibold)).tint(AgentPalette.coral)
            if let garments = vm.settings?.childGarments, !garments.isEmpty {
                Text("বাচ্চার গার্মেন্ট ক্যাশ (খারাপ হলে মুছুন — পরের রানে নতুন হবে)")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(garments) { g in
                            ZStack(alignment: .topTrailing) {
                                CSPhoto(url: CS.url(g.url), ratio: 0.78).frame(width: 46, height: 60)
                                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                                Button { Task { await vm.deleteGarmentCache(g.key) }; CSHaptic.tap() } label: {
                                    Image(systemName: "xmark")
                                        .accessibilityLabel("আইটেম মুছুন").font(.system(size: 8, weight: .bold)).foregroundStyle(.white)
                                        .frame(width: 16, height: 16).background(Color.red, in: Circle())
                                }.buttonStyle(.plain).offset(x: 5, y: -5)
                            }
                        }
                    }.padding(.top, 4)
                }
            }
        }
        .padding(14).csGlass(scheme, corner: 18)
    }

    // ── NP-4 (AG-12.drive): native Google Drive connect/disconnect ──

    @ViewBuilder private var driveRow: some View {
        let pal = AgentPalette(scheme)
        VStack(spacing: 8) {
            HStack(spacing: 13) {
                Image(systemName: "arrow.up.doc").font(.system(size: 17))
                    .foregroundStyle(AgentPalette.coralLt).frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text("☁️ Google Drive").font(.system(size: 14.5, weight: .bold)).foregroundStyle(pal.ink)
                    Text(driveConnected
                         ? "যুক্ত ✓\(driveEmail.map { " · \($0)" } ?? "") — ছবি/ভিডিও অটো-ব্যাকআপ চালু"
                         : "ছবি/ভিডিও অটো-ব্যাকআপ — connect করুন")
                        .font(.system(size: 11.5))
                        .foregroundStyle(driveConnected ? AgentPalette.teal : pal.muted)
                        .lineLimit(1)
                }
                Spacer()
                if driveBusy {
                    ProgressView().controlSize(.small)
                } else if driveConnected {
                    Button {
                        CSHaptic.tap()
                        Task { await driveDisconnect() }
                    } label: {
                        Text("বিচ্ছিন্ন").font(.system(size: 11, weight: .bold))
                            .foregroundStyle(Color(red: 0.937, green: 0.267, blue: 0.267))
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(Color(red: 0.937, green: 0.267, blue: 0.267).opacity(0.10), in: Capsule())
                    }.buttonStyle(.plain)
                } else {
                    Button {
                        CSHaptic.tap()
                        driveConnect()
                    } label: {
                        Text("Connect").font(.system(size: 11, weight: .bold))
                            .foregroundStyle(AgentPalette.coralLt)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .background(AgentPalette.coral.opacity(0.12), in: Capsule())
                    }.buttonStyle(.plain)
                }
            }.padding(14).csGlass(scheme, corner: AlmaSwiftTheme.rCard)
        }
    }

    private func loadDriveStatus() async {
        struct Resp: Decodable { let connected: Bool?; let email: String? }
        if let r: Resp = try? await AlmaAPI.shared.get("/api/assistant/creative-studio/drive-status") {
            driveConnected = r.connected == true
            driveEmail = r.email
        }
    }

    private func driveConnect() {
        guard #available(iOS 17.4, *) else { openWeb(CS_WEB_PATH, "Creative Studio"); return }
        driveBusy = true
        AlmaWebAuthSession.shared.start(
            startPath: "/api/assistant/creative-studio/drive-auth",
            callbackPath: "/agent"
        ) { _ in
            driveBusy = false
            Task { await loadDriveStatus() }
        }
    }

    private func driveDisconnect() async {
        driveBusy = true
        defer { driveBusy = false }
        struct Resp: Decodable { let ok: Bool? }
        let _: Resp? = try? await AlmaAPI.shared.send("DELETE", "/api/assistant/creative-studio/drive-status")
        await loadDriveStatus()
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
            }.padding(14).csGlass(scheme, corner: AlmaSwiftTheme.rCard)
        }.buttonStyle(.plain)
    }
}

// MARK: - Reusable components

@available(iOS 17.0, *)
struct CSPhoto: View {
    let url: URL?
    var ratio: CGFloat = 0.75   // width / height
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Rectangle().fill(placeholder).aspectRatio(ratio, contentMode: .fit)
            .overlay {
                if let url, url.scheme == "cs-asset" {
                    // Bundled ALMA sample photo — renders instantly, zero network.
                    if let img = CSPhoto.bundled(String(url.absoluteString.dropFirst(9))) {
                        Image(uiImage: img).resizable().scaledToFill()
                    } else { fallback }
                } else if let url {
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

    /// Load a bundled sample JPEG (flat in the app bundle). Cached by UIImage internally.
    static func bundled(_ name: String) -> UIImage? {
        if let path = Bundle.main.path(forResource: name, ofType: "jpg") { return UIImage(contentsOfFile: path) }
        return UIImage(named: name)
    }
}

@available(iOS 17.0, *)
struct CSGalleryTile: View {
    let item: CSGalleryItem
    var onRetry: (() -> Void)? = nil
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Group {
            if item.previewUrl == nil && item.isPending {
                CSGeneratingTile(createdAt: item.createdAt, label: item.isVideo ? "ভিডিও হচ্ছে…" : "তৈরি হচ্ছে…")
                    .aspectRatio(0.78, contentMode: .fit)
            } else if item.previewUrl == nil && item.isFailed {
                failedTile
            } else {
                photoTile
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(.white.opacity(0.08), lineWidth: 1))
    }

    private var failedTile: some View {
        VStack(spacing: 8) {
            Text("ব্যর্থ\(item.error.map { " · \($0.prefix(36))" } ?? "")")
                .font(.system(size: 10.5, weight: .medium)).foregroundStyle(Color(red: 1, green: 0.45, blue: 0.45))
                .multilineTextAlignment(.center).padding(.horizontal, 8)
            if let onRetry {
                Button { onRetry(); CSHaptic.tap() } label: {
                    Text("🔁 আবার চালাও").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                        .padding(.vertical, 7).padding(.horizontal, 13)
                        .background(AgentPalette.coral, in: Capsule())
                }.buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity).aspectRatio(0.78, contentMode: .fit)
        .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.3))
    }

    private var photoTile: some View {
        CSPhoto(url: item.imageURL, ratio: 0.78)
            .overlay(alignment: .topLeading) {
                HStack(spacing: 5) {
                    Text(item.isExecuted ? "পোস্ট" : item.isFailed ? "ব্যর্থ" : "পেন্ডিং").font(.system(size: 9.5, weight: .bold))
                        .foregroundStyle(item.isExecuted ? Color(red: 0.03, green: 0.07, blue: 0.05) : Color(red: 0.17, green: 0.12, blue: 0))
                        .padding(.vertical, 4).padding(.horizontal, 9)
                        .background(item.isExecuted ? AgentPalette.teal : Color(red: 0.91, green: 0.72, blue: 0.27), in: Capsule())
                    if item.brandedUrl != nil {
                        Text("Branded").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                            .padding(.vertical, 4).padding(.horizontal, 8)
                            .background(AgentPalette.coral.opacity(0.9), in: Capsule())
                    }
                }.padding(10)
            }
            .overlay {
                if item.isVideo {
                    Image(systemName: "play.fill").font(.system(size: 15)).foregroundStyle(.white)
                        .frame(width: 38, height: 38).background(.black.opacity(0.5), in: Circle())
                } else if item.isAudio {
                    Image(systemName: "music.note").font(.system(size: 20)).foregroundStyle(.white)
                        .frame(width: 42, height: 42).background(.black.opacity(0.5), in: Circle())
                }
            }
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title).font(.system(size: 12.5, weight: .bold)).foregroundStyle(.white).lineLimit(1)
                    Text(item.modeLabel).font(.system(size: 10)).foregroundStyle(.white.opacity(0.62))
                }.padding(11).frame(maxWidth: .infinity, alignment: .leading)
                .background(LinearGradient(colors: [.black.opacity(0.82), .clear], startPoint: .bottom, endPoint: .center))
            }
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
                        Text(credits).font(.system(size: 11, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
                    }.padding(.top, 2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 15, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
            }
            .padding(11).csGlass(scheme, corner: AlmaSwiftTheme.rCard)
        }.buttonStyle(.plain)
    }
}

@available(iOS 17.0, *)
struct CSSectionHeader: View {
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
struct CSPill: View {
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
struct CSSegment: View {
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
struct CSChip: View {
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
struct CSChipRow: View {
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
    @State var item: CSGalleryItem
    let vm: CreativeStudioVM
    /// Lightbox neighbours (web prev/next); empty = single item.
    var siblings: [CSGalleryItem] = []
    var onCreateFrom: ((CSGalleryItem) -> Void)? = nil
    var onReelFrom: ((CSGalleryItem) -> Void)? = nil
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @State private var rating: String?
    @State private var showBranded = true
    @State private var showFinish = false
    @State private var player: AVPlayer?
    // Build-67: native editor + real download/share + delete + in-sheet feedback
    @State private var showEditor = false
    @State private var showMaskRepair = false
    @State private var framedOverride: URL?      // freshest render, straight from the finish response
    @State private var downloading = false
    @State private var sharing = false
    @State private var confirmDelete = false
    @State private var deleting = false

    /// Finishing exists (server copy or the one just rendered in this sheet)?
    private var hasFinishing: Bool { item.brandedUrl != nil || framedOverride != nil }

    private var displayURL: URL? {
        (showBranded ? (framedOverride ?? item.brandedURL ?? item.previewURL) : item.previewURL) ?? item.imageURL
    }

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                media.padding(.horizontal, 18).padding(.top, 16).id("cs-detail-top")

                // Original ↔ Branded toggle (only when a branded variant exists)
                if hasFinishing {
                    HStack(spacing: 0) {
                        brandedBtn(item.isVideo ? "টেমপ্লেট সহ" : "Logo সহ", true)
                        brandedBtn("আসল", false)
                    }
                    .padding(4).background(.black.opacity(0.28), in: Capsule())
                    .frame(maxWidth: .infinity)
                    .padding(.top, 12)
                }

                HStack(alignment: .firstTextBaseline) {
                    Text(item.title).font(.system(size: 20, weight: .heavy)).foregroundStyle(AgentPalette(scheme).ink)
                    Spacer()
                    if siblings.count > 1, let idx = siblings.firstIndex(where: { $0.id == item.id }) {
                        HStack(spacing: 6) {
                            navButton("chevron.left") { move(-1) }
                            Text("\(almaBn(idx + 1)) / \(almaBn(siblings.count))").font(.system(size: 11.5, weight: .bold)).monospacedDigit()
                                .foregroundStyle(AgentPalette(scheme).muted)
                            navButton("chevron.right") { move(1) }
                        }
                    }
                }
                .padding(.horizontal, 18).padding(.top, 16)
                HStack(spacing: 7) {
                    metaTag(item.modeLabel); metaTag(item.provider ?? "—"); metaTag(item.isExecuted ? "পোস্ট হয়েছে" : (item.isFailed ? "ব্যর্থ" : "পেন্ডিং"))
                    metaTag(item.lifecycleBn)
                }.padding(.horizontal, 18).padding(.top, 8)

                // Web lightbox facts: verified original · requested aspect · cost · publishable · receipt
                if !item.id.hasPrefix("sample-") {
                    VStack(alignment: .leading, spacing: 6) {
                        fact("Verified original", item.originalVariant?.dimensionLabel ?? "এই record-এ verified descriptor নেই")
                        fact("Requested aspect", item.aspectRatio ?? "Not recorded")
                        fact("Engine / model", [item.engine ?? item.provider, item.imageModel].compactMap { $0 }.joined(separator: " · ").isEmpty ? "—" : [item.engine ?? item.provider, item.imageModel].compactMap { $0 }.joined(separator: " · "))
                        fact("Cost", item.costUsd.map { String(format: "$%.3f", $0) } ?? item.costBdt.map { "৳\(almaBn(Int($0.rounded())))" } ?? "Not recorded")
                        fact("Publishable", item.publishable == true ? "Server says yes" : "No")
                        fact("Created", item.createdAt.map { String($0.prefix(10)) } ?? "—")
                        if let r = item.referenceReceipt {
                            HStack(spacing: 6) {
                                Image(systemName: r.allRequiredSent ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                                    .foregroundStyle(r.allRequiredSent ? AgentPalette.teal : .orange)
                                Text("Reference receipt · \(almaBn(r.sentCount))/\(almaBn(r.expectedCount)) sent · \(r.roles.joined(separator: ", "))")
                                    .font(.system(size: 11)).foregroundStyle(AgentPalette(scheme).muted)
                            }
                        }
                        if let qc = item.qcDetailsBn, !qc.isEmpty {
                            Text(qc).font(.system(size: 11)).foregroundStyle(AgentPalette(scheme).muted)
                        }
                    }
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading).csGlass(scheme, corner: 14)
                    .padding(.horizontal, 18).padding(.top, 12)
                }

                // V2: reel cover picker — FB/IG reels need a cover frame
                if item.isVideo, let covers = item.coverOptions, !covers.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("কভার বাছুন").font(.system(size: 12.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                ForEach(covers, id: \.path) { c in
                                    Button { Task { await vm.setReelCover(item, coverPath: c.path) }; CSHaptic.tap() } label: {
                                        CSPhoto(url: CS.url(c.url), ratio: 0.6).frame(width: 52, height: 86)
                                            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                                            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(.white.opacity(0.2), lineWidth: 1))
                                    }.buttonStyle(.plain)
                                }
                            }
                        }
                    }.padding(.horizontal, 18).padding(.top, 14)
                }

                actionsRow.padding(.horizontal, 18).padding(.top, 18)

                // Retry (failed renders)
                if item.isFailed {
                    Button {
                        Task { await vm.retry(item); dismiss() }; CSHaptic.tap()
                    } label: {
                        Label("🔁 আবার চালাও", systemImage: "arrow.clockwise")
                            .font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(14)
                            .background(AgentPalette.coral, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }.buttonStyle(.plain).padding(.horizontal, 18).padding(.top, 14)
                }

                // CS4: AI brand model → save into the Models library
                if item.modelCreator != nil && item.isExecuted && item.storagePath != nil {
                    Button { Task { await vm.saveGeneratedModel(item) }; CSHaptic.tap() } label: {
                        Text("✅ মডেল হিসেবে সেভ (\(CS.roleBn(item.modelCreator)))")
                            .font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(14)
                            .background(AgentPalette.teal, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    }.buttonStyle(.plain).padding(.horizontal, 18).padding(.top, 14)
                }

                // Create from asset (web "Create from asset" / "Use identity") + reel composer hand-off
                if item.isExecuted && item.storagePath != nil && !item.isVideo && !item.isAudio && !item.id.hasPrefix("sample-") {
                    HStack(spacing: 10) {
                        if let onCreateFrom {
                            Button { onCreateFrom(item); CSHaptic.tap() } label: {
                                Label("এই ছবি থেকে নতুন তৈরি", systemImage: "wand.and.stars")
                                    .font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
                                    .frame(maxWidth: .infinity).padding(13)
                                    .background(CS.cta, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            }.buttonStyle(.plain)
                        }
                        if let onReelFrom {
                            Button { onReelFrom(item); CSHaptic.tap() } label: {
                                Label("রিল কম্পোজার", systemImage: "film")
                                    .font(.system(size: 13, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                                    .frame(maxWidth: .infinity).padding(13).csGlass(scheme, corner: 14)
                            }.buttonStyle(.plain)
                        }
                    }.padding(.horizontal, 18).padding(.top, 14)

                    // One-tap reel — same signed estimate → confirmation gate as every paid run
                    // (the old direct POST was rejected server-side with run_estimate_required).
                    VStack(alignment: .leading, spacing: 8) {
                        Text("এক ট্যাপে রিল (Veo · 9:16 · premium)").font(.system(size: 12.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                        HStack(spacing: 8) {
                            ForEach(CS.reelChainDurations, id: \.self) { d in
                                Button { Task { _ = await vm.reelFromImage(item, seconds: d) }; CSHaptic.tap() } label: {
                                    Text("\(almaBn(d))s ~৳\(almaBn(CS.longReelCostBdt(d)))")
                                        .font(.system(size: 12, weight: .bold)).foregroundStyle(.white)
                                        .padding(.vertical, 9).padding(.horizontal, 13)
                                        .background(AgentPalette.coral, in: Capsule())
                                }.buttonStyle(.plain).disabled(vm.generating)
                            }
                        }
                        Text("আগে signed estimate দেখাবে · \(CS.reelChainDurations.last.map { _ in "16/24s = 2×/3× 8s chain" } ?? "")")
                            .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
                    }.padding(.horizontal, 18).padding(.top, 14)
                }

                // Production V4 precision finishing. Only canonical project assets
                // can open the mask editor; estimate and paid confirmation happen there.
                if !item.isVideo, !item.isAudio, item.storagePath != nil, item.archivedToDrive != true,
                   item.projectAssetId != nil, vm.activeProject?.brandProfileId != nil {
                    Button { showMaskRepair = true; CSHaptic.tap() } label: {
                        Label("Precision repair (mask)", systemImage: "paintbrush.pointed.fill")
                            .font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                            .frame(maxWidth: .infinity).padding(14)
                            .background(Color.blue.opacity(0.82), in: RoundedRectangle(cornerRadius: 14))
                    }.buttonStyle(.plain).padding(.horizontal, 18).padding(.top, 10)
                }

                // Feedback → deterministic scene weighting (CS4)
                if item.isExecuted {
                    HStack(spacing: 10) {
                        rateButton("👍 এমন সিন বেশি চাই", "good")
                        rateButton("👎 বাদ দাও", "bad")
                    }.padding(.horizontal, 18).padding(.top, 14)
                }

                // Native finishing (image: brand frame; video: motion templates).
                // Build-67 rule: an image that ALREADY has finishing is edit-only —
                // the button opens the editor (text + layout) instead of re-finishing.
                if item.storagePath != nil && !item.isAudio && (item.isExecuted || !item.isVideo)
                    && (!item.isVideo || vm.canFinishVideo(item)) {
                    if !item.isVideo && hasFinishing {
                        Button { showEditor = true; CSHaptic.tap() } label: {
                            Label("এডিট করুন (লেখা + লেআউট)", systemImage: "slider.horizontal.below.rectangle")
                                .font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                                .frame(maxWidth: .infinity).padding(14)
                                .background(CS.cta, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }.buttonStyle(.plain).padding(.horizontal, 18).padding(.top, 14)
                    } else {
                        Button { withAnimation { showFinish.toggle() }; CSHaptic.tap() } label: {
                            Label(showFinish ? "ফিনিশিং বন্ধ করুন"
                                              : item.isVideo ? "ভিডিও ফিনিশিং" : "ফিনিশিং (logo + code + hook)",
                                  systemImage: "wand.and.rays")
                                .font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                                .frame(maxWidth: .infinity).padding(14)
                                .background(CS.cta, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }.buttonStyle(.plain).padding(.horizontal, 18).padding(.top, 14)
                    }
                    if showFinish {
                        Group {
                            if item.isVideo {
                                CSVideoFinishPanel(item: item, vm: vm) { showFinish = false }
                            } else {
                                CSFinishPanel(item: item, vm: vm) { framedUrl in
                                    // The owner must SEE the result instantly: show the
                                    // fresh render at the top of the sheet, no refresh race.
                                    withAnimation {
                                        showFinish = false
                                        showBranded = true
                                        framedOverride = CS.url(framedUrl)
                                    }
                                    if let fresh = vm.gallery.first(where: { $0.id == item.id }) { item = fresh }
                                    proxy.scrollTo("cs-detail-top", anchor: .top)
                                }
                            }
                        }
                        .padding(.horizontal, 18).padding(.top, 12)
                    }
                }

                // Delete (real gallery rows only — samples can't be deleted)
                if !item.id.hasPrefix("sample-") {
                    Button { confirmDelete = true; CSHaptic.tap() } label: {
                        Label(deleting ? "মুছে ফেলা হচ্ছে…" : "মুছে ফেলুন", systemImage: "trash")
                            .font(.system(size: 13.5, weight: .bold)).foregroundStyle(Color(red: 1, green: 0.42, blue: 0.42))
                            .frame(maxWidth: .infinity).padding(13)
                            .background(Color(red: 1, green: 0.3, blue: 0.3).opacity(0.12),
                                        in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .strokeBorder(Color(red: 1, green: 0.3, blue: 0.3).opacity(0.3), lineWidth: 1))
                    }
                    .buttonStyle(.plain).disabled(deleting)
                    .padding(.horizontal, 18).padding(.top, 14)
                }
                Color.clear.frame(height: 40)
            }
        }
        }
        .presentationBackground { AgentAuroraBackground() }
        .onDisappear { player?.pause() }
        // The main screen's toast floats UNDER this sheet — show it in-sheet too,
        // otherwise finishing/reel/rate feedback is invisible (owner report, build 66).
        .overlay(alignment: .top) { CSToastView(message: vm.toast) }
        .csEstimateAlert(vm: vm)
        .alert("ছবিটা একেবারে মুছে যাবে — নিশ্চিত?", isPresented: $confirmDelete) {
            Button("বাতিল", role: .cancel) {}
            Button("মুছে ফেলুন", role: .destructive) {
                Task {
                    deleting = true
                    let ok = await vm.deleteItem(item)
                    deleting = false
                    if ok { dismiss() }
                }
            }
        } message: { Text("ফাইলটাও স্টোরেজ থেকে মুছে যাবে, ফেরত আনা যাবে না।") }
        .fullScreenCover(isPresented: $showEditor) {
            CSFinishEditorSheet(item: item, vm: vm) { framedUrl in
                showBranded = true
                framedOverride = CS.url(framedUrl)
                if let fresh = vm.gallery.first(where: { $0.id == item.id }) { item = fresh }
            }
        }
        .fullScreenCover(isPresented: $showMaskRepair) {
            CSMaskRepairSheet(item: item, vm: vm)
        }
    }

    @ViewBuilder private var media: some View {
        if item.isVideo, let url = displayURL {
            VideoPlayer(player: playerFor(url))
                .aspectRatio(9/13.0, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(.white.opacity(0.1), lineWidth: 1))
        } else if item.isAudio, let url = displayURL {
            VStack(spacing: 12) {
                Text("🎵").font(.system(size: 44))
                Text(item.summary ?? "অডিও").font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).muted)
                    .multilineTextAlignment(.center)
                CSAudioPlayerBar(url: url)
            }
            .frame(maxWidth: .infinity).padding(24).csGlass(scheme, corner: 22)
        } else {
            CSPhoto(url: displayURL, ratio: 0.82)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(.white.opacity(0.1), lineWidth: 1))
        }
    }
    private func playerFor(_ url: URL) -> AVPlayer {
        if let player, (player.currentItem?.asset as? AVURLAsset)?.url == url { return player }
        let pl = AVPlayer(url: url)
        DispatchQueue.main.async { self.player = pl }
        return pl
    }

    private func brandedBtn(_ label: String, _ value: Bool) -> some View {
        Button { showBranded = value; CSHaptic.tap() } label: {
            Text(label).font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(showBranded == value ? .white : AgentPalette(scheme).muted)
                .padding(.vertical, 8).padding(.horizontal, 18)
                .background { if showBranded == value { Capsule().fill(AgentPalette.coral) } }
        }.buttonStyle(.plain)
    }

    /// Build-67: download saves the REAL file into Photos, share hands the REAL
    /// file to the share sheet (the old ShareLink only shared a supabase link),
    /// and the editor is fully native (no more invisible web push under the sheet).
    private var actionsRow: some View {
        HStack(spacing: 10) {
            if displayURL != nil {
                actionButton(downloading ? "সেভ হচ্ছে…" : (item.scopedDownloadURL != nil && !showBranded ? "Original" : "ডাউনলোড"),
                             downloading ? "arrow.triangle.2.circlepath" : "arrow.down.to.line", primary: true) {
                    guard !downloading, let url = displayURL else { return }
                    Task {
                        downloading = true
                        defer { downloading = false }
                        // Original (not branded) → the scoped full-resolution download route when the
                        // canonical lineage tuple exists (web "Download original"); else the preview URL.
                        let target = (!showBranded || !hasFinishing) ? (item.scopedDownloadURL ?? url) : url
                        guard let data = try? await CSMediaSaver.fetch(target), !data.isEmpty else { vm.flash("ডাউনলোড হয়নি — নেট চেক করুন"); return }
                        let ok = await CSMediaSaver.saveToPhotos(
                            data, ext: CSMediaSaver.ext(url, isVideo: item.isVideo), isVideo: item.isVideo)
                        vm.flash(ok ? (item.isVideo ? "ভিডিও ফটো অ্যাপে সেভ হয়েছে ✅" : "ছবি ফটো অ্যাপে সেভ হয়েছে ✅")
                                    : "Photos-এ সেভের অনুমতি দেওয়া নেই — Settings → ALMA ERP → Photos")
                    }
                }
                actionButton(sharing ? "আনা হচ্ছে…" : "শেয়ার", "square.and.arrow.up", primary: false) {
                    guard !sharing, let url = displayURL else { return }
                    Task {
                        sharing = true
                        defer { sharing = false }
                        guard let data = try? await CSMediaSaver.fetch(url) else { vm.flash("ডাউনলোড হয়নি — নেট চেক করুন"); return }
                        let ext = CSMediaSaver.ext(url, isVideo: item.isVideo)
                        await MainActor.run { CSMediaSaver.share(data, filename: "alma-creative.\(ext)") }
                    }
                }
            }
            if !item.isVideo && !item.isAudio && item.storagePath != nil {
                actionButton("এডিটর", "slider.horizontal.3", primary: false) { showEditor = true }
            }
        }
    }
    private func metaTag(_ t: String) -> some View {
        Text(t).font(.system(size: 11, weight: .medium)).foregroundStyle(AgentPalette(scheme).muted)
            .padding(.vertical, 4).padding(.horizontal, 10).csGlass(scheme, corner: 999)
    }
    private func fact(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top) {
            Text(k).font(.system(size: 11)).foregroundStyle(AgentPalette(scheme).muted)
            Spacer(minLength: 12)
            Text(v).font(.system(size: 11, weight: .semibold)).foregroundStyle(AgentPalette(scheme).ink)
                .multilineTextAlignment(.trailing).lineLimit(2)
        }
    }
    private func navButton(_ icon: String, _ tap: @escaping () -> Void) -> some View {
        Button { tap(); CSHaptic.tap() } label: {
            Image(systemName: icon).font(.system(size: 13, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                .frame(width: 30, height: 30).csGlass(scheme, corner: 999)
        }.buttonStyle(.plain)
    }
    private func move(_ direction: Int) {
        guard siblings.count > 1, let idx = siblings.firstIndex(where: { $0.id == item.id }) else { return }
        let next = (idx + direction + siblings.count) % siblings.count
        player?.pause(); player = nil
        showFinish = false; framedOverride = nil; rating = nil
        item = siblings[next]
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

/// Minimal audio player bar for audio_gen items (native playback, no web escape).
@available(iOS 17.0, *)
struct CSAudioPlayerBar: View {
    let url: URL
    @State private var player: AVPlayer?
    @State private var playing = false
    var body: some View {
        Button {
            if player == nil { player = AVPlayer(url: url) }
            if playing {
                player?.pause()
                playing = false
            } else {
                guard AlmaLiveVoicePreviewTakeoverRelay.shared
                    .stopAndRestoreBeforeAudioTakeover()
                else { return }
                player?.play()
                playing = true
            }
            CSHaptic.tap()
        } label: {
            Label(playing ? "থামাও" : "বাজাও", systemImage: playing ? "pause.fill" : "play.fill")
                .font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                .padding(.vertical, 11).padding(.horizontal, 26)
                .background(CS.cta, in: Capsule())
        }
        .buttonStyle(.plain)
        .onDisappear { player?.pause() }
    }
}

/// Per-image finishing form (web FinishPanel twin) — the owner types THIS image's
/// code + hook, picks layout/theme, and the server stamps the real brand frame.
/// The drag/resize LifestyleEditor stays web-only; this covers everything else.
@available(iOS 17.0, *)
struct CSFinishPanel: View {
    let item: CSGalleryItem
    let vm: CreativeStudioVM
    let onDone: (String?) -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var hook = ""
    @State private var code = ""
    @State private var productName = ""
    @State private var price = ""
    @State private var eyebrow = ""
    @State private var offer = ""
    @State private var modeIdx = 0     // lifestyle | model_overlay | product_card
    @State private var themeIdx = 0
    @State private var footer = false
    @State private var fitContain = false
    @State private var busy = false

    private var isLifestyle: Bool { CS.finishModes[modeIdx].id == "lifestyle" }
    private var availableThemes: [(id: String, bn: String)] {
        let ids = vm.brandStatus?.themes ?? []
        let known = CS.finishThemes.filter { ids.isEmpty || ids.contains($0.id) || $0.id == "default" }
        return known.isEmpty ? CS.finishThemes : known
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if isLifestyle {
                field("ছোট লাইন (খালি রাখলে: নতুন এসেছে)", text: $eyebrow)
            }
            field(isLifestyle ? "মূল লেখা (যেমন: পার্পেল কালার ফ্যামিলি কম্বো সেট)" : "Hook (যেমন: ঈদ স্পেশাল অফার)", text: $hook)
            if isLifestyle {
                field("অফার লাইন (খালি রাখলে: অফার প্রাইস জানতে ইনবক্স করুন)", text: $offer)
            }
            HStack(spacing: 8) {
                field("Product code (যেমন: ALM-315)", text: $code)
                field("দাম (যেমন: ৳2,490)", text: $price).frame(width: 130)
            }
            field("প্রোডাক্টের নাম — ঐচ্ছিক", text: $productName)

            Text("লেআউট").font(.system(size: 11, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            CSSegment(items: CS.finishModes.map(\.bn), index: $modeIdx)
            Text("থিম").font(.system(size: 11, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            HStack(spacing: 8) {
                ForEach(Array(availableThemes.enumerated()), id: \.offset) { i, t in
                    CSChip(text: t.bn, on: themeIdx == i) { themeIdx = i }
                }
            }
            if CS.finishModes[modeIdx].id == "model_overlay" {
                Toggle("নিচে ফুটার (পেজ নাম + অর্ডার লাইন)", isOn: $footer)
                    .font(.system(size: 12.5)).tint(AgentPalette.coral)
            }
            if isLifestyle {
                Toggle("পুরো ছবি রাখুন (ক্রপ ছাড়া)", isOn: $fitContain)
                    .font(.system(size: 12.5)).tint(AgentPalette.coral)
            }

            Button {
                CSHaptic.tap()
                Task {
                    guard !hook.trimmingCharacters(in: .whitespaces).isEmpty else {
                        vm.flash(isLifestyle ? "মূল লেখাটা (headline) দিন" : "একটা hook লেখা লাগবে"); return
                    }
                    guard let path = item.storagePath else { return }
                    busy = true
                    let framed = await vm.finishImage(CSFinishPayload(
                        storagePath: path,
                        hook: hook.trimmingCharacters(in: .whitespaces),
                        productCode: code.isEmpty ? nil : code,
                        productName: productName.trimmingCharacters(in: .whitespaces).isEmpty ? nil : productName.trimmingCharacters(in: .whitespaces),
                        price: price.trimmingCharacters(in: .whitespaces).isEmpty ? nil : price.trimmingCharacters(in: .whitespaces),
                        eyebrow: isLifestyle && !eyebrow.isEmpty ? eyebrow : nil,
                        offer: isLifestyle && !offer.isEmpty ? offer : nil,
                        mode: CS.finishModes[modeIdx].id,
                        theme: availableThemes[themeIdx].id,
                        footer: footer,
                        fit: isLifestyle ? (fitContain ? "contain" : "cover") : nil,
                        pendingActionId: item.id.hasPrefix("sample-") ? nil : item.id))
                    busy = false
                    if framed != nil { onDone(framed) }
                }
            } label: {
                HStack(spacing: 8) {
                    if busy { ProgressView().tint(.white) }
                    Text(busy ? "হচ্ছে…" : "Finishing করুন").font(.system(size: 14, weight: .bold))
                }
                .foregroundStyle(.white).frame(maxWidth: .infinity).padding(13)
                .background(AgentPalette.coral, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }.buttonStyle(.plain).disabled(busy)
        }
        .padding(14).csGlass(scheme, corner: 18)
        .task { if vm.brandStatus == nil { await vm.loadLibraryExtras() } }
    }

    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .font(.system(size: 13)).foregroundStyle(AgentPalette(scheme).ink)
            .padding(11).background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.1), lineWidth: 1))
    }
}

/// Production V4 video finishing keeps the existing native design while exposing
/// the same Timeline Lite / Templates split as the web workspace.
@available(iOS 17.0, *)
struct CSVideoFinishPanel: View {
    private enum Mode: String, CaseIterable, Identifiable {
        case timeline, templates
        var id: String { rawValue }
        var label: String { self == .timeline ? "✂️ Timeline" : "🎞️ Templates" }
    }

    let item: CSGalleryItem
    let vm: CreativeStudioVM
    let onDone: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var mode: Mode = .timeline

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Video finishing mode", selection: $mode) {
                ForEach(Mode.allCases) { mode in Text(mode.label).tag(mode) }
            }
            .pickerStyle(.segmented)

            if mode == .timeline {
                CSVideoTimelineFinishPanel(item: item, vm: vm, onDone: onDone)
            } else {
                CSMotionTemplateFinishPanel(item: item, vm: vm, onDone: onDone)
            }
        }
        .padding(14).csGlass(scheme, corner: 18)
    }
}

/// Scope-authorized Timeline Lite queue surface. Fetching the source is read-only;
/// the explicit button queues a zero-cost, server-revalidated ffmpeg derivative.
@available(iOS 17.0, *)
private struct CSVideoTimelineFinishPanel: View {
    let item: CSGalleryItem
    let vm: CreativeStudioVM
    let onDone: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var source: CSVideoEditSource?
    @State private var contract = CSVideoEditContract.fresh(durationSec: 15)
    @State private var sourceLoading = true
    @State private var sourceError: String?
    @State private var queueing = false
    @State private var working = false
    @State private var progress = ""
    @State private var submitTask: Task<Void, Never>?
    @State private var pollTask: Task<Void, Never>?
    @State private var lifecycleToken = UUID()

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            if sourceLoading {
                HStack(spacing: 10) {
                    ProgressView().tint(AgentPalette.coral)
                    Text("Canonical video source যাচাই হচ্ছে…")
                        .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).ink)
                }.padding(.vertical, 8)
            } else if let sourceError {
                VStack(alignment: .leading, spacing: 8) {
                    Label(sourceError, systemImage: "lock.trianglebadge.exclamationmark")
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Color.orange)
                    Text("Active brand/project-এর owner-accessible canonical asset ছাড়া video render queue হবে না।")
                        .font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).muted)
                    Button("আবার যাচাই করুন") { Task { await loadSource() } }
                        .font(.system(size: 12, weight: .bold)).foregroundStyle(AgentPalette.coral)
                }
                .padding(11)
                .background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
            } else if working {
                HStack(spacing: 10) {
                    ProgressView().tint(AgentPalette.coral)
                    Text(progress.isEmpty ? "বাছাই করা track render হচ্ছে…" : progress)
                        .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).ink)
                }.padding(.vertical, 8)
            } else {
                CSVideoTimelineEditor(contract: $contract)

                if let validation = contract.validationMessage {
                    Label(validation, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Color.orange)
                        .padding(9).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
                }

                VStack(alignment: .leading, spacing: 3) {
                    Label("Selected-track partial rerender · ৳0", systemImage: "checkmark.shield.fill")
                        .font(.system(size: 12.5, weight: .bold)).foregroundStyle(AgentPalette.teal)
                    Text("Server scope ও source path আবার যাচাই করবে; মূল visual source overwrite বা regenerate হবে না।")
                        .font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).muted)
                }

                Button { CSHaptic.tap(); startSubmit() } label: {
                    HStack(spacing: 8) {
                        if queueing { ProgressView().tint(.white) }
                        Text(queueing ? "শুরু হচ্ছে…" : "বাছাই করা track render করুন · ৳0")
                            .font(.system(size: 14, weight: .bold))
                    }
                    .foregroundStyle(.white).frame(maxWidth: .infinity).padding(13)
                    .background(AgentPalette.coral, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(queueing || contract.validationMessage != nil || source == nil)
                .opacity(contract.validationMessage == nil && source != nil ? 1 : 0.5)
            }
        }
        .task(id: "\(item.id):\(vm.activeProject?.id ?? "none")") { await loadSource() }
        .onDisappear { cancelOperations() }
    }

    private func loadSource() async {
        sourceLoading = true
        sourceError = nil
        do {
            let loaded = try await vm.fetchVideoEditSource(item)
            guard !Task.isCancelled else { return }
            source = loaded
            var editorContract = loaded.editContract ?? .fresh(durationSec: loaded.durationSec)
            editorContract.ensureStableEditorIDs()
            contract = editorContract
        } catch {
            guard !Task.isCancelled else { return }
            source = nil
            if let api = error as? AlmaAPIError {
                switch api {
                case .notAuthenticated:
                    sourceError = "সেশন শেষ — আবার লগইন করুন"
                case let .http(_, body):
                    sourceError = CS.serverMessage(body) ?? "Canonical video source পাওয়া যায়নি"
                default:
                    sourceError = "Canonical video source যাচাই করা যায়নি"
                }
            } else {
                sourceError = "Canonical video source যাচাই করা যায়নি"
            }
        }
        sourceLoading = false
    }

    private func startSubmit() {
        guard !queueing, !working, submitTask == nil else { return }
        let draft = contract
        if let validation = draft.validationMessage { vm.flash(validation); return }
        guard source != nil else { return }
        queueing = true // Synchronous: a second tap cannot enqueue another POST.
        let token = UUID()
        lifecycleToken = token
        submitTask = Task { @MainActor in
            await submit(draft, token: token)
        }
    }

    private func submit(_ draft: CSVideoEditContract, token: UUID) async {
        defer {
            if lifecycleToken == token {
                queueing = false
                submitTask = nil
            }
        }
        guard !Task.isCancelled, lifecycleToken == token else { return }
        guard let jobID = await vm.partiallyFinishVideo(item, contract: draft) else { return }
        guard !Task.isCancelled, lifecycleToken == token else { return }
        working = true
        progress = "বাছাই করা track render হচ্ছে… · ৳0"
        poll(jobID, token: token)
    }

    private func poll(_ jobID: String, token: UUID) {
        guard lifecycleToken == token else { return }
        pollTask?.cancel()
        pollTask = Task { @MainActor in
            // Production's 4-second rhythm, bounded so a lost terminal response
            // cannot leave an invisible background loop alive forever.
            for _ in 0..<225 {
                do { try await Task.sleep(nanoseconds: 4_000_000_000) } catch { return }
                guard !Task.isCancelled, lifecycleToken == token else { return }
                guard let job = await vm.fetchJob(jobID) else { continue }
                guard !Task.isCancelled, lifecycleToken == token else { return }
                if let p = job.videoProgress, let step = p.step, let total = p.total {
                    progress = "ধাপ \(almaBn(step))/\(almaBn(total)): \(p.labelBn ?? "")"
                }
                if job.status == "executed" {
                    working = false
                    vm.flash("Timeline edit সম্পন্ন — মূল source অপরিবর্তিত আছে")
                    await vm.refreshGallery()
                    onDone()
                    return
                }
                if job.status == "failed" {
                    working = false
                    vm.flash(job.error ?? "Timeline edit ব্যর্থ হয়েছে")
                    return
                }
            }
            guard lifecycleToken == token else { return }
            working = false
            vm.flash("Render এখনো শেষ হয়নি — Gallery থেকে status দেখুন")
        }
    }

    private func cancelOperations() {
        lifecycleToken = UUID()
        submitTask?.cancel()
        submitTask = nil
        pollTask?.cancel()
        pollTask = nil
        queueing = false
        working = false
    }
}

/// Native value editor for the production TimelineLite + TranscriptEditor
/// contract. It never reads files or renders locally; it only prepares the
/// server-validated, non-destructive edit description.
@available(iOS 17.0, *)
private struct CSVideoTimelineEditor: View {
    @Binding var contract: CSVideoEditContract
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Timeline Lite").font(.system(size: 13.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink)
                    Text("Output \(time(contract.editedDurationSec))s · source \(time(contract.sourceDurationSec))s")
                        .font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).muted)
                }
                Spacer()
                Button { addSegment(); CSHaptic.tap() } label: {
                    Label("Clip", systemImage: "plus").font(.system(size: 11.5, weight: .bold))
                        .padding(.vertical, 6).padding(.horizontal, 9)
                        .background(AgentPalette.coral.opacity(0.16), in: Capsule())
                }
                .buttonStyle(.plain).foregroundStyle(AgentPalette.coral)
                .disabled(contract.segments.count >= 32)
            }

            section("Ordered trim segments") {
                ForEach(contract.segments) { segment in
                    let index = contract.segments.firstIndex { $0.id == segment.id } ?? 0
                    let segmentValue = segmentBinding(segment.id, fallback: segment)
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            Text("CLIP \(almaBn(index + 1))")
                                .font(.system(size: 10.5, weight: .black)).foregroundStyle(AgentPalette.coral)
                            Spacer()
                            Button { moveSegment(segment.id, by: -1) } label: { Image(systemName: "arrow.up") }
                                .disabled(index == 0)
                            Button { moveSegment(segment.id, by: 1) } label: { Image(systemName: "arrow.down") }
                                .disabled(index == contract.segments.count - 1)
                            Button(role: .destructive) { removeSegment(segment.id) } label: {
                                Image(systemName: "trash")
                            }
                            .disabled(contract.segments.count == 1)
                        }
                        HStack(spacing: 8) {
                            timeField("শুরু", value: segmentValue.startSec)
                            timeField("শেষ", value: segmentValue.endSec)
                        }
                    }
                    .padding(9)
                    .background(Color.white.opacity(scheme == .dark ? 0.045 : 0.3), in: RoundedRectangle(cornerRadius: 10))
                }
            }

            section("Crop · focus · safe zone") {
                cropPreview
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(CSVideoEditContract.cropAspects, id: \.self) { aspect in
                            chip(aspect == "original" ? "মূল" : aspect, selected: contract.crop.aspect == aspect) {
                                contract.crop.aspect = aspect
                            }
                        }
                    }
                }
                valueSlider("Focus ↔", value: $contract.crop.focusX)
                valueSlider("Focus ↕", value: $contract.crop.focusY)
            }

            section("Track volume") {
                HStack(alignment: .top, spacing: 12) {
                    volumeSlider("মূল", value: $contract.volumes.original)
                    volumeSlider("মিউজিক", value: $contract.volumes.music)
                    volumeSlider("ভয়েস", value: $contract.volumes.voiceover)
                }
            }

            section("Caption + cover") {
                Picker("Caption position", selection: $contract.captionPlacement) {
                    Text("উপরে").tag("top")
                    Text("মাঝে").tag("center")
                    Text("নিচে").tag("bottom")
                }
                .pickerStyle(.segmented)
                HStack {
                    Text("Cover · \(time(contract.cover.atSec))s")
                        .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
                    Slider(value: coverBinding, in: 0...safeEditedDuration, step: 0.1)
                        .tint(AgentPalette.coral)
                }
            }

            section("এইবার যে track-গুলো render হবে") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(CSVideoEditContract.renderTracks, id: \.self) { track in
                            chip(renderTrackLabel(track), selected: contract.rerender.contains(track)) {
                                toggleRenderTrack(track)
                            }
                        }
                    }
                }
            }

            transcriptEditor
        }
    }

    @ViewBuilder private var transcriptEditor: some View {
        section("Transcript + timing") {
            HStack(spacing: 7) {
                Button { addCue("caption"); CSHaptic.tap() } label: { Label("Caption", systemImage: "plus") }
                Button { addCue("voiceover"); CSHaptic.tap() } label: { Label("Voice", systemImage: "plus") }
                Spacer()
            }
            .font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette.coral)
            .disabled(contract.transcript.count >= 100)

            if contract.transcript.isEmpty {
                Text("এখনো কোনো timed line নেই")
                    .font(.system(size: 11.5)).foregroundStyle(AgentPalette(scheme).muted)
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
            } else {
                ForEach(contract.transcript) { cue in
                    let cueValue = cueBinding(cue.id, fallback: cue)
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            Picker("Track", selection: cueValue.track) {
                                Text("CAPTION").tag("caption")
                                Text("VOICE").tag("voiceover")
                            }
                            .pickerStyle(.segmented).frame(maxWidth: 190)
                            Spacer()
                            Button(role: .destructive) { removeCue(cue.id) } label: {
                                Image(systemName: "trash")
                            }
                        }
                        HStack(spacing: 8) {
                            timeField("শুরু", value: cueValue.startSec)
                            timeField("শেষ", value: cueValue.endSec)
                        }
                        TextEditor(text: cueTextBinding(cue.id))
                            .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).ink)
                            .scrollContentBackground(.hidden).frame(minHeight: 62)
                            .padding(7).background(Color.black.opacity(0.16), in: RoundedRectangle(cornerRadius: 9))
                    }
                    .padding(9)
                    .background(Color.white.opacity(scheme == .dark ? 0.045 : 0.3), in: RoundedRectangle(cornerRadius: 10))
                }
            }
            Text("Caption timing video-তে burn হয়; Voice line timing metadata থাকে, আর existing voice track volume অনুযায়ী mix হয়।")
                .font(.system(size: 10.5)).foregroundStyle(AgentPalette(scheme).muted)
        }
    }
}

@available(iOS 17.0, *)
private extension CSVideoTimelineEditor {
    var cropPreview: some View {
        GeometryReader { proxy in
            let ratio = cropRatio
            let width = min(proxy.size.width, proxy.size.height * ratio)
            let height = width / ratio
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(LinearGradient(
                        colors: [AgentPalette.coral.opacity(0.36), Color.black.opacity(0.56)],
                        startPoint: .topLeading, endPoint: .bottomTrailing))
                RoundedRectangle(cornerRadius: 7)
                    .strokeBorder(Color.white.opacity(0.65), style: StrokeStyle(lineWidth: 1, dash: [5]))
                    .padding(width * 0.1)
                Circle().fill(AgentPalette.coral).frame(width: 12, height: 12)
                    .overlay(Circle().strokeBorder(Color.black.opacity(0.5), lineWidth: 2))
                    .position(
                        x: min(width - 6, max(6, width * CGFloat(contract.crop.focusX))),
                        y: min(height - 6, max(6, height * CGFloat(contract.crop.focusY))))
                Text("SAFE ZONE").font(.system(size: 9, weight: .black)).foregroundStyle(.white.opacity(0.8))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading).padding(8)
            }
            .frame(width: width, height: height)
            .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
        }
        .frame(height: 170)
    }

    var cropRatio: CGFloat {
        switch contract.crop.aspect {
        case "9:16": return 9.0 / 16.0
        case "4:5": return 4.0 / 5.0
        case "1:1": return 1
        case "16:9", "original": return 16.0 / 9.0
        default: return 16.0 / 9.0
        }
    }

    var coverBinding: Binding<Double> {
        Binding(
            get: { min(max(0, contract.cover.atSec), safeEditedDuration) },
            set: { contract.cover.atSec = $0 })
    }

    var safeEditedDuration: Double {
        let duration = contract.editedDurationSec
        return duration.isFinite ? max(0.1, min(600, duration)) : 0.1
    }

    func addSegment() {
        guard contract.segments.count < 32 else { return }
        let lastEnd = contract.segments.last?.endSec ?? 0
        let start = min(max(0, contract.sourceDurationSec - 0.5), lastEnd)
        let end = min(contract.sourceDurationSec, start + min(3, contract.sourceDurationSec))
        guard end - start >= 0.1 else { return }
        contract.segments.append(.init(
            id: "clip-\(UUID().uuidString)", startSec: start, endSec: end,
            order: contract.segments.count))
    }

    func segmentBinding(
        _ id: String, fallback: CSVideoTimelineSegment
    ) -> Binding<CSVideoTimelineSegment> {
        Binding(
            get: { contract.segments.first { $0.id == id } ?? fallback },
            set: { updated in
                guard let index = contract.segments.firstIndex(where: { $0.id == id }) else { return }
                contract.segments[index] = updated
            })
    }

    func moveSegment(_ id: String, by offset: Int) {
        guard let index = contract.segments.firstIndex(where: { $0.id == id }) else { return }
        let target = index + offset
        guard contract.segments.indices.contains(index), contract.segments.indices.contains(target) else { return }
        contract.segments.swapAt(index, target)
        normalizeSegmentOrder()
        CSHaptic.tap()
    }

    func removeSegment(_ id: String) {
        guard contract.segments.count > 1 else { return }
        contract.segments.removeAll { $0.id == id }
        normalizeSegmentOrder()
        CSHaptic.tap()
    }

    func normalizeSegmentOrder() {
        for position in contract.segments.indices { contract.segments[position].order = position }
    }

    func addCue(_ track: String) {
        guard contract.transcript.count < 100 else { return }
        let duration = safeEditedDuration
        let priorEnd = contract.transcript.last?.endSec ?? 0
        let start = min(max(0, duration - 0.5), priorEnd)
        let end = min(duration, start + min(2, duration))
        guard end - start >= 0.1 else { return }
        contract.transcript.append(.init(
            id: "cue-\(UUID().uuidString)", track: track, startSec: start, endSec: end,
            text: track == "caption" ? "নতুন ক্যাপশন" : "নতুন ভয়েসওভার লাইন"))
    }

    func cueBinding(_ id: String, fallback: CSVideoTranscriptCue) -> Binding<CSVideoTranscriptCue> {
        Binding(
            get: { contract.transcript.first { $0.id == id } ?? fallback },
            set: { updated in
                guard let index = contract.transcript.firstIndex(where: { $0.id == id }) else { return }
                contract.transcript[index] = updated
            })
    }

    func removeCue(_ id: String) {
        contract.transcript.removeAll { $0.id == id }
        CSHaptic.tap()
    }

    func cueTextBinding(_ id: String) -> Binding<String> {
        Binding(
            get: { contract.transcript.first { $0.id == id }?.text ?? "" },
            set: { value in
                guard let index = contract.transcript.firstIndex(where: { $0.id == id }) else { return }
                contract.transcript[index].text = String(value.prefix(240))
            })
    }

    func toggleRenderTrack(_ track: String) {
        var selected = Set(contract.rerender)
        if selected.contains(track) { selected.remove(track) } else { selected.insert(track) }
        contract.rerender = CSVideoEditContract.renderTracks.filter { selected.contains($0) }
    }

    func renderTrackLabel(_ track: String) -> String {
        switch track {
        case "visual": return "ভিডিও"
        case "captions": return "ক্যাপশন"
        case "audio": return "অডিও"
        case "cover": return "কভার"
        default: return track
        }
    }

    func time(_ value: Double) -> String { String(format: "%.1f", value) }

    func timeField(_ title: String, value: Binding<Double>) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
            TextField(title, value: value, format: .number.precision(.fractionLength(0...2)))
                .keyboardType(.decimalPad).font(.system(size: 12.5, design: .monospaced))
                .foregroundStyle(AgentPalette(scheme).ink).padding(8)
                .background(Color.black.opacity(0.16), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    func valueSlider(_ title: String, value: Binding<Double>) -> some View {
        HStack(spacing: 9) {
            Text(title).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
                .frame(width: 58, alignment: .leading)
            Slider(value: value, in: 0...1, step: 0.05).tint(AgentPalette.coral)
            Text("\(Int((value.wrappedValue * 100).rounded()))%")
                .font(.system(size: 10.5, design: .monospaced)).foregroundStyle(AgentPalette(scheme).muted).frame(width: 34)
        }
    }

    func volumeSlider(_ title: String, value: Binding<Double>) -> some View {
        VStack(spacing: 4) {
            Text(title).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(AgentPalette(scheme).muted)
            Slider(value: value, in: 0...1, step: 0.05).tint(AgentPalette.coral)
            Text("\(Int((value.wrappedValue * 100).rounded()))%")
                .font(.system(size: 10, design: .monospaced)).foregroundStyle(AgentPalette(scheme).muted)
        }
    }

    func chip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 11.5, weight: .bold))
                .foregroundStyle(selected ? Color.white : AgentPalette(scheme).muted)
                .padding(.vertical, 7).padding(.horizontal, 10)
                .background(selected ? AgentPalette.coral : Color.white.opacity(0.07), in: Capsule())
        }.buttonStyle(.plain)
    }

    func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 11.5, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            content()
        }
        .padding(10)
        .background(Color.black.opacity(scheme == .dark ? 0.14 : 0.05), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.white.opacity(0.08), lineWidth: 1))
    }
}

/// Existing zero-cost motion-template controls, hosted by the combined V4 panel.
@available(iOS 17.0, *)
private struct CSMotionTemplateFinishPanel: View {
    let item: CSGalleryItem
    let vm: CreativeStudioVM
    let onDone: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var price = ""
    @State private var code = ""
    @State private var name = ""
    @State private var cta = ""
    @State private var days = ""
    @State private var watermark = true
    @State private var endCard = true
    @State private var queueing = false
    @State private var working = false
    @State private var progress = ""
    @State private var submitTask: Task<Void, Never>?
    @State private var pollTask: Task<Void, Never>?
    @State private var lifecycleToken = UUID()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if queueing || working {
                HStack(spacing: 10) {
                    ProgressView().tint(AgentPalette.coral)
                    Text(queueing ? "টেমপ্লেট queue হচ্ছে…" :
                            progress.isEmpty ? "টেমপ্লেট রেন্ডার হচ্ছে… (১–৩ মিনিট)" : progress)
                        .font(.system(size: 12.5)).foregroundStyle(AgentPalette(scheme).ink)
                }.padding(.vertical, 8)
            } else {
                HStack(spacing: 10) {
                    field("দাম (৳)", text: $price)
                    field("প্রোডাক্ট কোড", text: $code)
                }
                field("প্রোডাক্টের নাম (ঐচ্ছিক)", text: $name)
                HStack(spacing: 10) {
                    field("CTA (ডিফল্ট: অর্ডার করতে ইনবক্স করুন)", text: $cta)
                    field("অফার শেষ হতে দিন", text: $days).frame(width: 120)
                }
                Toggle("লোগো ওয়াটারমার্ক", isOn: $watermark).font(.system(size: 12.5)).tint(AgentPalette.coral)
                Toggle("এন্ড কার্ড (CTA)", isOn: $endCard).font(.system(size: 12.5)).tint(AgentPalette.coral)
                Button { CSHaptic.tap(); startSubmit() } label: {
                    Text("টেমপ্লেট বসাও").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(13)
                        .background(AgentPalette.coral, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }.buttonStyle(.plain)
            }
        }
        .onDisappear { cancelOperations() }
    }

    private func startSubmit() {
        guard !queueing, !working, submitTask == nil else { return }
        let templates = templatePayload()
        queueing = true // Synchronous: a second tap cannot enqueue another POST.
        let token = UUID()
        lifecycleToken = token
        submitTask = Task { @MainActor in
            await submit(templates, token: token)
        }
    }

    private func templatePayload() -> [String: AnyEncodable] {
        var templates: [String: AnyEncodable] = [:]
        if !price.trimmingCharacters(in: .whitespaces).isEmpty {
            templates["pricePop"] = AnyEncodable(["price": price.trimmingCharacters(in: .whitespaces)])
        }
        if !code.trimmingCharacters(in: .whitespaces).isEmpty {
            var lower = ["code": code.trimmingCharacters(in: .whitespaces)]
            if !name.isEmpty { lower["name"] = name }
            templates["lowerThird"] = AnyEncodable(lower)
        }
        if watermark { templates["logoWatermark"] = AnyEncodable(true) }
        if endCard {
            var card: [String: String] = [:]
            if !cta.isEmpty { card["cta"] = cta }
            if !code.isEmpty { card["code"] = code }
            if !price.isEmpty { card["price"] = price }
            templates["endCard"] = AnyEncodable(card)
        }
        if let d = Int(days), d > 0 { templates["countdown"] = AnyEncodable(["days": d]) }
        return templates
    }

    private func submit(_ templates: [String: AnyEncodable], token: UUID) async {
        defer {
            if lifecycleToken == token {
                queueing = false
                submitTask = nil
            }
        }
        guard !Task.isCancelled, lifecycleToken == token else { return }
        guard let jobId = await vm.finishVideo(item, templates: templates) else { return }
        guard !Task.isCancelled, lifecycleToken == token else { return }
        working = true
        progress = "টেমপ্লেট রেন্ডার হচ্ছে… (১–৩ মিনিট)"
        poll(jobId, token: token)
    }

    private func poll(_ jobID: String, token: UUID) {
        guard lifecycleToken == token else { return }
        pollTask?.cancel()
        pollTask = Task { @MainActor in
            // Match production's 4-second rhythm, but stop after 15 minutes.
            for _ in 0..<225 {
                do { try await Task.sleep(nanoseconds: 4_000_000_000) } catch { return }
                guard !Task.isCancelled, lifecycleToken == token else { return }
                guard let job = await vm.fetchJob(jobID) else { continue }
                guard !Task.isCancelled, lifecycleToken == token else { return }
                if let p = job.videoProgress, let step = p.step, let total = p.total {
                    progress = "ধাপ \(almaBn(step))/\(almaBn(total)): \(p.labelBn ?? "")"
                }
                if job.status == "executed" {
                    working = false
                    await vm.refreshGallery()
                    guard !Task.isCancelled, lifecycleToken == token else { return }
                    vm.flash("টেমপ্লেট বসে গেছে — \"টেমপ্লেট সহ\" ভার্সন দেখুন, Boss")
                    onDone()
                    return
                }
                if job.status == "failed" {
                    working = false
                    vm.flash(job.error ?? "টেমপ্লেট বসানো ব্যর্থ হয়েছে")
                    return
                }
            }
            guard lifecycleToken == token else { return }
            working = false
            vm.flash("Render এখনো শেষ হয়নি — Gallery থেকে status দেখুন")
        }
    }

    private func cancelOperations() {
        lifecycleToken = UUID()
        submitTask?.cancel()
        submitTask = nil
        pollTask?.cancel()
        pollTask = nil
        queueing = false
        working = false
    }

    private func field(_ placeholder: String, text: Binding<String>) -> some View {
        TextField(placeholder, text: text)
            .font(.system(size: 13)).foregroundStyle(AgentPalette(scheme).ink)
            .padding(11).background(Color.black.opacity(0.22), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.1), lineWidth: 1))
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
struct CSToastView: View {
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
extension View {
    func csGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        self
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.04 : 0.32),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.1 : 0.4), lineWidth: 1))
    }
}

/// Signed estimate → owner confirmation alert (web `StudioConfirmationDialog`). Attach to the
/// view that INITIATED the run (Create tab, Video tab, detail sheet) — SwiftUI alerts under a
/// presented sheet never show, so the initiator owns the alert.
@available(iOS 17.0, *)
extension View {
    func csEstimateAlert(vm: CreativeStudioVM) -> some View {
        alert(item: Binding(get: { vm.pendingEstimate }, set: { vm.pendingEstimate = $0 })) { estimate in
            Alert(
                title: Text("Signed estimate নিশ্চিত করুন"),
                message: Text(estimate.confirmationBody),
                primaryButton: .cancel(Text("বাতিল"), action: vm.cancelPendingRun),
                secondaryButton: .default(Text("Confirm & Run")) {
                    Task { await vm.confirmPendingRun(using: estimate) }
                }
            )
        }
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
