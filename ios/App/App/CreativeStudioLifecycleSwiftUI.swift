//
//  CreativeStudioLifecycleSwiftUI.swift
//  ALMA
//
//  Native, fail-closed access to the current Creative Studio Lifecycle contract.
//  The server remains authoritative for identity, brand role, exact pins and rollout
//  admission. This screen deliberately exposes no paid, voice, schedule or publish
//  execution path.
//

import SwiftUI
import Observation

// MARK: - Wire contracts

private enum CSLifecycleCapability: String, CaseIterable, Identifiable, Codable {
    case preview, render, export
    case dryRun = "dry_run"
    case schedule
    case livePublish = "live_publish"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .preview: "Preview"
        case .render: "Render"
        case .export: "Export"
        case .dryRun: "Dry run"
        case .schedule: "Schedule"
        case .livePublish: "Live publish"
        }
    }
    var isExecutable: Bool { self == .preview || self == .render || self == .export }
}

private enum CSLifecycleTargetRole: String, CaseIterable, Identifiable, Codable {
    case owner, creator, reviewer
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

private enum CSLifecycleJobKind: String, Identifiable {
    case render, export
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

private struct CSLifecycleComposition: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let currentVersion: Int
    let readonly: Bool
}

private struct CSLifecycleCompositionsResponse: Decodable {
    let compositions: [CSLifecycleComposition]
}

private struct CSLifecycleReviewQueueItem: Decodable, Identifiable, Equatable {
    let projectAssetId: String
    let projectId: String
    let brandProfileId: String
    let currentVersionId: String
    let expectedSequence: Int
    let state: String
    let title: String?
    let previewUrl: String?
    var id: String { projectAssetId }
}

private struct CSLifecycleReviewQueueResponse: Decodable {
    let items: [CSLifecycleReviewQueueItem]
}

private struct CSLifecycleReviewThread: Decodable, Equatable {
    struct Capabilities: Decodable, Equatable {
        let comment: Bool
        let requestChanges: Bool
        let markRevised: Bool
        let approve: Bool
    }

    struct Event: Decodable, Identifiable, Equatable {
        let id: String
        let sequence: Int
        let fromState: String?
        let toState: String
        let actorName: String
        let role: String
        let note: String?
        let approvedVersionId: String?
        let approvedCompositionId: String?
        let approvedCompositionVersionId: String?
        let createdAt: String

        private enum CodingKeys: String, CodingKey {
            case id, sequence, fromState, toState, actorName, note, approvedVersionId
            case approvedCompositionId, approvedCompositionVersionId, createdAt
            case role = "actorRole"
        }
    }

    struct Comment: Decodable, Identifiable, Equatable {
        let id: String
        let authorName: String
        let role: String
        let body: String
        let createdAt: String

        private enum CodingKeys: String, CodingKey {
            case id, authorName, body, createdAt
            case role = "authorRole"
        }
    }

    let assetId: String
    let brandProfileId: String
    let projectId: String
    let assetTitle: String?
    let currentState: String
    let currentSequence: Int
    let latestVersionId: String?
    let approvedVersionId: String?
    let approvedCompositionId: String?
    let approvedCompositionVersionId: String?
    let approvedCompositionVersion: Int?
    let approvedCompositionDocumentHash: String?
    let approvalInvalidatedReason: String?
    let publishReady: Bool
    let role: String
    let capabilities: Capabilities
    let comments: [Comment]
    let events: [Event]
}

private struct CSLifecycleReviewThreadResponse: Decodable {
    let review: CSLifecycleReviewThread
}

private struct CSLifecycleCompositionPin: Decodable, Equatable {
    let compositionId: String
    let compositionVersionId: String
    let compositionVersion: Int
    let artifactId: String
    let artifactVersionId: String
    let artifactChecksum: String
    let reviewEventId: String
    let approvedVersionId: String
    let campaignPackId: String?
    let batchId: String?
}

private struct CSLifecycleRolloutDecision: Decodable, Equatable {
    let enabled: Bool
    let legacyFallbackAvailable: Bool
    let fallbackExecution: String
    let dualReadEnabled: Bool
    let canary: String
    let matchedFlagId: String?
    let reason: String
}

private struct CSLifecycleJob: Decodable, Identifiable, Equatable {
    struct Progress: Decodable, Equatable {
        let completed: Int
        let total: Int
    }

    let id: String
    let brandProfileId: String
    let projectId: String
    let compositionId: String
    let compositionVersionId: String
    let compositionVersion: Int
    let sourceArtifactVersionId: String
    let approvedReviewEventId: String?
    let kind: String
    let effectClass: String
    let estimatedCostBdt: Double
    let paidExecutionAllowed: Bool
    let status: String
    let progress: Progress
    let resultArtifactVersionId: String?
    let verifiedAt: String?
    let lastErrorCode: String?
    let createdAt: String
    let updatedAt: String
}

private struct CSLifecycleWorkspace: Decodable, Equatable {
    struct Execution: Decodable, Equatable {
        let paidRender: Bool
        let voiceProvider: Bool
        let externalPublish: Bool
        let localWorkerFlagEnabled: Bool
        let legacyFallbackAvailable: Bool
        let legacyFallbackExecution: String
    }

    struct Operations: Decodable, Equatable {
        let queuedJobs: Int?
        let oldestJobAgeMinutes: Int?
        let providerHealth: String
        let providerBalanceBdt: Double?
        let workerHealth: String
        let workerHeartbeatAgeMinutes: Int?
        let artifactsPendingVerification: Int?
        let missingSignals: [String]
    }

    let jobs: [CSLifecycleJob]
    let operations: Operations
    let execution: Execution
    let rollouts: [String: CSLifecycleRolloutDecision]
    let pin: CSLifecycleCompositionPin?
}

private struct CSLifecyclePreview: Decodable, Equatable {
    let mode: String
    let externalEffect: Bool
    let jobKind: String
    let effectClass: String
    let estimatedCostBdt: Double
    let renderProfile: String
    let outputFormat: String
    let rendererVersion: String
    let paidExecutionAllowed: Bool
    let compositionId: String
    let compositionVersionId: String
    let compositionVersion: Int
    let compositionDocumentHash: String
    let sourceArtifactVersionId: String
    let approvedReviewEventId: String?
    let reviewFingerprint: String?
    let renderFingerprint: String
}

private struct CSLifecyclePreviewResponse: Decodable {
    let preview: CSLifecyclePreview
}

private struct CSLifecycleJobResponse: Decodable {
    let job: CSLifecycleJob
    let idempotent: Bool
}

private struct CSLifecycleFlag: Decodable, Identifiable, Equatable {
    struct Execution: Decodable, Equatable {
        let configOnly: Bool
        let paidRenderAllowed: Bool
        let voiceProviderAllowed: Bool
        let externalPublishAllowed: Bool
    }

