//
//  CreativeStudioV4WorkspaceSwiftUI.swift
//  ALMA — native access to the current production Creative Studio workspace.
//
//  The web V4 route remains the server contract and authorization authority.
//  This file deliberately keeps the existing native visual language: glass cards,
//  coral actions, aurora background, sheets, and compact Bangla-first controls.
//

import SwiftUI
import Observation

// MARK: - Current-production wire contracts

struct CSV4Brand: Decodable, Identifiable, Equatable {
    let brandProfileId: String
    let name: String
    let organization: String?
    let role: String
    let approvalSpendThresholdBdt: Double?
    let projectCount: Int?
    let recipeCount: Int?
    let assetCount: Int?
    var id: String { brandProfileId }
}

private struct CSV4BrandsResponse: Decodable { let brands: [CSV4Brand] }

struct CSV4Recipe: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let version: Int?
    let locked: Bool?
    let finishTheme: String?
    let captionTone: String?
    let qcLevel: String?
    let spendCeilingBdt: Double?
}

private struct CSV4RecipesResponse: Decodable { let recipes: [CSV4Recipe] }

struct CSV4Composition: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let projectId: String
    let brandProfileId: String
    let sourceKind: String?
    let currentVersion: Int
    let readonly: Bool
    let updatedAt: String?
}

private struct CSV4CompositionsResponse: Decodable { let compositions: [CSV4Composition] }
private struct CSV4CompositionCreateResponse: Decodable { let composition: CSV4Composition; let idempotent: Bool? }

struct CSV4ReviewItem: Decodable, Identifiable, Equatable {
    let projectAssetId: String
    let projectId: String
    let brandProfileId: String
    let currentVersionId: String?
    let expectedSequence: Int
    let state: String
    let title: String?
    let previewUrl: String?
    var id: String { projectAssetId }
}

private struct CSV4ReviewQueueResponse: Decodable {
    let items: [CSV4ReviewItem]
    let nextCursor: String?
}

private struct CSV4ReviewThreadResponse: Decodable {
    struct Thread: Decodable { let assetId: String?; let currentState: String; let currentSequence: Int }
    let review: Thread
}

struct CSV4CampaignStage: Decodable, Identifiable, Equatable {
    let stageId: String?
    let id: String?
    let labelBn: String
    let mediaType: String
    let engine: String?
    let estimatedCostUsd: Double?
    let status: String?
    let previewUrl: String?
    var stableID: String { stageId ?? id ?? labelBn }
}

struct CSV4CampaignManifest: Decodable, Equatable {
    let projectId: String
    let estimatedSeconds: Int
    let estimatedCostUsd: Double
    let estimatedCostBdt: Double
    let hardCostCeilingUsd: Double
    let requiresPaidConfirmation: Bool
    let stages: [CSV4CampaignStage]
}

private struct CSV4CampaignPreviewResponse: Decodable { let manifest: CSV4CampaignManifest }

struct CSV4CampaignPack: Decodable, Identifiable, Equatable {
    let id: String
    let status: String
    let selectedDraftStageId: String?
    let progressPercent: Int?
    let estimatedCostUsd: Double?
    let actualCostUsd: Double?
    let stages: [CSV4CampaignStage]?
}

private struct CSV4CampaignPacksResponse: Decodable { let packs: [CSV4CampaignPack] }
private struct CSV4CampaignQueueResponse: Decodable { let pack: CSV4CampaignPack; let idempotent: Bool? }

struct CSV4VoiceVersion: Decodable, Identifiable, Equatable {
    let id: String
    let version: Int
    let status: String
    let providerReady: Bool
    let activatedAt: String?
    let revokedAt: String?
    let providerDeletedAt: String?
}

struct CSV4Voice: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let provider: String
    let activeVersionId: String?
    let versions: [CSV4VoiceVersion]
}

private struct CSV4VoicesResponse: Decodable { let voices: [CSV4Voice] }

struct CSV4Health: Decodable, Equatable {
    struct Engine: Decodable, Identifiable, Equatable {
        let engine: String
        let labelBn: String
        let jobs: Int
        let failed: Int
        let errorRatePct: Double
        let qcPassRatePct: Double?
        let spendUsd: Double
        let killed: Bool
        var id: String { engine }
    }
    struct Worker: Decodable, Equatable { let state: String; let labelBn: String; let healthy: Bool }
    struct Balance: Decodable, Identifiable, Equatable {
        let id: String; let label: String; let balanceUsd: Double?; let monthUsd: Double?
    }
    let engines: [Engine]
    let worker: Worker
    let turnConsumer: Worker
    let balances: [Balance]
}

struct CSV4Retention: Decodable, Equatable {
    struct Policy: Decodable, Encodable, Equatable {
        let archiveEnabled: Bool
        let deleteOriginalsEnabled: Bool
        let retentionDays: Int
        let verificationGraceHours: Int
    }
    struct Stats: Decodable, Equatable {
        let totalReceipts: Int
        let verifiedReceipts: Int
        let deletedOriginals: Int
        let failedReceipts: Int
        let oldestUnverifiedAgeHours: Double
    }
    let policy: Policy
    let stats: Stats
}

struct CSV4LifecycleWorkspace: Decodable, Equatable {
    struct Job: Decodable, Identifiable, Equatable {
        let id: String
        let status: String
        let kind: String?
        let estimatedCostBdt: Double?
        let effectClass: String?
    }
    struct Execution: Decodable, Equatable {
        let paidRender: Bool?
        let voiceProvider: Bool?
        let externalPublish: Bool?
        let localWorkerFlagEnabled: Bool?
    }
    struct Operations: Decodable, Equatable {
        let queuedJobs: Int?
        let oldestJobAgeMinutes: Int?
        let providerHealth: String?
        let providerBalanceBdt: Double?
        let workerHealth: String?
        let workerHeartbeatAgeMinutes: Int?
        let artifactsPendingVerification: Int?
        let missingSignals: [String]
    }
    let jobs: [Job]
    let operations: Operations
    let execution: Execution
}