    let id: String
    let brandProfileId: String
    let projectId: String
    let role: String
    let capability: String
    let enabled: Bool
    let dualReadEnabled: Bool
    let legacyFallbackAvailable: Bool
    let fallbackExecution: String
    let canaryPercent: Int
    let execution: Execution
}

private struct CSLifecycleFlagsResponse: Decodable {
    struct Execution: Decodable {
        let configOnly: Bool
        let paidRenderAllowed: Bool
        let voiceProviderAllowed: Bool
        let externalPublishAllowed: Bool
    }

    let flags: [CSLifecycleFlag]
    let execution: Execution
}

private struct CSLifecycleFlagResponse: Decodable {
    let flag: CSLifecycleFlag
    let idempotent: Bool
}

private enum CSLifecycleInvariantError: LocalizedError {
    case violated(String)
    var errorDescription: String? {
        switch self {
        case .violated(let detail): "Lifecycle safety check failed: \(detail)"
        }
    }
}

// MARK: - Model

@available(iOS 17.0, *)
@Observable
private final class CSLifecycleControlModel {
    let brandID: String
    let projectID: String
    let role: String

    var compositions: [CSLifecycleComposition] = []
    var reviewItems: [CSLifecycleReviewQueueItem] = []
    var selectedAssetID: String?
    var selectedCompositionID: String?
    var review: CSLifecycleReviewThread?
    var pin: CSLifecycleCompositionPin?
    var workspace: CSLifecycleWorkspace?
    var preview: CSLifecyclePreview?
    var flags: [CSLifecycleFlag] = []
    var targetRole: CSLifecycleTargetRole = .owner
    var capability: CSLifecycleCapability = .preview
    var note = ""
    var commentDraft = ""
    var loading = false
    var busy: String?
    var error: String?
    var notice: String?

    private let seededReviewAssetID: String?
    private let seededReviewVersionID: String?
    @ObservationIgnored private var selectionRevision = 0
    @ObservationIgnored private var rolloutRevision = 0

    init(
        brandID: String,
        projectID: String,
        role: String,
        selectedReviewAssetID: String?,
        selectedReviewVersionID: String?
    ) {
        self.brandID = brandID
        self.projectID = projectID
        self.role = role.lowercased()
        seededReviewAssetID = selectedReviewAssetID
        seededReviewVersionID = selectedReviewVersionID
        selectedAssetID = selectedReviewAssetID
        targetRole = CSLifecycleTargetRole(rawValue: role.lowercased()) ?? .owner
    }

    var owner: Bool { (review?.role ?? role) == "owner" }
    var selectedItem: CSLifecycleReviewQueueItem? {
        reviewItems.first(where: { $0.id == selectedAssetID })
    }
    var selectedFlag: CSLifecycleFlag? { flags.first }
    var canPreviewLocal: Bool {
        owner && rolloutEnabled(.preview) && exactPinnedRequest() != nil
    }
    var canQueueRender: Bool {
        owner && rolloutEnabled(.render) && exactPinnedRequest() != nil
    }
    var canQueueExport: Bool {
        owner && rolloutEnabled(.export) && exactPinnedRequest() != nil
    }

    func load() async {
        selectionRevision += 1
        rolloutRevision += 1
        let loadRevision = selectionRevision
        loading = true
        error = nil
        defer { loading = false }
        do {
            async let compositionRequest: CSLifecycleCompositionsResponse = AlmaAPI.shared.get(
                "/api/assistant/creative-studio/compositions",
                query: ["brandProfileId": brandID, "projectId": projectID]
            )
            async let reviewRequest: CSLifecycleReviewQueueResponse = AlmaAPI.shared.get(
                "/api/assistant/creative-studio/reviews",
                query: [
                    "brandProfileId": brandID,
                    "projectId": projectID,
                    "includeApproved": "true",
                ]
            )
            async let workspaceRequest: CSLifecycleWorkspace = AlmaAPI.shared.get(
                "/api/assistant/creative-studio/lifecycle",
                query: ["brandProfileId": brandID, "projectId": projectID]
            )
            let (compositionResult, reviewResult, workspaceResult) = try await (
                compositionRequest, reviewRequest, workspaceRequest
            )
            guard loadRevision == selectionRevision else { return }
            try validateWorkspace(workspaceResult)
            compositions = compositionResult.compositions
            reviewItems = reviewResult.items.filter {
                $0.brandProfileId == brandID && $0.projectId == projectID
            }
            workspace = workspaceResult

            let seeded = reviewItems.first { item in
                item.id == seededReviewAssetID
                    && (seededReviewVersionID == nil || item.currentVersionId == seededReviewVersionID)
            }
            selectedAssetID = seeded?.id
                ?? reviewItems.first(where: { $0.id == selectedAssetID })?.id
                ?? reviewItems.first?.id
            await loadSelectedReview()
            if owner { await loadFlags() }
        } catch {
            self.error = message(error, fallback: "Lifecycle workspace লোড হয়নি")
        }
    }

    func selectReview(_ assetID: String) async {
        guard busy == nil else { return }
        selectionRevision += 1
        selectedAssetID = assetID
        selectedCompositionID = nil
        review = nil
        pin = nil
        preview = nil
        await loadSelectedReview()
    }

    func selectComposition(_ compositionID: String) async {
        guard busy == nil else { return }
        selectionRevision += 1
        selectedCompositionID = compositionID
        pin = nil
        preview = nil
        await resolvePin()
    }

    func loadSelectedReview() async {
        guard let item = selectedItem else {
            review = nil
            pin = nil
            return
        }
        let revision = selectionRevision
        let assetID = item.projectAssetId
        error = nil
        do {
            let response: CSLifecycleReviewThreadResponse = try await AlmaAPI.shared.get(
                "/api/assistant/creative-studio/reviews",
                query: ["assetId": assetID, "brandProfileId": brandID]
            )
            guard revision == selectionRevision, selectedAssetID == assetID else { return }
            guard response.review.assetId == assetID,
                  response.review.brandProfileId == brandID,
                  response.review.projectId == projectID,
                  response.review.latestVersionId == item.currentVersionId else {
                throw CSLifecycleInvariantError.violated("review scope mismatch")
            }
            review = response.review
            let preferredComposition = response.review.approvedCompositionId
            selectedCompositionID = compositions.first(where: { $0.id == preferredComposition })?.id
                ?? compositions.first(where: { $0.id == selectedCompositionID })?.id
                ?? compositions.first?.id
            await resolvePin(expectedRevision: revision)
        } catch {
            guard revision == selectionRevision else { return }
            self.error = message(error, fallback: "Exact review thread লোড হয়নি")
        }
    }

    func resolvePin(expectedRevision: Int? = nil) async {
        guard let item = selectedItem, let compositionID = selectedCompositionID else {
            pin = nil
            return
        }
        let revision = expectedRevision ?? selectionRevision
        let assetID = item.id
        let artifactVersionID = item.currentVersionId
        error = nil
        do {
            let response: CSLifecycleWorkspace = try await AlmaAPI.shared.get(
                "/api/assistant/creative-studio/lifecycle",
                query: [
                    "brandProfileId": brandID,
                    "projectId": projectID,
                    "compositionId": compositionID,
                    "artifactVersionId": artifactVersionID,
                ]
            )
            guard revision == selectionRevision,
                  selectedAssetID == assetID,
                  selectedCompositionID == compositionID else { return }
            try validateWorkspace(response)
            guard let resolved = response.pin,
                  resolved.compositionId == compositionID,
                  resolved.artifactVersionId == artifactVersionID,
                  resolved.artifactId == assetID else {
                throw CSLifecycleInvariantError.violated("exact composition/artifact pin unavailable")
            }
            pin = resolved
            workspace = response
        } catch {
            guard revision == selectionRevision else { return }
            pin = nil
            self.error = message(error, fallback: "এই composition-এ exact asset version নেই")
        }
    }

    func transition(to target: String) async {
        guard busy == nil, let item = selectedItem, let thread = review else { return }
        let permitted: Bool
        switch target {
        case "approved": permitted = thread.capabilities.approve
        case "changes_requested": permitted = thread.capabilities.requestChanges
        case "revised": permitted = thread.capabilities.markRevised
        default: permitted = false
        }
        guard permitted else {
            error = "Authenticated \(thread.role.capitalized) role এই review action করতে পারে না।"
            return
        }
        let cleanNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        if target == "changes_requested" && cleanNote.isEmpty {
            error = "Change request-এর জন্য নির্দিষ্ট note লিখুন।"
            return
        }
        let approvalPin: CSLifecycleCompositionPin?
        if target == "approved" {
            guard let exactPin = pin,
                  exactPin.artifactId == item.projectAssetId,
                  exactPin.artifactVersionId == item.currentVersionId,
                  exactPin.compositionId == selectedCompositionID else {
                error = "Server-validated composition/version pin ছাড়া approval করা যাবে না।"
                return
            }
            approvalPin = exactPin
        } else {
            approvalPin = nil
        }

        struct Body: Encodable {
            let brandProfileId: String
            let targetState: String
            let expectedSequence: Int
            let note: String?
            let compositionId: String?
            let compositionVersionId: String?
        }

        let revision = selectionRevision
        let assetID = item.projectAssetId
        let artifactVersionID = item.currentVersionId
        let compositionID = selectedCompositionID
        let operation = "review:\(target):\(assetID)"
        let route = thread.role == "owner"
            ? "/api/assistant/creative-studio/lifecycle/review/\(assetID)"
            : "/api/assistant/creative-studio/assets/\(assetID)/state"
        busy = operation
        error = nil
        defer { if busy == operation { busy = nil } }
        do {
            let response: CSLifecycleReviewThreadResponse = try await AlmaAPI.shared.send(
                "PATCH",
                route,
                body: Body(
                    brandProfileId: brandID,
                    targetState: target,
                    expectedSequence: thread.currentSequence,
                    note: cleanNote.isEmpty ? nil : cleanNote,
                    compositionId: target == "approved" ? approvalPin?.compositionId : nil,
                    compositionVersionId: target == "approved" ? approvalPin?.compositionVersionId : nil
                )
            )
            guard revision == selectionRevision,
                  selectedAssetID == assetID,
                  selectedCompositionID == compositionID,
                  selectedItem?.currentVersionId == artifactVersionID else { return }
            guard response.review.assetId == assetID,
                  response.review.brandProfileId == brandID,
                  response.review.projectId == projectID,
                  response.review.latestVersionId == artifactVersionID else {
                throw CSLifecycleInvariantError.violated("review mutation crossed scope")
            }
            review = response.review
            if let index = reviewItems.firstIndex(where: { $0.id == assetID }) {
                let prior = reviewItems[index]
                reviewItems[index] = CSLifecycleReviewQueueItem(
                    projectAssetId: prior.projectAssetId,
                    projectId: prior.projectId,
                    brandProfileId: prior.brandProfileId,
                    currentVersionId: prior.currentVersionId,
                    expectedSequence: response.review.currentSequence,
                    state: response.review.currentState,
                    title: prior.title,
                    previewUrl: prior.previewUrl
                )
            }
            note = ""
            preview = nil
            await resolvePin(expectedRevision: revision)
            notice = target == "approved" ? "Exact pin approved" : "Review state আপডেট হয়েছে"
        } catch {
            guard revision == selectionRevision,
                  selectedAssetID == assetID,
                  selectedCompositionID == compositionID else { return }
            self.error = message(error, fallback: "Review আপডেট হয়নি")
        }
    }

    func addComment() async {
        guard busy == nil, let item = selectedItem, let thread = review else { return }
        guard thread.capabilities.comment else {
            error = "Authenticated \(thread.role.capitalized) role comment করতে পারে না।"
            return
        }
        let cleanComment = commentDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanComment.isEmpty else {
            error = "Comment লিখুন।"
            return
        }
        struct Body: Encodable {
            let intent = "comment"
            let assetId: String
            let brandProfileId: String
            let comment: String
        }

        let revision = selectionRevision
        let assetID = item.projectAssetId
        let artifactVersionID = item.currentVersionId
        let operation = "comment:\(assetID)"
        busy = operation
        error = nil
        defer { if busy == operation { busy = nil } }
        do {
            let response: CSLifecycleReviewThreadResponse = try await AlmaAPI.shared.send(
                "POST",
                "/api/assistant/creative-studio/reviews",
                body: Body(
                    assetId: assetID,
                    brandProfileId: brandID,
                    comment: cleanComment
                )
            )
            guard revision == selectionRevision,
                  selectedAssetID == assetID,
                  selectedItem?.currentVersionId == artifactVersionID else { return }
            guard response.review.assetId == assetID,
                  response.review.brandProfileId == brandID,
                  response.review.projectId == projectID,
                  response.review.latestVersionId == artifactVersionID else {
                throw CSLifecycleInvariantError.violated("review comment crossed scope")
            }
            review = response.review
            commentDraft = ""
            notice = "Review comment added"
        } catch {
            guard revision == selectionRevision, selectedAssetID == assetID else { return }
            self.error = message(error, fallback: "Review comment যোগ হয়নি")
        }
    }