struct CSV4Performance: Decodable, Equatable {
    struct Totals: Decodable, Equatable {
        let reach: Int; let impressions: Int; let engagements: Int; let clicks: Int; let conversions: Int
    }
    struct Snapshot: Decodable, Equatable {
        let reach: Int; let impressions: Int; let engagements: Int; let clicks: Int; let conversions: Int
    }
    struct Delivery: Decodable, Identifiable, Equatable {
        let id: String; let sceneKey: String; let platform: String; let status: String
        let postId: String?; let permalinkUrl: String?; let latestSnapshot: Snapshot?
    }
    struct Observability: Decodable, Equatable {
        let queueAgeSec: Int
        let workerHeartbeatAgeSec: Int?
        let providerErrorRatePct: Double
        let spendUsd7d: Double
        let qcRatePct7d: Double?
        let archivePending: Int
        let archiveLagHours: Int
        let publishFailures7d: Int
    }
    let totals: Totals
    let deliveries: [Delivery]
    let observability: Observability
}

struct CSV4RoleAssignment: Decodable, Identifiable, Equatable {
    let id: String
    let userId: String
    let userName: String
    let userEmail: String?
    let role: String
}

struct CSV4EligibleUser: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let email: String?
}

private struct CSV4RoleSettings: Decodable {
    let assignments: [CSV4RoleAssignment]
    let eligibleUsers: [CSV4EligibleUser]
}

private struct CSV4OK: Decodable { let ok: Bool?; let status: String? }

// MARK: - Workspace model

@available(iOS 17.0, *)
@Observable
final class CSV4WorkspaceVM {
    var brands: [CSV4Brand] = []
    var projects: [CSProjectSummary] = []
    var recipes: [CSV4Recipe] = []
    var compositions: [CSV4Composition] = []
    var reviews: [CSV4ReviewItem] = []
    var campaignPacks: [CSV4CampaignPack] = []
    var voices: [CSV4Voice] = []
    var roles: [CSV4RoleAssignment] = []
    var eligibleUsers: [CSV4EligibleUser] = []
    var health: CSV4Health?
    var retention: CSV4Retention?
    var lifecycle: CSV4LifecycleWorkspace?
    var performance: CSV4Performance?
    var campaignPreview: CSV4CampaignManifest?
    var selectedBrandID: String?
    var selectedProjectID: String?
    var loading = false
    var actionBusy = false
    var notice: String?

    var selectedBrand: CSV4Brand? { brands.first { $0.id == selectedBrandID } }
    var selectedProject: CSProjectSummary? { projects.first { $0.id == selectedProjectID } }

    func load(seedProject: CSProjectSummary?) async {
        loading = true
        defer { loading = false }
        do {
            let response: CSV4BrandsResponse = try await AlmaAPI.shared.get("/api/assistant/creative-studio/brands")
            brands = response.brands
            selectedBrandID = seedProject?.brandProfileId.flatMap { wanted in
                brands.first(where: { $0.id == wanted })?.id
            } ?? selectedBrandID ?? brands.first?.id
            await reloadBrand(preferredProjectID: seedProject?.id)
        } catch {
            notice = message(error, fallback: "V4 workspace লোড করা যায়নি")
        }
    }

    func reloadBrand(preferredProjectID: String? = nil) async {
        guard let brandID = selectedBrandID else { return }
        do {
            async let projectResponse: CSProjectsResponse = AlmaAPI.shared.get(
                "/api/assistant/creative-studio/projects", query: ["brandProfileId": brandID])
            async let recipeResponse: CSV4RecipesResponse = AlmaAPI.shared.get(
                "/api/assistant/creative-studio/recipes", query: ["brandProfileId": brandID])
            async let roleResponse: CSV4RoleSettings? = try? AlmaAPI.shared.get(
                "/api/assistant/creative-studio/roles", query: ["brandProfileId": brandID])
            let (loadedProjects, loadedRecipes, loadedRoles) = try await (projectResponse, recipeResponse, roleResponse)
            projects = loadedProjects.projects.filter { !$0.readonly }
            recipes = loadedRecipes.recipes
            roles = loadedRoles?.assignments ?? []
            eligibleUsers = loadedRoles?.eligibleUsers ?? []
            selectedProjectID = preferredProjectID.flatMap { id in projects.first(where: { $0.id == id })?.id }
                ?? projects.first(where: { $0.id == selectedProjectID })?.id
                ?? projects.first?.id
            await reloadProject()
        } catch {
            notice = message(error, fallback: "ব্র্যান্ড workspace লোড হয়নি")
        }
    }

    func reloadProject() async {
        guard let brandID = selectedBrandID, let projectID = selectedProjectID else {
            compositions = []; reviews = []; campaignPacks = []; voices = []; lifecycle = nil; performance = nil
            return
        }
        async let compositionResponse: CSV4CompositionsResponse? = try? AlmaAPI.shared.get(
            "/api/assistant/creative-studio/compositions",
            query: ["brandProfileId": brandID, "projectId": projectID])
        async let reviewResponse: CSV4ReviewQueueResponse? = try? AlmaAPI.shared.get(
            "/api/assistant/creative-studio/reviews",
            query: ["brandProfileId": brandID, "projectId": projectID, "includeApproved": "true"])
        async let packResponse: CSV4CampaignPacksResponse? = try? AlmaAPI.shared.get(
            "/api/assistant/creative-studio/campaign-packs", query: ["projectId": projectID])
        async let voiceResponse: CSV4VoicesResponse? = try? AlmaAPI.shared.get(
            "/api/assistant/creative-studio/voices",
            query: ["brandProfileId": brandID, "projectId": projectID])
        async let healthResponse: CSV4Health? = try? AlmaAPI.shared.get("/api/assistant/creative-studio/health")
        async let retentionResponse: CSV4Retention? = try? AlmaAPI.shared.get("/api/assistant/creative-studio/retention")
        async let lifecycleResponse: CSV4LifecycleWorkspace? = try? AlmaAPI.shared.get(
            "/api/assistant/creative-studio/lifecycle",
            query: ["brandProfileId": brandID, "projectId": projectID])
        async let performanceResponse: CSV4Performance? = try? AlmaAPI.shared.get(
            "/api/assistant/creative-studio/performance",
            query: ["brandProfileId": brandID, "projectId": projectID])
        let loaded = await (compositionResponse, reviewResponse, packResponse, voiceResponse,
                            healthResponse, retentionResponse, lifecycleResponse, performanceResponse)
        compositions = loaded.0?.compositions ?? []
        reviews = loaded.1?.items ?? []
        campaignPacks = loaded.2?.packs ?? []
        voices = loaded.3?.voices ?? []
        health = loaded.4
        retention = loaded.5
        lifecycle = loaded.6
        performance = loaded.7
        campaignPreview = nil
        await hydrateWaitingCampaignDrafts()
    }

    private func hydrateWaitingCampaignDrafts() async {
        for pack in campaignPacks where pack.status == "waiting_selection" {
            if let response: CSV4CampaignQueueResponse = try? await AlmaAPI.shared.get(
                "/api/assistant/creative-studio/campaign-packs/\(pack.id)") {
                replaceCampaignPack(response.pack)
            }
        }
    }

    func createProject(name: String, description: String) async -> Bool {
        struct Body: Encodable { let name: String; let description: String?; let brandName: String?; let defaultFolder = "Creative Studio" }
        struct Response: Decodable { let project: CSProjectSummary }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        actionBusy = true; defer { actionBusy = false }
        do {
            let response: Response = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/projects",
                body: Body(name: trimmed,
                           description: description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : description,
                           brandName: selectedBrand?.name))
            await reloadBrand(preferredProjectID: response.project.id)
            notice = "নতুন project তৈরি হয়েছে"
            return true
        } catch { notice = message(error, fallback: "Project তৈরি হয়নি"); return false }
    }

    func createComposition() async {
        guard let brandID = selectedBrandID, let projectID = selectedProjectID else { return }
        struct Canvas: Encodable { let width = 1080; let height = 1350; let aspectWidth = 4; let aspectHeight = 5 }
        struct Body: Encodable { let projectId: String; let brandProfileId: String; let idempotencyKey: String; let title: String; let canvas = Canvas() }
        actionBusy = true; defer { actionBusy = false }
        do {
            let response: CSV4CompositionCreateResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/compositions",
                body: Body(projectId: projectID, brandProfileId: brandID,
                           idempotencyKey: "ios-composition-\(UUID().uuidString)",
                           title: "\(selectedProject?.name ?? "Creative") composition"))
            if !compositions.contains(where: { $0.id == response.composition.id }) {
                compositions.insert(response.composition, at: 0)
            }
            notice = response.idempotent == true ? "Existing canvas খোলা হয়েছে" : "Versioned canvas তৈরি হয়েছে"
        } catch { notice = message(error, fallback: "Canvas তৈরি হয়নি") }
    }

    func previewCampaign(includeFamily: Bool, includeReel: Bool) async {
        guard let projectID = selectedProjectID else { return }
        struct Options: Encodable { let includeFamily: Bool; let includeReel: Bool }
        struct Body: Encodable { let intent = "preview"; let projectId: String; let options: Options }
        actionBusy = true; defer { actionBusy = false }
        do {
            let response: CSV4CampaignPreviewResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/campaign-packs",
                body: Body(projectId: projectID, options: Options(includeFamily: includeFamily, includeReel: includeReel)))
            campaignPreview = response.manifest
            notice = "Manifest তৈরি — এখনো কোনো খরচ হয়নি"
        } catch { notice = message(error, fallback: "Campaign manifest তৈরি হয়নি") }
    }

    func queueCampaign(includeFamily: Bool, includeReel: Bool) async {
        guard let projectID = selectedProjectID, let preview = campaignPreview else { return }
        struct Options: Encodable { let includeFamily: Bool; let includeReel: Bool }
        struct Body: Encodable {
            let intent = "queue"; let projectId: String; let options: Options
            let idempotencyKey: String; let confirmedCostUsd: Double
        }
        actionBusy = true; defer { actionBusy = false }
        do {
            let response: CSV4CampaignQueueResponse = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/campaign-packs",
                body: Body(projectId: projectID, options: Options(includeFamily: includeFamily, includeReel: includeReel),
                           idempotencyKey: "ios-campaign-\(UUID().uuidString)", confirmedCostUsd: preview.estimatedCostUsd))
            campaignPacks.insert(response.pack, at: 0)
            campaignPreview = nil
            notice = "Campaign Pack queue হয়েছে"
        } catch { notice = message(error, fallback: "Campaign Pack queue হয়নি") }
    }

    func selectCampaignDraft(pack: CSV4CampaignPack, stageID: String) async {
        guard pack.status == "waiting_selection", stageID == "draft-a" || stageID == "draft-b" else { return }
        struct Body: Encodable { let action = "select_draft"; let selectedDraftStageId: String }
        actionBusy = true; defer { actionBusy = false }
        do {
            let response: CSV4CampaignQueueResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/creative-studio/campaign-packs/\(pack.id)",
                body: Body(selectedDraftStageId: stageID))
            replaceCampaignPack(response.pack)
            notice = "Draft নির্বাচিত — বাকি campaign stages চলছে"
        } catch { notice = message(error, fallback: "Draft নির্বাচন হয়নি") }
    }

    private func replaceCampaignPack(_ pack: CSV4CampaignPack) {
        if let index = campaignPacks.firstIndex(where: { $0.id == pack.id }) {
            campaignPacks[index] = pack
        } else {
            campaignPacks.insert(pack, at: 0)
        }
    }

    func transition(_ item: CSV4ReviewItem, to target: String) async {
        guard let brandID = selectedBrandID else { return }
        struct Body: Encodable {
            let brandProfileId: String; let targetState: String; let expectedSequence: Int
            let note: String
        }
        actionBusy = true; defer { actionBusy = false }
        do {
            let response: CSV4ReviewThreadResponse = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/creative-studio/assets/\(item.projectAssetId)/state",
                body: Body(brandProfileId: brandID, targetState: target,
                           expectedSequence: item.expectedSequence, note: "Updated from native iOS Creative Studio"))
            if let index = reviews.firstIndex(where: { $0.id == item.id }) {
                let current = reviews[index]
                reviews[index] = CSV4ReviewItem(projectAssetId: current.projectAssetId,
                    projectId: current.projectId, brandProfileId: current.brandProfileId,
                    currentVersionId: current.currentVersionId,
                    expectedSequence: response.review.currentSequence,
                    state: response.review.currentState, title: current.title, previewUrl: current.previewUrl)
            }
            notice = "Review state আপডেট হয়েছে"
        } catch { notice = message(error, fallback: "Review আপডেট হয়নি") }
    }

    func updateVoiceVersion(_ version: CSV4VoiceVersion, action: String) async {
        struct Body: Encodable { let action: String; let reason = "Native iOS owner action" }
        actionBusy = true; defer { actionBusy = false }
        do {
            let _: CSV4OK = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/creative-studio/voices/\(version.id)", body: Body(action: action))
            await reloadProject()
            notice = action == "activate" ? "Voice version active" : "Voice version revoked"
        } catch { notice = message(error, fallback: "Voice update হয়নি") }
    }

    func deleteVoiceVersion(_ version: CSV4VoiceVersion) async {
        struct Body: Encodable { let reason = "Deleted from native iOS owner library" }
        actionBusy = true; defer { actionBusy = false }
        do {
            let _: CSV4OK = try await AlmaAPI.shared.send(
                "DELETE", "/api/assistant/creative-studio/voices/\(version.id)", body: Body())
            await reloadProject()
            notice = "Provider deletion request recorded"
        } catch { notice = message(error, fallback: "Voice delete হয়নি") }
    }

    func setEngine(_ engine: CSV4Health.Engine, killed: Bool) async {
        struct Kill: Encodable { let id: String; let killed: Bool }
        struct Body: Encodable { let killEngine: Kill }
        actionBusy = true; defer { actionBusy = false }
        do {
            let _: CSV4OK = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/settings",
                body: Body(killEngine: Kill(id: engine.engine, killed: killed)))
            if let refreshed: CSV4Health = try? await AlmaAPI.shared.get("/api/assistant/creative-studio/health") { health = refreshed }
            notice = killed ? "Engine বন্ধ করা হয়েছে" : "Engine আবার চালু হয়েছে"
        } catch { notice = message(error, fallback: "Engine policy আপডেট হয়নি") }
    }

    func saveRetention(archiveEnabled: Bool, deleteOriginalsEnabled: Bool,
                       retentionDays: Int, verificationGraceHours: Int) async {
        struct Body: Encodable {
            let archiveEnabled: Bool; let deleteOriginalsEnabled: Bool
            let retentionDays: Int; let verificationGraceHours: Int
        }
        actionBusy = true; defer { actionBusy = false }
        do {
            let updated: CSV4Retention = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/creative-studio/retention",
                body: Body(archiveEnabled: archiveEnabled,
                           deleteOriginalsEnabled: deleteOriginalsEnabled,
                           retentionDays: retentionDays,
                           verificationGraceHours: verificationGraceHours))
            retention = updated
            notice = "Retention policy saved"
        } catch { notice = message(error, fallback: "Retention policy save হয়নি") }
    }

    func controlLifecycle(_ job: CSV4LifecycleWorkspace.Job, intent: String) async {
        struct Body: Encodable { let intent: String; let idempotencyKey: String }
        actionBusy = true; defer { actionBusy = false }
        do {
            let _: CSV4OK = try await AlmaAPI.shared.send(
                "PATCH", "/api/assistant/creative-studio/lifecycle/\(job.id)",
                body: Body(intent: intent, idempotencyKey: "ios-lifecycle-\(intent)-\(UUID().uuidString)"))
            await reloadProject()
            notice = intent == "cancel" ? "Lifecycle job canceled" : "Lifecycle job retry queued"
        } catch { notice = message(error, fallback: "Lifecycle job update হয়নি") }
    }

    func assign(_ user: CSV4EligibleUser, role: String) async {
        guard let brandID = selectedBrandID else { return }
        struct Body: Encodable { let brandProfileId: String; let userId: String; let role: String }
        actionBusy = true; defer { actionBusy = false }
        do {
            let response: CSV4RoleSettings = try await AlmaAPI.shared.send(
                "POST", "/api/assistant/creative-studio/roles",
                body: Body(brandProfileId: brandID, userId: user.id, role: role))
            roles = response.assignments; eligibleUsers = response.eligibleUsers
            notice = "Team role assigned"
        } catch { notice = message(error, fallback: "Role assign হয়নি") }
    }

    func remove(_ assignment: CSV4RoleAssignment) async {
        guard let brandID = selectedBrandID else { return }
        struct Body: Encodable { let brandProfileId: String; let userId: String }
        actionBusy = true; defer { actionBusy = false }
        do {
            let response: CSV4RoleSettings = try await AlmaAPI.shared.send(
                "DELETE", "/api/assistant/creative-studio/roles",
                body: Body(brandProfileId: brandID, userId: assignment.userId))
            roles = response.assignments; eligibleUsers = response.eligibleUsers
            notice = "Team role removed"
        } catch { notice = message(error, fallback: "Role remove হয়নি") }
    }

    private func message(_ error: Error, fallback: String) -> String {
        if let apiError = error as? AlmaAPIError {
            switch apiError {
            case let .http(_, body): return CS.serverMessage(body) ?? fallback
            case .notAuthenticated: return "সেশন শেষ — আবার লগইন করুন"
            default: break
            }
        }
        return fallback
    }
}