    func previewLocalRender() async {
        guard requireOwner(), rolloutEnabled(.preview), let request = exactPinnedRequest() else {
            if error == nil { error = "Current approved pin এবং Preview rollout দরকার।" }
            return
        }
        struct Body: Encodable {
            let intent = "preview"
            let brandProfileId: String
            let projectId: String
            let compositionId: String
            let compositionVersionId: String
            let sourceArtifactVersionId: String
            let approvedReviewEventId: String
            let operationBatchId: String?
            let kind = "render"
            let renderProfile = "composition-manifest-v1"
            let outputFormat = "json"
            let rendererVersion = "composition-manifest-v1"
            let effectClass = "zero_cost_local"
            let estimatedCostBdt = 0
        }

        busy = "preview"
        error = nil
        defer { busy = nil }
        do {
            let response: CSLifecyclePreviewResponse = try await AlmaAPI.shared.send(
                "POST",
                "/api/assistant/creative-studio/lifecycle",
                body: Body(
                    brandProfileId: brandID,
                    projectId: projectID,
                    compositionId: request.compositionId,
                    compositionVersionId: request.compositionVersionId,
                    sourceArtifactVersionId: request.sourceArtifactVersionId,
                    approvedReviewEventId: request.approvedReviewEventId,
                    operationBatchId: request.operationBatchId
                )
            )
            try validateZeroCostPreview(response.preview, request: request)
            preview = response.preview
            notice = "Free server preview complete — কোনো job তৈরি হয়নি"
        } catch {
            preview = nil
            self.error = message(error, fallback: "Lifecycle preview হয়নি")
        }
    }

    func queueLocal(_ kind: CSLifecycleJobKind) async {
        let gate: CSLifecycleCapability = kind == .render ? .render : .export
        guard requireOwner(), rolloutEnabled(gate), let request = exactPinnedRequest() else {
            if error == nil { error = "Current approved pin এবং \(gate.title) rollout দরকার।" }
            return
        }
        struct Body: Encodable {
            let intent = "queue"
            let idempotencyKey: String
            let brandProfileId: String
            let projectId: String
            let compositionId: String
            let compositionVersionId: String
            let sourceArtifactVersionId: String
            let approvedReviewEventId: String
            let operationBatchId: String?
            let kind: String
            let renderProfile = "composition-manifest-v1"
            let outputFormat = "json"
            let rendererVersion = "composition-manifest-v1"
            let effectClass = "zero_cost_local"
            let estimatedCostBdt = 0
        }

        busy = "queue:\(kind.rawValue)"
        error = nil
        defer { busy = nil }
        do {
            let response: CSLifecycleJobResponse = try await AlmaAPI.shared.send(
                "POST",
                "/api/assistant/creative-studio/lifecycle",
                body: Body(
                    idempotencyKey: "ios-lifecycle:\(kind.rawValue):\(UUID().uuidString)",
                    brandProfileId: brandID,
                    projectId: projectID,
                    compositionId: request.compositionId,
                    compositionVersionId: request.compositionVersionId,
                    sourceArtifactVersionId: request.sourceArtifactVersionId,
                    approvedReviewEventId: request.approvedReviewEventId,
                    operationBatchId: request.operationBatchId,
                    kind: kind.rawValue
                )
            )
            try validateZeroCostJob(response.job, kind: kind, request: request)
            await resolvePin()
            notice = response.idempotent
                ? "Existing exact \(kind.rawValue) job দেখানো হয়েছে"
                : "৳0 local \(kind.rawValue) queued"
        } catch {
            self.error = message(error, fallback: "Local \(kind.rawValue) queue হয়নি")
        }
    }

    func control(_ job: CSLifecycleJob, intent: String) async {
        guard requireOwner() else { return }
        guard job.brandProfileId == brandID, job.projectId == projectID else {
            error = "Cross-scope job control blocked."
            return
        }
        guard (intent == "cancel" && ["queued", "running"].contains(job.status))
                || (intent == "retry" && job.status == "failed") else {
            error = "এই job state-এ \(intent) allowed নয়।"
            return
        }
        struct Body: Encodable { let intent: String; let idempotencyKey: String }
        busy = "\(intent):\(job.id)"
        error = nil
        defer { busy = nil }
        do {
            let response: CSLifecycleJobResponse = try await AlmaAPI.shared.send(
                "PATCH",
                "/api/assistant/creative-studio/lifecycle/\(job.id)",
                body: Body(
                    intent: intent,
                    idempotencyKey: "ios-lifecycle:\(intent):\(UUID().uuidString)"
                )
            )
            guard response.job.id == job.id,
                  response.job.brandProfileId == brandID,
                  response.job.projectId == projectID else {
                throw CSLifecycleInvariantError.violated("job control response scope mismatch")
            }
            await reloadWorkspace()
            notice = intent == "cancel" ? "Cancel outcome refreshed" : "Retry queued"
        } catch {
            self.error = message(error, fallback: "Lifecycle job update হয়নি")
        }
    }

    func loadFlags() async {
        guard owner else {
            flags = []
            return
        }
        let revision = rolloutRevision
        let requestedRole = targetRole
        let requestedCapability = capability
        do {
            let response: CSLifecycleFlagsResponse = try await AlmaAPI.shared.get(
                "/api/assistant/creative-studio/lifecycle/flags",
                query: [
                    "brandProfileId": brandID,
                    "projectId": projectID,
                    "role": requestedRole.rawValue,
                    "capability": requestedCapability.rawValue,
                ]
            )
            guard revision == rolloutRevision,
                  targetRole == requestedRole,
                  capability == requestedCapability else { return }
            try validateFlags(response, role: requestedRole, capability: requestedCapability)
            flags = response.flags
        } catch {
            guard revision == rolloutRevision,
                  targetRole == requestedRole,
                  capability == requestedCapability else { return }
            flags = []
            self.error = message(error, fallback: "Exact rollout flag লোড হয়নি")
        }
    }

    func selectTargetRole(_ value: CSLifecycleTargetRole) {
        guard busy == nil, targetRole != value else { return }
        rolloutRevision += 1
        targetRole = value
        flags = []
    }

    func selectCapability(_ value: CSLifecycleCapability) {
        guard busy == nil, capability != value else { return }
        rolloutRevision += 1
        capability = value
        flags = []
    }