// MARK: - Native V4 workspace

@available(iOS 17.0, *)
struct CSV4WorkspaceScreen: View {
    enum Section: String, CaseIterable, Identifiable {
        case overview = "Workspace", projects = "Projects", review = "Review"
        case campaign = "Campaign", voice = "Voice", operations = "Operations"
        var id: String { rawValue }
    }

    let seedProject: CSProjectSummary?
    let onProjectSelected: (CSProjectSummary) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var model = CSV4WorkspaceVM()
    @State private var section: Section = .overview
    @State private var createProjectSheet = false
    @State private var includeFamily = false
    @State private var includeReel = false
    @State private var confirmCampaign = false
    @State private var pendingVoiceDelete: CSV4VoiceVersion?
    @State private var pendingEngine: CSV4Health.Engine?
    @State private var pendingRoleRemoval: CSV4RoleAssignment?
    @State private var pendingLifecycleCancel: CSV4LifecycleWorkspace.Job?
    @State private var confirmRetention = false
    @State private var retentionArchive = true
    @State private var retentionDelete = false
    @State private var retentionDays = 30
    @State private var retentionGrace = 24
    @State private var retentionSeeded = false

    init(seedProject: CSProjectSummary?, onProjectSelected: @escaping (CSProjectSummary) -> Void = { _ in }) {
        self.seedProject = seedProject
        self.onProjectSelected = onProjectSelected
    }

    var body: some View {
        NavigationStack {
            ZStack {
                AgentPalette(scheme).bg0.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        scopeCard
                        sectionPicker
                        content
                        Color.clear.frame(height: 30)
                    }.padding(16)
                }
                if model.loading {
                    ProgressView("Production workspace লোড হচ্ছে…")
                        .padding(18).v4Glass(scheme, corner: 18)
                }
            }
            .navigationTitle("Creative Studio V4")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await model.reloadProject() } } label: { Image(systemName: "arrow.clockwise") }
                        .disabled(model.loading || model.actionBusy)
                }
            }
        }
        .task {
            await model.load(seedProject: seedProject)
            syncSelectedProject()
        }
        .sheet(isPresented: $createProjectSheet) {
            CSV4CreateProjectSheet(model: model) { syncSelectedProject() }
        }
        .alert("Campaign Pack queue করবেন?", isPresented: $confirmCampaign) {
            Button("বাতিল", role: .cancel) {}
            Button("Confirm & Queue") { Task { await model.queueCampaign(includeFamily: includeFamily, includeReel: includeReel) } }
        } message: {
            Text("সর্বোচ্চ নিশ্চিত খরচ: $\(model.campaignPreview?.estimatedCostUsd ?? 0, specifier: "%.3f") / ৳\(model.campaignPreview?.estimatedCostBdt ?? 0, specifier: "%.0f").")
        }
        .alert("Voice version provider থেকেও delete করবেন?", isPresented: Binding(
            get: { pendingVoiceDelete != nil }, set: { if !$0 { pendingVoiceDelete = nil } })) {
            Button("বাতিল", role: .cancel) {}
            Button("Delete", role: .destructive) { if let value = pendingVoiceDelete { Task { await model.deleteVoiceVersion(value) } } }
        }
        .alert("Engine policy বদলাবেন?", isPresented: Binding(
            get: { pendingEngine != nil }, set: { if !$0 { pendingEngine = nil } })) {
            Button("বাতিল", role: .cancel) {}
            Button(pendingEngine?.killed == true ? "চালু করুন" : "বন্ধ করুন", role: pendingEngine?.killed == true ? nil : .destructive) {
                if let engine = pendingEngine { Task { await model.setEngine(engine, killed: !engine.killed) } }
            }
        }
        .alert("Team access সরাবেন?", isPresented: Binding(
            get: { pendingRoleRemoval != nil }, set: { if !$0 { pendingRoleRemoval = nil } })) {
            Button("বাতিল", role: .cancel) {}
            Button("Remove", role: .destructive) { if let value = pendingRoleRemoval { Task { await model.remove(value) } } }
        }
        .alert("Lifecycle job cancel করবেন?", isPresented: Binding(
            get: { pendingLifecycleCancel != nil }, set: { if !$0 { pendingLifecycleCancel = nil } })) {
            Button("বাতিল", role: .cancel) {}
            Button("Cancel job", role: .destructive) {
                if let value = pendingLifecycleCancel { Task { await model.controlLifecycle(value, intent: "cancel") } }
            }
        } message: { Text("শুধু queued/running zero-cost lifecycle job cancel হবে; external publish এখানে চালু হয় না।") }
        .alert("Retention policy save করবেন?", isPresented: $confirmRetention) {
            Button("বাতিল", role: .cancel) {}
            Button("Save policy") {
                Task { await model.saveRetention(archiveEnabled: retentionArchive,
                    deleteOriginalsEnabled: retentionDelete, retentionDays: retentionDays,
                    verificationGraceHours: retentionGrace) }
            }
        } message: {
            Text("Archive \(retentionArchive ? "on" : "off") · originals deletion \(retentionDelete ? "on" : "off") · \(retentionDays) days · \(retentionGrace)h verification grace.")
        }
        .overlay(alignment: .top) {
            if let notice = model.notice {
                Text(notice).font(.caption.weight(.semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(.black.opacity(0.78), in: Capsule()).padding(.top, 8)
                    .task { try? await Task.sleep(for: .seconds(3)); if model.notice == notice { model.notice = nil } }
            }
        }
    }

    private var scopeCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Production scope", systemImage: "lock.shield.fill")
                .font(.system(size: 13, weight: .bold)).foregroundStyle(AgentPalette.coralLt)
            Picker("ব্র্যান্ড", selection: Binding(get: { model.selectedBrandID ?? "" }, set: { value in
                model.selectedBrandID = value
                Task {
                    await model.reloadBrand()
                    syncSelectedProject()
                }
            })) {
                ForEach(model.brands) { Text("\($0.name) · \($0.role.capitalized)").tag($0.id) }
            }.pickerStyle(.menu)
            Picker("প্রজেক্ট", selection: Binding(get: { model.selectedProjectID ?? "" }, set: { value in
                model.selectedProjectID = value
                if let project = model.projects.first(where: { $0.id == value }) { onProjectSelected(project) }
                Task { await model.reloadProject() }
            })) {
                ForEach(model.projects) { Text("\($0.name) · \(almaBn($0.assetCount ?? 0)) assets").tag($0.id) }
            }.pickerStyle(.menu)
        }.padding(14).v4Glass(scheme)
    }

    private var sectionPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Section.allCases) { item in
                    Button(item.rawValue) { section = item; CSHaptic.tap() }
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(section == item ? .white : AgentPalette(scheme).muted)
                        .padding(.horizontal, 13).padding(.vertical, 9)
                        .background(section == item ? AgentPalette.coral : Color.white.opacity(0.06), in: Capsule())
                }
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch section {
        case .overview: overview
        case .projects: projects
        case .review: review
        case .campaign: campaign
        case .voice: voice
        case .operations: operations
        }
    }

    private var overview: some View {
        VStack(spacing: 12) {
            metricRow("Production projects", value: almaBn(model.projects.count), icon: "folder.fill")
            metricRow("Versioned canvases", value: almaBn(model.compositions.count), icon: "square.on.square")
            metricRow("Needs review", value: almaBn(model.reviews.filter { $0.state != "approved" }.count), icon: "checkmark.seal")
            metricRow("Saved voices", value: almaBn(model.voices.count), icon: "waveform")
            teamCard
        }
    }

    private var projects: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { title("Projects & lineage", "folder.fill"); Spacer(); Button("নতুন") { createProjectSheet = true }.buttonStyle(.borderedProminent).tint(AgentPalette.coral) }
            ForEach(model.projects) { project in
                Button { model.selectedProjectID = project.id; onProjectSelected(project); Task { await model.reloadProject() } } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack { Text(project.name).font(.headline); Spacer(); if project.id == model.selectedProjectID { Image(systemName: "checkmark.circle.fill").foregroundStyle(AgentPalette.coral) } }
                        Text("\(project.product?.code ?? "No ERP product") · \(project.defaultFolder ?? "Unsorted") · \(almaBn(project.assetCount ?? 0)) assets")
                            .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
                        Text(project.currentRecipe?.name ?? "No locked recipe").font(.caption2).foregroundStyle(AgentPalette.coralLt)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(13).v4Glass(scheme)
                }.buttonStyle(.plain)
            }
            title("Versioned long-form", "rectangle.3.group")
            if model.compositions.isEmpty { empty("এই project-এ এখনো canvas নেই") }
            ForEach(model.compositions) { composition in
                HStack {
                    VStack(alignment: .leading) { Text(composition.title).font(.subheadline.weight(.bold)); Text("v\(composition.currentVersion) · \(composition.sourceKind ?? "native")").font(.caption).foregroundStyle(AgentPalette(scheme).muted) }
                    Spacer(); if composition.readonly { Image(systemName: "lock.fill") }
                }.padding(13).v4Glass(scheme)
            }
            Button { Task { await model.createComposition() } } label: {
                Label("Versioned canvas তৈরি / খুলুন", systemImage: "plus.square.on.square")
                    .font(.system(size: 13, weight: .bold)).frame(maxWidth: .infinity).padding(12)
            }.buttonStyle(.borderedProminent).tint(AgentPalette.coral).disabled(model.selectedProjectID == nil || model.actionBusy)
            title("Brand recipes", "slider.horizontal.3")
            if model.recipes.isEmpty { empty("Active brand-এ recipe নেই") }
            ForEach(model.recipes) { recipe in
                VStack(alignment: .leading, spacing: 4) {
                    HStack { Text(recipe.name).font(.subheadline.weight(.bold)); Spacer(); Text(recipe.locked == true ? "Locked" : "Draft").font(.caption2.weight(.bold)).foregroundStyle(recipe.locked == true ? .green : .orange) }
                    Text("v\(recipe.version ?? 1) · \(recipe.finishTheme ?? "default") · QC \(recipe.qcLevel ?? "strict") · cap ৳\(almaBn(Int(recipe.spendCeilingBdt ?? 0)))")
                        .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
                }.padding(13).v4Glass(scheme)
            }
        }
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: 12) {
            title("Pinned review queue", "checkmark.seal.fill")
            Text("Server sequence ও exact asset version বজায় রেখে transition হয়।")
                .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
            if model.reviews.isEmpty { empty("এই project-এ review item নেই") }
            ForEach(model.reviews) { item in
                VStack(alignment: .leading, spacing: 9) {
                    HStack { Text(item.title ?? "Untitled asset").font(.subheadline.weight(.bold)); Spacer(); status(item.state) }
                    Text("Version \(item.currentVersionId.map { String($0.prefix(10)) } ?? "—") · sequence \(item.expectedSequence)")
                        .font(.caption2).foregroundStyle(AgentPalette(scheme).muted)
                    HStack {
                        if item.state == "draft" || item.state == "revised" {
                            smallAction("Approve", color: .green) { Task { await model.transition(item, to: "approved") } }
                            smallAction("Changes", color: .orange) { Task { await model.transition(item, to: "changes_requested") } }
                        } else if item.state == "changes_requested" {
                            smallAction("Mark revised", color: AgentPalette.coral) { Task { await model.transition(item, to: "revised") } }
                        } else { Label("Publish-ready version pinned", systemImage: "checkmark.shield.fill").font(.caption).foregroundStyle(.green) }
                    }
                }.padding(13).v4Glass(scheme)
            }
        }
    }

    private var campaign: some View {
        VStack(alignment: .leading, spacing: 12) {
            title("Campaign Pack", "shippingbox.fill")
            Text("Preview manifest free/read-only। Queue করার আগে exact hard cap আবার confirm হবে।")
                .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
            Toggle("Family 4:5 variant", isOn: $includeFamily).tint(AgentPalette.coral)
            Toggle("6-second reel", isOn: $includeReel).tint(AgentPalette.coral)
            Button { Task { await model.previewCampaign(includeFamily: includeFamily, includeReel: includeReel) } } label: {
                Label("Free manifest preview", systemImage: "doc.text.magnifyingglass").frame(maxWidth: .infinity).padding(11)
            }.buttonStyle(.borderedProminent).tint(AgentPalette.coral).disabled(model.selectedProjectID == nil || model.actionBusy)
            if let preview = model.campaignPreview {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(almaBn(preview.stages.count)) outputs · ~\(almaBn(preview.estimatedSeconds)) sec").font(.headline)
                    Text("Estimate $\(preview.estimatedCostUsd, specifier: "%.3f") / ৳\(preview.estimatedCostBdt, specifier: "%.0f") · hard ceiling $\(preview.hardCostCeilingUsd, specifier: "%.2f")")
                        .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
                    ForEach(preview.stages, id: \.stableID) { stage in
                        HStack { Text(stage.labelBn).font(.caption.weight(.semibold)); Spacer(); Text(stage.engine ?? stage.mediaType).font(.caption2).foregroundStyle(AgentPalette(scheme).muted) }
                    }
                    Button(preview.estimatedCostUsd > 0 ? "Review cost & queue" : "Queue zero-cost pack") { confirmCampaign = true }
                        .buttonStyle(.borderedProminent).tint(.green).frame(maxWidth: .infinity)
                }.padding(14).v4Glass(scheme)
            }
            title("Recent packs", "clock.arrow.circlepath")
            if model.campaignPacks.isEmpty { empty("এই project-এ pack নেই") }
            ForEach(model.campaignPacks) { pack in
                VStack(alignment: .leading, spacing: 10) {
                    HStack { VStack(alignment: .leading) { Text(pack.status.replacingOccurrences(of: "_", with: " ").capitalized).font(.subheadline.weight(.bold)); Text("\(almaBn(pack.progressPercent ?? 0))% · $\(pack.actualCostUsd ?? 0, specifier: "%.3f") actual").font(.caption).foregroundStyle(AgentPalette(scheme).muted) }; Spacer(); status(pack.status) }
                    if pack.status == "waiting_selection" {
                        Text("পরবর্তী paid stages চালাতে একটি completed draft বেছে নিন।")
                            .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
                        HStack(alignment: .top, spacing: 9) {
                            ForEach((pack.stages ?? []).filter { $0.stageId == "draft-a" || $0.stageId == "draft-b" }, id: \.stableID) { stage in
                                campaignDraft(pack: pack, stage: stage)
                            }
                        }
                    }
                }.padding(13).v4Glass(scheme)
            }
        }
        .onChange(of: includeFamily) { _, _ in model.campaignPreview = nil }
        .onChange(of: includeReel) { _, _ in model.campaignPreview = nil }
    }

    private func campaignDraft(pack: CSV4CampaignPack, stage: CSV4CampaignStage) -> some View {
        VStack(spacing: 7) {
            Group {
                if let raw = stage.previewUrl, let url = URL(string: raw) {
                    AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { ProgressView() }
                } else {
                    ZStack { Color.white.opacity(0.05); Image(systemName: stage.status == "ready" ? "checkmark" : "clock") }
                }
            }
            .frame(maxWidth: .infinity).aspectRatio(4.0 / 5.0, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            Text(stage.labelBn).font(.caption2.weight(.bold)).lineLimit(1)
            if pack.selectedDraftStageId == stage.stageId {
                Label("Selected", systemImage: "checkmark.circle.fill").font(.caption2).foregroundStyle(.green)
            } else if stage.status == "ready", let stageID = stage.stageId {
                Button("এই draft নিন") { Task { await model.selectCampaignDraft(pack: pack, stageID: stageID) } }
                    .font(.caption2.weight(.bold)).buttonStyle(.borderedProminent).tint(AgentPalette.coral)
                    .disabled(model.actionBusy)
            } else {
                status(stage.status ?? "pending")
            }
        }.frame(maxWidth: .infinity)
    }

    private var voice: some View {
        VStack(alignment: .leading, spacing: 12) {
            title("Owner Voice Library", "waveform.badge.mic")
            Text("Consent, immutable version, activation, revocation এবং provider deletion production policy অনুযায়ী। নতুন sample Audio tab থেকে upload করা যায়।")
                .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
            if model.voices.isEmpty { empty("Lifecycle voice নেই — Audio tab থেকে consented sample দিন") }
            ForEach(model.voices) { voice in
                VStack(alignment: .leading, spacing: 9) {
                    HStack { Text(voice.name).font(.headline); Spacer(); Text(voice.provider).font(.caption).foregroundStyle(AgentPalette(scheme).muted) }
                    ForEach(voice.versions) { version in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack { Text("Version \(version.version)").font(.subheadline.weight(.semibold)); Spacer(); status(version.status) }
                            HStack {
                                if voice.activeVersionId != version.id && version.providerReady && version.status == "ready"
                                    && version.revokedAt == nil && version.providerDeletedAt == nil {
                                    smallAction("Activate", color: .green) { Task { await model.updateVoiceVersion(version, action: "activate") } }
                                }
                                if version.revokedAt == nil && version.providerDeletedAt == nil {
                                    smallAction("Revoke", color: .orange) { Task { await model.updateVoiceVersion(version, action: "revoke") } }
                                }
                                smallAction("Delete", color: .red) { pendingVoiceDelete = version }
                            }
                        }.padding(10).background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 12))
                    }
                }.padding(13).v4Glass(scheme)
            }
        }
    }

    private var operations: some View {
        VStack(alignment: .leading, spacing: 12) {
            title("Provider health", "heart.text.square.fill")
            if let health = model.health {
                HStack { status(health.worker.state); Text("Worker").font(.caption); status(health.turnConsumer.state); Text("Turn consumer").font(.caption) }
                ForEach(health.engines) { engine in
                    HStack {
                        VStack(alignment: .leading) { Text(engine.labelBn).font(.subheadline.weight(.bold)); Text("\(engine.jobs) jobs · \(engine.errorRatePct, specifier: "%.1f")% errors · $\(engine.spendUsd, specifier: "%.3f")").font(.caption).foregroundStyle(AgentPalette(scheme).muted) }
                        Spacer()
                        Button(engine.killed ? "Enable" : "Kill") { pendingEngine = engine }
                            .font(.caption.weight(.bold)).foregroundStyle(engine.killed ? .green : .red)
                    }.padding(12).v4Glass(scheme)
                }
            } else { empty("Health snapshot unavailable") }
            title("Retention", "archivebox.fill")
            if let retention = model.retention {
                VStack(alignment: .leading, spacing: 5) {
                    Text("\(almaBn(retention.policy.retentionDays)) days · verification grace \(almaBn(retention.policy.verificationGraceHours))h").font(.subheadline.weight(.bold))
                    Text("\(almaBn(retention.stats.verifiedReceipts))/\(almaBn(retention.stats.totalReceipts)) verified · \(almaBn(retention.stats.failedReceipts)) failed · \(almaBn(retention.stats.deletedOriginals)) originals deleted")
                        .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
                    Divider().opacity(0.25).padding(.vertical, 4)
                    Toggle("Archive verified artifacts", isOn: $retentionArchive).tint(AgentPalette.coral)
                    Toggle("Delete originals after verification", isOn: $retentionDelete).tint(.red)
                    Stepper("Retention \(almaBn(retentionDays)) days", value: $retentionDays, in: 7...365, step: 7)
                    Stepper("Verification grace \(almaBn(retentionGrace))h", value: $retentionGrace, in: 1...168)
                    Button("Review & save policy") { confirmRetention = true }
                        .font(.caption.weight(.bold)).buttonStyle(.bordered).tint(AgentPalette.coral)
                }.padding(13).v4Glass(scheme)
                    .onAppear { seedRetention(retention) }
            } else { empty("Retention policy unavailable") }
            title("Performance & attribution", "chart.line.uptrend.xyaxis")
            if let performance = model.performance {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        metricMini("Reach", almaBn(performance.totals.reach))
                        metricMini("Clicks", almaBn(performance.totals.clicks))
                        metricMini("Sales", almaBn(performance.totals.conversions))
                    }
                    Text("7d spend $\(performance.observability.spendUsd7d, specifier: "%.2f") · provider errors \(performance.observability.providerErrorRatePct, specifier: "%.1f")% · QC \(performance.observability.qcRatePct7d ?? 0, specifier: "%.1f")%")
                        .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
                    if performance.deliveries.isEmpty {
                        Text("No attributed Meta delivery yet").font(.caption).foregroundStyle(AgentPalette(scheme).muted)
                    }
                    ForEach(performance.deliveries.prefix(5)) { delivery in
                        HStack {
                            VStack(alignment: .leading) {
                                Text("\(delivery.platform.capitalized) · \(delivery.sceneKey)").font(.caption.weight(.bold))
                                if let snapshot = delivery.latestSnapshot {
                                    Text("\(almaBn(snapshot.reach)) reach · \(almaBn(snapshot.clicks)) clicks · \(almaBn(snapshot.conversions)) conversions")
                                        .font(.caption2).foregroundStyle(AgentPalette(scheme).muted)
                                }
                            }
                            Spacer(); status(delivery.status)
                        }
                    }
                }.padding(13).v4Glass(scheme)
            } else { empty("Performance dashboard unavailable") }
            title("Zero-cost lifecycle", "arrow.triangle.2.circlepath")
            if let lifecycle = model.lifecycle {
                Text("Paid render \(lifecycle.execution.paidRender == true ? "enabled" : "blocked") · external publish \(lifecycle.execution.externalPublish == true ? "enabled" : "blocked")")
                    .font(.caption).foregroundStyle(AgentPalette(scheme).muted)
                HStack {
                    metricMini("Queued", almaBn(lifecycle.operations.queuedJobs ?? 0))
                    metricMini("Verify", almaBn(lifecycle.operations.artifactsPendingVerification ?? 0))
                    metricMini("Worker", lifecycle.operations.workerHealth ?? "unknown")
                }.padding(12).v4Glass(scheme)
                if lifecycle.jobs.isEmpty { empty("Lifecycle job নেই") }
                ForEach(lifecycle.jobs.prefix(8)) { job in
                    HStack {
                        Text(job.kind ?? "local job").font(.subheadline)
                        Spacer(); status(job.status)
                        Text("৳\(job.estimatedCostBdt ?? 0, specifier: "%.0f")").font(.caption.monospacedDigit())
                        if job.status == "queued" || job.status == "running" {
                            Button("Cancel") { pendingLifecycleCancel = job }.font(.caption2.weight(.bold)).foregroundStyle(.red)
                        } else if job.status == "failed" {
                            Button("Retry") { Task { await model.controlLifecycle(job, intent: "retry") } }
                                .font(.caption2.weight(.bold)).foregroundStyle(.orange)
                        }
                    }
                        .padding(11).v4Glass(scheme)
                }
            } else { empty("Lifecycle workspace unavailable") }
        }
    }

    private var teamCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            title("Team & permissions", "person.2.badge.gearshape")
            if model.roles.isEmpty { Text("কোনো collaborator নেই").font(.caption).foregroundStyle(AgentPalette(scheme).muted) }
            ForEach(model.roles) { assignment in
                HStack { VStack(alignment: .leading) { Text(assignment.userName).font(.subheadline.weight(.semibold)); Text(assignment.role.capitalized).font(.caption).foregroundStyle(AgentPalette(scheme).muted) }; Spacer(); Button(role: .destructive) { pendingRoleRemoval = assignment } label: { Image(systemName: "person.badge.minus") } }
            }
            ForEach(model.eligibleUsers.prefix(5)) { user in
                HStack { Text(user.name).font(.subheadline); Spacer(); smallAction("Creator", color: AgentPalette.coral) { Task { await model.assign(user, role: "creator") } }; smallAction("Reviewer", color: .blue) { Task { await model.assign(user, role: "reviewer") } } }
            }
        }.padding(14).v4Glass(scheme)
    }

    private func metricRow(_ label: String, value: String, icon: String) -> some View {
        HStack { Image(systemName: icon).foregroundStyle(AgentPalette.coralLt).frame(width: 30); Text(label).font(.subheadline.weight(.semibold)); Spacer(); Text(value).font(.title3.bold()).monospacedDigit() }
            .padding(14).v4Glass(scheme)
    }
    private func metricMini(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 9, weight: .bold)).foregroundStyle(AgentPalette(scheme).muted)
            Text(value).font(.caption.weight(.bold)).lineLimit(1).minimumScaleFactor(0.7)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func seedRetention(_ value: CSV4Retention) {
        guard !retentionSeeded else { return }
        retentionArchive = value.policy.archiveEnabled
        retentionDelete = value.policy.deleteOriginalsEnabled
        retentionDays = value.policy.retentionDays
        retentionGrace = value.policy.verificationGraceHours
        retentionSeeded = true
    }
    private func title(_ text: String, _ icon: String) -> some View { Label(text, systemImage: icon).font(.system(size: 15, weight: .bold)).foregroundStyle(AgentPalette(scheme).ink) }
    private func empty(_ text: String) -> some View { Text(text).font(.caption).foregroundStyle(AgentPalette(scheme).muted).frame(maxWidth: .infinity, alignment: .leading).padding(13).v4Glass(scheme) }
    private func status(_ value: String) -> some View {
        Text(value.replacingOccurrences(of: "_", with: " ").capitalized).font(.system(size: 9.5, weight: .bold))
            .foregroundStyle(value == "approved" || value == "ready" || value == "healthy" ? Color.green : AgentPalette.coralLt)
            .padding(.horizontal, 8).padding(.vertical, 4).background(Color.white.opacity(0.08), in: Capsule())
    }
    private func smallAction(_ label: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(label, action: action).font(.system(size: 10.5, weight: .bold)).foregroundStyle(color)
            .padding(.horizontal, 9).padding(.vertical, 6).background(color.opacity(0.12), in: Capsule())
            .disabled(model.actionBusy)
    }

    private func syncSelectedProject() {
        if let project = model.selectedProject { onProjectSelected(project) }
    }
}

@available(iOS 17.0, *)
private struct CSV4CreateProjectSheet: View {
    let model: CSV4WorkspaceVM
    let onCreated: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    var body: some View {
        NavigationStack {
            Form {
                Section("Project") {
                    TextField("নাম", text: $name)
                    TextField("বর্ণনা (ঐচ্ছিক)", text: $description, axis: .vertical)
                }
                Section { Text("Project active brand-এর server-owned scope-এ তৈরি হবে।").font(.caption).foregroundStyle(.secondary) }
            }
            .navigationTitle("নতুন Creative project").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("বাতিল") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("তৈরি") {
                        Task {
                            if await model.createProject(name: name, description: description) {
                                onCreated()
                                dismiss()
                            }
                        }
                    }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.actionBusy)
                }
            }
        }
    }
}

@available(iOS 17.0, *)
private extension View {
    func v4Glass(_ scheme: ColorScheme, corner: CGFloat = 16) -> some View {
        background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .background(Color.white.opacity(scheme == .dark ? 0.035 : 0.28),
                        in: RoundedRectangle(cornerRadius: corner, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: corner, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.1 : 0.36), lineWidth: 1))
    }
}