    func toggleFlag() async {
        guard busy == nil, requireOwner() else { return }
        let enabling = selectedFlag?.enabled != true
        if capability == .livePublish && enabling {
            error = "Live publish এই zero-cost client থেকে enable করা যায় না।"
            return
        }
        struct Body: Encodable {
            let brandProfileId: String
            let projectId: String
            let role: String
            let capability: String
            let enabled: Bool
            let canaryPercent: Int
            let dualReadEnabled: Bool
            let legacyFallbackEnabled: Bool
            let idempotencyKey: String
        }
        let revision = rolloutRevision
        let requestedRole = targetRole
        let requestedCapability = capability
        let requestedFlagID = selectedFlag?.id
        let operation = "flag:\(requestedRole.rawValue):\(requestedCapability.rawValue)"
        busy = operation
        error = nil
        defer { if busy == operation { busy = nil } }
        do {
            let response: CSLifecycleFlagResponse = try await AlmaAPI.shared.send(
                "PUT",
                "/api/assistant/creative-studio/lifecycle/flags",
                body: Body(
                    brandProfileId: brandID,
                    projectId: projectID,
                    role: requestedRole.rawValue,
                    capability: requestedCapability.rawValue,
                    enabled: enabling,
                    canaryPercent: enabling ? 100 : 0,
                    dualReadEnabled: false,
                    legacyFallbackEnabled: true,
                    idempotencyKey: "ios-lifecycle:flag:\(UUID().uuidString)"
                )
            )
            try validateFlag(response.flag, role: requestedRole, capability: requestedCapability)
            guard revision == rolloutRevision,
                  targetRole == requestedRole,
                  capability == requestedCapability,
                  selectedFlag?.id == requestedFlagID else { return }
            flags = [response.flag]
            await reloadWorkspace()
            notice = response.idempotent ? "Existing rollout config retained" : "Exact rollout config saved"
        } catch {
            guard revision == rolloutRevision,
                  targetRole == requestedRole,
                  capability == requestedCapability else { return }
            self.error = message(error, fallback: "Rollout flag update হয়নি")
        }
    }

    private struct PinnedRequest {
        let compositionId: String
        let compositionVersionId: String
        let sourceArtifactVersionId: String
        let approvedReviewEventId: String
        let operationBatchId: String?
    }

    private func exactPinnedRequest() -> PinnedRequest? {
        guard let thread = review,
              thread.publishReady,
              thread.approvalInvalidatedReason == nil,
              let resolved = pin,
              thread.latestVersionId == resolved.artifactVersionId,
              thread.approvedVersionId == resolved.artifactVersionId,
              thread.approvedCompositionId == resolved.compositionId,
              thread.approvedCompositionVersionId == resolved.compositionVersionId,
              resolved.approvedVersionId == resolved.artifactVersionId,
              let approval = thread.events.reversed().first(where: {
                  $0.toState == "approved"
                      && $0.approvedVersionId == thread.latestVersionId
                      && $0.approvedCompositionId == thread.approvedCompositionId
                      && $0.approvedCompositionVersionId == thread.approvedCompositionVersionId
              }),
              approval.id == resolved.reviewEventId else { return nil }
        return PinnedRequest(
            compositionId: resolved.compositionId,
            compositionVersionId: resolved.compositionVersionId,
            sourceArtifactVersionId: resolved.artifactVersionId,
            approvedReviewEventId: approval.id,
            operationBatchId: resolved.batchId
        )
    }

    private func rolloutEnabled(_ value: CSLifecycleCapability) -> Bool {
        value != .livePublish && workspace?.rollouts[value.rawValue]?.enabled == true
    }

    private func reloadWorkspace() async {
        do {
            let response: CSLifecycleWorkspace = try await AlmaAPI.shared.get(
                "/api/assistant/creative-studio/lifecycle",
                query: ["brandProfileId": brandID, "projectId": projectID]
            )
            try validateWorkspace(response)
            workspace = response
            if selectedCompositionID != nil { await resolvePin() }
        } catch {
            self.error = message(error, fallback: "Lifecycle workspace refresh হয়নি")
        }
    }

    private func requireOwner() -> Bool {
        guard owner else {
            error = "Lifecycle mutations শুধু authenticated Brand Owner করতে পারেন।"
            return false
        }
        return true
    }

    private func validateWorkspace(_ value: CSLifecycleWorkspace) throws {
        guard !value.execution.paidRender,
              !value.execution.voiceProvider,
              !value.execution.externalPublish else {
            throw CSLifecycleInvariantError.violated("hard-off execution truth changed")
        }
        guard CSLifecycleCapability.allCases.allSatisfy({
            value.rollouts[$0.rawValue] != nil
        }) else {
            throw CSLifecycleInvariantError.violated("one or more rollout decisions are missing")
        }
        guard value.jobs.allSatisfy({
            $0.brandProfileId == brandID && $0.projectId == projectID
        }) else {
            throw CSLifecycleInvariantError.violated("workspace job crossed brand/project scope")
        }
    }

    private func validateZeroCostPreview(_ value: CSLifecyclePreview, request: PinnedRequest) throws {
        guard value.mode == "preview",
              !value.externalEffect,
              value.jobKind == "render",
              value.effectClass == "zero_cost_local",
              value.estimatedCostBdt == 0,
              !value.paidExecutionAllowed,
              value.renderProfile == "composition-manifest-v1",
              value.outputFormat == "json",
              value.rendererVersion == "composition-manifest-v1",
              value.compositionId == request.compositionId,
              value.compositionVersionId == request.compositionVersionId,
              value.sourceArtifactVersionId == request.sourceArtifactVersionId,
              value.approvedReviewEventId == request.approvedReviewEventId else {
            throw CSLifecycleInvariantError.violated("unsafe or mismatched preview receipt")
        }
    }

    private func validateZeroCostJob(
        _ value: CSLifecycleJob,
        kind: CSLifecycleJobKind,
        request: PinnedRequest
    ) throws {
        guard value.brandProfileId == brandID,
              value.projectId == projectID,
              value.compositionId == request.compositionId,
              value.compositionVersionId == request.compositionVersionId,
              value.sourceArtifactVersionId == request.sourceArtifactVersionId,
              value.approvedReviewEventId == request.approvedReviewEventId,
              value.kind == kind.rawValue,
              value.effectClass == "zero_cost_local",
              value.estimatedCostBdt == 0,
              !value.paidExecutionAllowed else {
            throw CSLifecycleInvariantError.violated("unsafe or mismatched queue receipt")
        }
    }

    private func validateFlags(
        _ response: CSLifecycleFlagsResponse,
        role: CSLifecycleTargetRole,
        capability: CSLifecycleCapability
    ) throws {
        guard response.execution.configOnly,
              !response.execution.paidRenderAllowed,
              !response.execution.voiceProviderAllowed,
              !response.execution.externalPublishAllowed else {
            throw CSLifecycleInvariantError.violated("flag endpoint exposed execution")
        }
        try response.flags.forEach { try validateFlag($0, role: role, capability: capability) }
    }

    private func validateFlag(
        _ flag: CSLifecycleFlag,
        role: CSLifecycleTargetRole,
        capability: CSLifecycleCapability
    ) throws {
        guard flag.brandProfileId == brandID,
              flag.projectId == projectID,
              flag.role == role.rawValue,
              flag.capability == capability.rawValue,
              flag.execution.configOnly,
              !flag.execution.paidRenderAllowed,
              !flag.execution.voiceProviderAllowed,
              !flag.execution.externalPublishAllowed,
              flag.canaryPercent >= 0,
              flag.canaryPercent <= 100 else {
            throw CSLifecycleInvariantError.violated("rollout flag scope or safety mismatch")
        }
    }

    private func message(_ error: Error, fallback: String) -> String {
        if let invariant = error as? CSLifecycleInvariantError {
            return invariant.localizedDescription
        }
        if let apiError = error as? AlmaAPIError {
            switch apiError {
            case .http(_, let body): return CS.serverMessage(body) ?? fallback
            case .notAuthenticated: return "সেশন শেষ — আবার লগইন করুন"
            default: break
            }
        }
        return error.localizedDescription.isEmpty ? fallback : error.localizedDescription
    }
}

// MARK: - Native screen

@available(iOS 17.0, *)
struct CSV4LifecycleControlScreen: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dismiss) private var dismiss
    @State private var model: CSLifecycleControlModel
    @State private var pendingQueue: CSLifecycleJobKind?
    @State private var pendingCancel: CSLifecycleJob?

    init(
        brandID: String,
        projectID: String,
        role: String,
        selectedReviewAssetID: String? = nil,
        selectedReviewVersionID: String? = nil
    ) {
        _model = State(initialValue: CSLifecycleControlModel(
            brandID: brandID,
            projectID: projectID,
            role: role,
            selectedReviewAssetID: selectedReviewAssetID,
            selectedReviewVersionID: selectedReviewVersionID
        ))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AgentPalette(scheme).bg0.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        safetyCard
                        reviewCard
                        rolloutCard
                        jobsCard
                        Color.clear.frame(height: 24)
                    }
                    .padding(16)
                }
                .refreshable { await model.load() }
                if model.loading {
                    ProgressView("Lifecycle লোড হচ্ছে…")
                        .padding(18)
                        .csv4LifecycleGlass(scheme)
                }
            }
            .navigationTitle("Lifecycle Control")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await model.load() } } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(model.loading || model.busy != nil)
                }
            }
        }
        .task { await model.load() }
        .alert("৳0 local job queue করবেন?", isPresented: Binding(
            get: { pendingQueue != nil },
            set: { if !$0 { pendingQueue = nil } }
        )) {
            Button("বাতিল", role: .cancel) { pendingQueue = nil }
            Button("Confirm & Queue") {
                if let kind = pendingQueue {
                    pendingQueue = nil
                    Task { await model.queueLocal(kind) }
                }
            }
        } message: {
            Text("Exact approved composition/version pin দিয়ে local JSON manifest queue হবে। Cost ৳0; paid বা external execution নেই।")
        }
        .alert("Lifecycle job cancel করবেন?", isPresented: Binding(
            get: { pendingCancel != nil },
            set: { if !$0 { pendingCancel = nil } }
        )) {
            Button("বাতিল", role: .cancel) { pendingCancel = nil }
            Button("Cancel job", role: .destructive) {
                if let job = pendingCancel {
                    pendingCancel = nil
                    Task { await model.control(job, intent: "cancel") }
                }
            }
        } message: {
            Text("Running job-এর outcome ambiguous হলে server সেটিকে needs review হিসেবে quarantine করবে।")
        }
        .overlay(alignment: .top) {
            if let notice = model.notice {
                Text(notice)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(.black.opacity(0.8), in: Capsule())
                    .padding(.top, 8)
                    .task {
                        try? await Task.sleep(for: .seconds(3))
                        if model.notice == notice { model.notice = nil }
                    }
            }
        }
    }

    private var safetyCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Safety boundary", icon: "lock.shield.fill")
            Text("Brand \(model.brandID) · Project \(model.projectID) · \(model.role.capitalized)")
                .font(.caption)
                .foregroundStyle(AgentPalette(scheme).muted)
                .textSelection(.enabled)
            if let execution = model.workspace?.execution {
                HStack(spacing: 8) {
                    safetyPill("Paid", safe: !execution.paidRender)
                    safetyPill("Voice", safe: !execution.voiceProvider)
                    safetyPill("Publish", safe: !execution.externalPublish)
                    safetyPill("Worker flag", safe: execution.localWorkerFlagEnabled)
                }
                Text("Worker flag application admission মাত্র; heartbeat: \(model.workspace?.operations.workerHealth ?? "unknown").")
                    .font(.caption2)
                    .foregroundStyle(AgentPalette(scheme).muted)
            } else {
                Text("Server execution truth এখনো লোড হয়নি।")
                    .font(.caption)
                    .foregroundStyle(AgentPalette(scheme).muted)
            }
            if !model.owner {
                Label("Review actions server role অনুযায়ী; queue, job control ও rollout mutation Owner-only", systemImage: "person.badge.shield.checkmark.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
            }
            if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
            }
        }
        .padding(14)
        .csv4LifecycleGlass(scheme)
    }

    private var reviewCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Exact review & pin", icon: "checkmark.seal.fill")
            if model.reviewItems.isEmpty {
                empty("এই project-এ versioned review item নেই")
            } else {
                Picker("Review asset", selection: Binding(
                    get: { model.selectedAssetID ?? "" },
                    set: { value in Task { await model.selectReview(value) } }
                )) {
                    ForEach(model.reviewItems) { item in
                        Text("\(item.title ?? "Untitled") · \(item.state.replacingOccurrences(of: "_", with: " "))")
                            .tag(item.id)
                    }
                }
                .pickerStyle(.menu)
                .disabled(model.loading || model.busy != nil)

                if model.compositions.isEmpty {
                    empty("Exact pin resolve করার জন্য composition নেই")
                } else {
                    Picker("Canonical composition", selection: Binding(
                        get: { model.selectedCompositionID ?? "" },
                        set: { value in Task { await model.selectComposition(value) } }
                    )) {
                        ForEach(model.compositions) { composition in
                            Text("\(composition.title) · v\(composition.currentVersion)")
                                .tag(composition.id)
                        }
                    }
                    .pickerStyle(.menu)
                    .disabled(model.loading || model.busy != nil)
                }

                if let item = model.selectedItem,
                   let rawPreview = item.previewUrl,
                   let previewURL = URL(string: rawPreview) {
                    AsyncImage(url: previewURL) { image in
                        image.resizable().scaledToFit()
                    } placeholder: {
                        ProgressView().frame(maxWidth: .infinity).frame(height: 180)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(maxHeight: 300)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                if let review = model.review {
                    fact("Review", review.currentState.replacingOccurrences(of: "_", with: " ").capitalized)
                    fact("Sequence", String(review.currentSequence))
                    fact("Publish ready", review.publishReady && review.approvalInvalidatedReason == nil ? "Exact pin current" : "No")
                    fact("Invalidation", review.approvalInvalidatedReason ?? "None")
                }
                if let pin = model.pin {
                    fact("Composition version", "v\(pin.compositionVersion) · \(pin.compositionVersionId)")
                    fact("Artifact version", pin.artifactVersionId)
                    fact("Approval event", pin.reviewEventId.isEmpty ? "Not approved on this pin" : pin.reviewEventId)
                } else {
                    Label("Exact composition/artifact pin not validated", systemImage: "pin.slash")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                TextField("Review note · required when requesting changes", text: $model.note, axis: .vertical)
                    .lineLimit(2...5)
                    .textFieldStyle(.roundedBorder)
                    .disabled(
                        model.busy != nil
                            || !(model.review?.capabilities.requestChanges == true
                                || model.review?.capabilities.markRevised == true
                                || model.review?.capabilities.approve == true)
                    )

                reviewActions
                if let review = model.review {
                    reviewDiscussion(review)
                }

                Divider().opacity(0.25)
                HStack {
                    Button {
                        Task { await model.previewLocalRender() }
                    } label: {
                        Label("Free local preview", systemImage: "doc.text.magnifyingglass")
                    }
                    .buttonStyle(.bordered)
                    .disabled(!model.canPreviewLocal || model.busy != nil)
                    Spacer()
                    Button("Queue render") { pendingQueue = .render }
                        .buttonStyle(.borderedProminent)
                        .tint(AgentPalette.coral)
                        .disabled(!model.canQueueRender || model.busy != nil)
                    Button("Queue export") { pendingQueue = .export }
                        .buttonStyle(.borderedProminent)
                        .tint(.green)
                        .disabled(!model.canQueueExport || model.busy != nil)
                }
                .font(.caption.weight(.semibold))

                if let preview = model.preview {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("Server preview only · no job created · ৳0", systemImage: "checkmark.shield.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.green)
                        Text("\(preview.compositionVersionId) · \(preview.sourceArtifactVersionId)")
                        Text("Fingerprint \(preview.renderFingerprint)")
                    }
                    .font(.caption2.monospaced())
                    .foregroundStyle(AgentPalette(scheme).muted)
                    .textSelection(.enabled)
                }
            }
        }
        .padding(14)
        .csv4LifecycleGlass(scheme)
    }

    @ViewBuilder
    private var reviewActions: some View {
        if let review = model.review {
            HStack {
                if review.currentState == "draft" || review.currentState == "revised" {
                    if review.capabilities.requestChanges {
                        Button(review.role == "owner" ? "Reject / request changes" : "Request changes") {
                            Task { await model.transition(to: "changes_requested") }
                        }
                        .buttonStyle(.bordered)
                        .tint(.orange)
                        .disabled(
                            model.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                                || model.busy != nil
                        )
                    }
                    if review.capabilities.approve {
                        Button("Approve exact pin") {
                            Task { await model.transition(to: "approved") }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.green)
                        .disabled(model.pin == nil || model.busy != nil)
                    }
                } else if (review.currentState == "changes_requested" || review.currentState == "approved")
                            && review.capabilities.markRevised {
                    Button("Mark revised") {
                        Task { await model.transition(to: "revised") }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(AgentPalette.coral)
                    .disabled(model.busy != nil)
                }
            }
            .font(.caption.weight(.semibold))
        }
    }

    private func reviewDiscussion(_ review: CSLifecycleReviewThread) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider().opacity(0.25)
            Text("Comments")
                .font(.caption.weight(.bold))
            if review.comments.isEmpty {
                empty("No review comments yet")
            } else {
                ForEach(review.comments) { comment in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text("\(comment.authorName) · \(comment.role.capitalized)")
                                .font(.caption2.weight(.bold))
                            Spacer()
                            Text(comment.createdAt)
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(AgentPalette(scheme).muted)
                        }
                        Text(comment.body)
                            .font(.caption)
                            .textSelection(.enabled)
                    }
                    .padding(9)
                    .background(
                        Color.white.opacity(scheme == .dark ? 0.04 : 0.5),
                        in: RoundedRectangle(cornerRadius: 10)
                    )
                }
            }
            if review.capabilities.comment {
                HStack(alignment: .bottom) {
                    TextField("Add review comment", text: $model.commentDraft, axis: .vertical)
                        .lineLimit(1...4)
                        .textFieldStyle(.roundedBorder)
                        .disabled(model.busy != nil)
                    Button("Post") { Task { await model.addComment() } }
                        .buttonStyle(.borderedProminent)
                        .tint(AgentPalette.coral)
                        .disabled(
                            model.busy != nil
                                || model.commentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        )
                }
            }

            Divider().opacity(0.25)
            Text("Review history")
                .font(.caption.weight(.bold))
            if review.events.isEmpty {
                empty("No review transitions yet")
            } else {
                ForEach(review.events) { event in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text("#\(event.sequence) · \(event.fromState ?? "start") → \(event.toState)")
                                .font(.caption2.weight(.bold))
                            Spacer()
                            Text(event.createdAt)
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(AgentPalette(scheme).muted)
                        }
                        Text("\(event.actorName) · \(event.role.capitalized)")
                            .font(.caption2)
                            .foregroundStyle(AgentPalette(scheme).muted)
                        if let note = event.note, !note.isEmpty {
                            Text(note).font(.caption).textSelection(.enabled)
                        }
                    }
                    .padding(.vertical, 3)
                }
            }
        }
    }

    private var rolloutCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("Lifecycle modes & rollout", icon: "switch.2")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 9) {
                ForEach(CSLifecycleCapability.allCases) { capability in
                    let decision = model.workspace?.rollouts[capability.rawValue]
                    VStack(alignment: .leading, spacing: 4) {
                        Text(capability.title).font(.caption.weight(.bold))
                        Text(modeStatus(capability, decision: decision))
                            .font(.caption2)
                            .foregroundStyle(capability == .livePublish ? .red : AgentPalette(scheme).muted)
                        if decision?.legacyFallbackAvailable == true {
                            Text("Legacy handoff only")
                                .font(.system(size: 9, weight: .medium))
                                .foregroundStyle(AgentPalette(scheme).muted)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(Color.white.opacity(scheme == .dark ? 0.045 : 0.6), in: RoundedRectangle(cornerRadius: 12))
                }
            }

            if model.owner {
                Divider().opacity(0.25)
                Text("Owner-scoped configuration · config only")
                    .font(.caption.weight(.bold))
                HStack {
                    Picker("Target role", selection: Binding(
                        get: { model.targetRole },
                        set: { value in
                            model.selectTargetRole(value)
                            Task { await model.loadFlags() }
                        }
                    )) {
                        ForEach(CSLifecycleTargetRole.allCases) { Text($0.title).tag($0) }
                    }
                    Picker("Capability", selection: Binding(
                        get: { model.capability },
                        set: { value in
                            model.selectCapability(value)
                            Task { await model.loadFlags() }
                        }
                    )) {
                        ForEach(CSLifecycleCapability.allCases) { Text($0.title).tag($0) }
                    }
                }
                .pickerStyle(.menu)
                .disabled(model.loading || model.busy != nil)

                Button(model.selectedFlag?.enabled == true ? "Disable exact scope" : "Enable exact scope") {
                    Task { await model.toggleFlag() }
                }
                .buttonStyle(.borderedProminent)
                .tint(model.selectedFlag?.enabled == true ? .orange : AgentPalette.coral)
                .disabled(
                    model.busy != nil
                        || (model.capability == .livePublish && model.selectedFlag?.enabled != true)
                )
                if let flag = model.selectedFlag {
                    Text("\(flag.role.capitalized) · \(flag.capability) · canary \(flag.canaryPercent)% · fallback \(flag.legacyFallbackAvailable ? "available" : "off")")
                        .font(.caption2)
                        .foregroundStyle(AgentPalette(scheme).muted)
                } else {
                    Text("No exact flag; evaluated rollout above remains authoritative and default-off.")
                        .font(.caption2)
                        .foregroundStyle(AgentPalette(scheme).muted)
                }
            }
        }
        .padding(14)
        .csv4LifecycleGlass(scheme)
    }

    private var jobsCard: some View {
        VStack(alignment: .leading, spacing: 11) {
            sectionTitle("Render & export jobs", icon: "arrow.triangle.2.circlepath")
            if let workspace = model.workspace {
                HStack(spacing: 8) {
                    metric("Queued", workspace.operations.queuedJobs.map(String.init) ?? "—")
                    metric("Verify", workspace.operations.artifactsPendingVerification.map(String.init) ?? "—")
                    metric("Worker", workspace.operations.workerHealth)
                }
                if workspace.jobs.isEmpty {
                    empty("এই exact brand/project scope-এ job নেই")
                } else {
                    ForEach(workspace.jobs) { job in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("\(job.kind.capitalized) · \(job.status.replacingOccurrences(of: "_", with: " ").capitalized)")
                                    .font(.caption.weight(.bold))
                                Spacer()
                                Text("\(job.effectClass) · ৳\(job.estimatedCostBdt, specifier: "%.0f")")
                                    .font(.caption2.monospacedDigit())
                            }
                            ProgressView(
                                value: Double(job.progress.completed),
                                total: Double(max(1, job.progress.total))
                            )
                            Text("Composition \(job.compositionVersionId) · source \(job.sourceArtifactVersionId)")
                                .font(.caption2)
                                .foregroundStyle(AgentPalette(scheme).muted)
                                .lineLimit(2)
                            HStack {
                                if ["queued", "running"].contains(job.status) {
                                    Button("Cancel", role: .destructive) { pendingCancel = job }
                                        .disabled(!model.owner || model.busy != nil)
                                } else if job.status == "failed" {
                                    Button("Retry") {
                                        Task { await model.control(job, intent: "retry") }
                                    }
                                    .tint(.orange)
                                    .disabled(!model.owner || model.busy != nil)
                                } else if job.status == "needs_review" {
                                    Label("Manual reconciliation required", systemImage: "exclamationmark.shield")
                                        .foregroundStyle(.orange)
                                }
                                Spacer()
                                Text(job.verifiedAt == nil ? (job.lastErrorCode ?? "Awaiting verification") : "Verified")
                                    .font(.caption2)
                                    .foregroundStyle(AgentPalette(scheme).muted)
                            }
                            .font(.caption.weight(.semibold))
                        }
                        .padding(11)
                        .background(Color.white.opacity(scheme == .dark ? 0.045 : 0.55), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            } else {
                empty("Lifecycle workspace unavailable")
            }
        }
        .padding(14)
        .csv4LifecycleGlass(scheme)
    }

    private func sectionTitle(_ value: String, icon: String) -> some View {
        Label(value, systemImage: icon)
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(AgentPalette.coralLt)
    }

    private func safetyPill(_ title: String, safe: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 9, weight: .bold))
            Text(safe ? "SAFE" : "CHECK")
                .font(.caption2.weight(.heavy))
                .foregroundStyle(safe ? .green : .orange)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Color.white.opacity(scheme == .dark ? 0.05 : 0.55), in: RoundedRectangle(cornerRadius: 10))
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).foregroundStyle(AgentPalette(scheme).muted)
            Spacer(minLength: 12)
            Text(value).multilineTextAlignment(.trailing).textSelection(.enabled)
        }
        .font(.caption)
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 9, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            Text(value).font(.caption.weight(.bold)).lineLimit(1).minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(9)
        .background(Color.white.opacity(scheme == .dark ? 0.045 : 0.55), in: RoundedRectangle(cornerRadius: 10))
    }

    private func modeStatus(_ capability: CSLifecycleCapability, decision: CSLifecycleRolloutDecision?) -> String {
        if capability == .livePublish { return "Hard off · no execution method" }
        guard let decision else { return "Not loaded" }
        if !decision.enabled {
            return decision.reason == "duplicate_scope_ambiguous" ? "Ambiguous · fail closed" : "Default off"
        }
        if !capability.isExecutable { return "Flag admitted · adapter unavailable" }
        return model.owner ? (capability == .preview ? "Owner preview admitted" : "Owner local queue admitted") : "Read only"
    }

    private func empty(_ value: String) -> some View {
        Text(value)
            .font(.caption)
            .foregroundStyle(AgentPalette(scheme).muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
    }
}

private extension View {
    func csv4LifecycleGlass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .stroke(Color.white.opacity(scheme == .dark ? 0.1 : 0.5), lineWidth: 0.7)
            }
    }
}
