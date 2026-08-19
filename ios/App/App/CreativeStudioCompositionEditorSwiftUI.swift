//
//  CreativeStudioCompositionEditorSwiftUI.swift
//  ALMA — native Foundation composition editor for Creative Studio.
//
//  All mutations are reversible, zero-cost Foundation operations. Provider,
//  render, voice and publish actions are intentionally outside this surface.
//

import Foundation
import Observation
import SwiftUI

// MARK: - Lossless JSON value for server-compiled Foundation operations

private indirect enum CSCEJSONValue: Codable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([CSCEJSONValue])
    case object([String: CSCEJSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null; return }
        if let value = try? container.decode(Bool.self) { self = .bool(value); return }
        if let value = try? container.decode(Double.self) { self = .number(value); return }
        if let value = try? container.decode(String.self) { self = .string(value); return }
        if let value = try? container.decode([CSCEJSONValue].self) { self = .array(value); return }
        if let value = try? container.decode([String: CSCEJSONValue].self) { self = .object(value); return }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    var compactDescription: String {
        switch self {
        case .null: return "—"
        case .bool(let value): return value ? "true" : "false"
        case .number(let value): return value.rounded() == value ? String(Int(value)) : String(format: "%.3f", value)
        case .string(let value): return value
        case .array(let value): return "\(value.count) items"
        case .object(let value):
            return value.sorted { $0.key < $1.key }.prefix(4)
                .map { "\($0.key) \($0.value.compactDescription)" }.joined(separator: " · ")
        }
    }

    var operationType: String? {
        guard case .object(let value) = self,
              case .string(let type) = value["type"]
        else { return nil }
        return type
    }
}

// MARK: - Foundation document wire contract

private struct CSCESourcePin: Codable, Equatable {
    let assetId: String
    let assetVersionId: String
    let role: String
}

private struct CSCEProjectRecipe: Codable, Equatable {
    let id: String
    let version: Int
    let name: String
}

private struct CSCEERPProduct: Codable, Equatable {
    let code: String
    let name: String
    let priceBdt: Int?
    let sourceImage: String?
}

private struct CSCECompositionProject: Codable, Equatable {
    let projectId: String
    let ownerId: String
    let brandProfileId: String
    let name: String
    let folder: String
    let erpProduct: CSCEERPProduct?
    let recipe: CSCEProjectRecipe?
    let sourcePins: [CSCESourcePin]
}

private struct CSCESafeZone: Codable, Equatable, Identifiable {
    let id: String
    let label: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

private struct CSCEAspect: Codable, Equatable {
    let width: Int
    let height: Int
}

private struct CSCEResolution: Codable, Equatable {
    let width: Int
    let height: Int
}

private struct CSCECanvas: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let deliverableKind: String
    let aspect: CSCEAspect
    let resolution: CSCEResolution
    let durationMs: Int
    let safeZones: [CSCESafeZone]
    let trackIds: [String]
}

private struct CSCENode: Codable, Equatable, Identifiable {
    let id: String
    let kind: String
    var name: String
    let assetVersionId: String?
    var content: String?
}

private struct CSCETransform: Codable, Equatable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var rotation: Double
    var opacity: Double
}

private struct CSCEVolume: Codable, Equatable {
    var gainDb: Double
    var muted: Bool
}

private struct CSCEClip: Codable, Equatable, Identifiable {
    var id: String
    let nodeId: String
    var startMs: Int
    var durationMs: Int
    var sourceOffsetMs: Int
    var transform: CSCETransform?
    var volume: CSCEVolume?

    var endMs: Int { startMs + durationMs }
}

private struct CSCETrack: Codable, Equatable, Identifiable {
    let id: String
    let canvasId: String
    let kind: String
    let name: String
    let order: Int
    let locked: Bool
    let muted: Bool
    var clips: [CSCEClip]
}

private struct CSCEDocument: Codable, Equatable {
    let schemaVersion: Int
    let compositionId: String
    let documentVersion: Int
    let concurrencyToken: String
    let readonly: Bool
    let project: CSCECompositionProject
    let canvases: [CSCECanvas]
    let nodes: [CSCENode]
    let tracks: [CSCETrack]
}

private struct CSCEHistoryActivity: Decodable, Equatable, Identifiable {
    let id: String
    let kind: String
    let origin: String
    let actorId: String
    let actorName: String
    let actorRole: String
    let resultVersion: Int
    let targetBatchId: String?
    let rollbackPointId: String
    let createdAt: String
    let operationIds: [String]
}

private struct CSCERollbackPoint: Decodable, Equatable, Identifiable {
    let batchId: String
    let rollbackPointId: String
    var id: String { rollbackPointId }
}

private struct CSCEHistory: Decodable, Equatable {
    let canUndo: Bool
    let canRedo: Bool
    let undoDepth: Int
    let redoDepth: Int
    let currentUndoBatchId: String?
    let currentRedoBatchId: String?
    let latestAgentBatchId: String?
    let canRollbackLatestAgentBatch: Bool
    let rollbackPoints: [CSCERollbackPoint]
    let activity: [CSCEHistoryActivity]
}

private struct CSCEComposition: Decodable, Equatable, Identifiable {
    let id: String
    let ownerId: String
    let brandProfileId: String
    let projectId: String
    let title: String
    let sourceKind: String
    let schemaVersion: Int
    let currentVersion: Int
    let concurrencyToken: String
    let readonly: Bool
    let createdById: String
    let createdAt: String
    let updatedAt: String
    let document: CSCEDocument
    let documentHash: String
    let accessRole: String
    let history: CSCEHistory
}

private struct CSCECompositionEnvelope: Decodable { let composition: CSCEComposition }

private struct CSCEValidationEnvelope: Decodable {
    struct Validation: Decodable {
        let valid: Bool
        let batchId: String
        let requestFingerprint: String
        let expectedVersion: Int
        let resultVersion: Int
        let operationCount: Int
        let documentHash: String
        let resultConcurrencyToken: String
    }
    let validation: Validation
}

private struct CSCECommandReceipt: Decodable {
    struct Batch: Decodable {
        let id: String
        let kind: String
        let requestFingerprint: String
        let expectedVersion: Int
        let resultVersion: Int
        let operationCount: Int
        let targetBatchId: String?
        let targetVersion: Int?
    }
    struct Version: Decodable {
        let version: Int
        let concurrencyToken: String
        let documentHash: String
        let document: CSCEDocument
    }
    let idempotent: Bool
    let batch: Batch
    let version: Version
    let rollbackPointId: String
}

// MARK: - Deterministic Agent plan wire contract

private struct CSCEAgentScope: Decodable, Equatable {
    let brandProfileId: String
    let projectId: String
    let compositionId: String
}

private struct CSCEAgentOperation: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let kind: String
    let effect: String
    let estimatedCostBdt: Double
    let requiredRole: String
    let before: CSCEJSONValue
    let after: CSCEJSONValue
}

private struct CSCEAgentPendingAction: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String
    let label: String
    let state: String
    let blockedReason: String?
    let estimatedCostBdt: Double
    let maxCostBdt: Double
}

private struct CSCEAgentWarning: Decodable, Equatable, Identifiable {
    let code: String
    let message: String
    var id: String { code }
}

private struct CSCEAgentProposal: Decodable, Equatable {
    let id: String
    let origin: String
    let scope: CSCEAgentScope
    let expectedVersion: Int
    let expectedConcurrencyToken: String
    let actorRoleAtPlan: String
    let instruction: String
    let normalizedInstruction: String
    let operations: [CSCEAgentOperation]
    let pendingActions: [CSCEAgentPendingAction]
    let warnings: [CSCEAgentWarning]
    let requiresClarification: Bool
    let totalLocalCostBdt: Double
    let totalPendingCostBdt: Double
    let fingerprint: String
}

private struct CSCEAgentPlanEnvelope: Decodable {
    let proposal: CSCEAgentProposal
    let operations: [CSCEJSONValue]
    let executed: Bool
    let zeroCostOnly: Bool
}

// MARK: - Command payloads and local errors

private struct CSCEOperationCommandBody: Encodable {
    let expectedVersion: Int
    let expectedConcurrencyToken: String
    let idempotencyKey: String
    let brandProfileId: String
    let operations: [CSCEJSONValue]
}

private struct CSCEHistoryCommandBody: Encodable {
    let expectedVersion: Int
    let expectedConcurrencyToken: String
    let idempotencyKey: String
    let brandProfileId: String
    let batchId: String?
}

private struct CSCERollbackCommandBody: Encodable {
    let expectedVersion: Int
    let expectedConcurrencyToken: String
    let idempotencyKey: String
    let brandProfileId: String
    let rollbackPointId: String
}

private struct CSCEAgentPlanBody: Encodable {
    let brandProfileId: String
    let projectId: String
    let instruction: String
    let selectedTrackId: String?
    let selectedClipId: String?
    let playheadSec: Double
    let firstBeatSec: Double
}

private struct CSCEPendingMutation: Identifiable {
    let id = UUID()
    let title: String
    let summary: String
    let operations: [CSCEJSONValue]
    let expectedVersion: Int
    let expectedConcurrencyToken: String
    let idempotencyKey: String
    let requestFingerprint: String
    let agentFingerprint: String?
}

private enum CSCEEditorError: LocalizedError {
    case invalidScope
    case invalidResponse
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case .invalidScope: return "Composition active brand/project scope-এর সাথে মেলেনি।"
        case .invalidResponse: return "Foundation response contract মেলেনি।"
        case .unavailable(let message): return message
        }
    }
}

// MARK: - Editor model

@available(iOS 17.0, *)
@MainActor
@Observable
private final class CSCEEditorModel {
    let brandID: String
    let projectID: String
    let compositionID: String
    let requestedRole: String

    var composition: CSCEComposition?
    var selectedTrackID: String?
    var selectedClipID: String?
    var playheadSec: Double = 0
    var agentInstruction = ""
    var agentPlan: CSCEAgentPlanEnvelope?
    var agentAcknowledged = false
    var pendingMutation: CSCEPendingMutation?
    var loading = false
    var actionBusy = false
    var notice: String?
    var error: String?

    init(brandID: String, projectID: String, compositionID: String, role: String) {
        self.brandID = brandID
        self.projectID = projectID
        self.compositionID = compositionID
        self.requestedRole = role.lowercased()
    }

    var document: CSCEDocument? { composition?.document }
    var canvas: CSCECanvas? { document?.canvases.first }
    var effectiveRole: String { composition?.accessRole ?? requestedRole }
    var canEdit: Bool {
        guard let composition else { return false }
        return !composition.readonly
            && ["owner", "creator"].contains(effectiveRole)
    }
    var canApplyAgentPlan: Bool { canEdit && effectiveRole == "owner" }

    var agentInstructionValidationMessage: String? {
        let units = agentInstruction
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .utf16
            .count
        if units < 2 { return "Agent instruction অন্তত ২টি UTF-16 unit হতে হবে।" }
        if units > 4_000 { return "Agent instruction সর্বোচ্চ ৪,০০০ UTF-16 unit হতে পারে।" }
        return nil
    }

    var orderedTracks: [CSCETrack] {
        guard let document, let canvas else { return [] }
        let byID = Dictionary(uniqueKeysWithValues: document.tracks.map { ($0.id, $0) })
        return canvas.trackIds.compactMap { byID[$0] }
    }

    var selectedTrack: CSCETrack? {
        orderedTracks.first { $0.id == selectedTrackID }
    }

    var selectedClip: CSCEClip? {
        selectedTrack?.clips.first { $0.id == selectedClipID }
    }

    var selectedNode: CSCENode? {
        guard let clip = selectedClip else { return nil }
        return document?.nodes.first { $0.id == clip.nodeId }
    }

    func select(track: CSCETrack, clip: CSCEClip?) {
        selectedTrackID = track.id
        selectedClipID = clip?.id
        if let clip {
            playheadSec = min(Double(clip.endMs) / 1_000, max(0, Double(clip.startMs) / 1_000))
        }
        agentPlan = nil
        agentAcknowledged = false
    }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            composition = try await fetchComposition()
            seedSelection()
            error = nil
        } catch {
            self.error = message(error, fallback: "Composition লোড করা যায়নি")
        }
    }

    private func fetchComposition() async throws -> CSCEComposition {
        let response: CSCECompositionEnvelope = try await AlmaAPI.shared.get(
            "/api/assistant/creative-studio/compositions/\(compositionID)",
            query: ["brandProfileId": brandID]
        )
        let value = response.composition
        guard value.id == compositionID,
              value.brandProfileId == brandID,
              value.projectId == projectID,
              value.document.compositionId == compositionID,
              value.document.project.brandProfileId == brandID,
              value.document.project.projectId == projectID,
              value.currentVersion == value.document.documentVersion,
              value.concurrencyToken == value.document.concurrencyToken
        else { throw CSCEEditorError.invalidScope }
        return value
    }

    private func seedSelection() {
        if let track = orderedTracks.first(where: { $0.id == selectedTrackID }),
           track.clips.contains(where: { $0.id == selectedClipID }) { return }
        let track = orderedTracks.first
        selectedTrackID = track?.id
        selectedClipID = track?.clips.first?.id
    }

    private func idempotencyKey(_ kind: String) -> String {
        "ios-editor-\(kind)-\(UUID().uuidString)"
    }

    private func encodedJSON<T: Encodable>(_ value: T) throws -> CSCEJSONValue {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(CSCEJSONValue.self, from: data)
    }

    private func selection(track: CSCETrack, clip: CSCEClip) -> CSCEJSONValue {
        .object([
            "nodeIds": .array([.string(clip.nodeId)]),
            "trackIds": .array([.string(track.id)]),
            "clipIds": .array([.string(clip.id)]),
        ])
    }

    private func timeRange(startMs: Int, endMs: Int) -> CSCEJSONValue {
        .object([
            "startMs": .number(Double(startMs)),
            "endMs": .number(Double(endMs)),
        ])
    }

    private func selectedContext() throws -> (CSCETrack, CSCEClip, CSCENode) {
        guard let track = selectedTrack, let clip = selectedClip, let node = selectedNode else {
            throw CSCEEditorError.unavailable("আগে একটি clip select করুন।")
        }
        guard !track.locked else {
            throw CSCEEditorError.unavailable("Locked track edit করা যাবে না।")
        }
        return (track, clip, node)
    }

    private func milliseconds(_ seconds: Double, label: String) throws -> Int {
        guard seconds.isFinite, seconds >= 0, seconds <= 86_400 else {
            throw CSCEEditorError.unavailable("\(label) range-এর বাইরে।")
        }
        let value = Int((seconds * 1_000).rounded())
        guard value <= 86_400_000 else {
            throw CSCEEditorError.unavailable("\(label) range-এর বাইরে।")
        }
        return value
    }

    private func validateAndStage(
        title: String,
        summary: String,
        operations: [CSCEJSONValue],
        expectedVersion: Int? = nil,
        expectedConcurrencyToken: String? = nil,
        idempotency: String? = nil,
        agentFingerprint: String? = nil
    ) async {
        guard canEdit, let composition else {
            notice = "এই role composition edit করতে পারে না।"
            return
        }
        let version = expectedVersion ?? composition.currentVersion
        let token = expectedConcurrencyToken ?? composition.concurrencyToken
        guard version == composition.currentVersion, token == composition.concurrencyToken else {
            notice = "Composition বদলেছে — reload করে আবার চেষ্টা করুন।"
            return
        }
        guard !operations.isEmpty else { notice = "কোনো local operation নেই।"; return }
        let key = idempotency ?? idempotencyKey("apply")
        actionBusy = true
        defer { actionBusy = false }
        do {
            let body = CSCEOperationCommandBody(
                expectedVersion: version,
                expectedConcurrencyToken: token,
                idempotencyKey: key,
                brandProfileId: brandID,
                operations: operations
            )
            let response: CSCEValidationEnvelope = try await AlmaAPI.shared.send(
                "POST",
                "/api/assistant/creative-studio/compositions/\(compositionID)/operations/validate",
                body: body
            )
            let validation = response.validation
            guard validation.valid,
                  validation.expectedVersion == version,
                  validation.resultVersion == version + 1,
                  validation.operationCount == operations.count
            else { throw CSCEEditorError.invalidResponse }
            pendingMutation = CSCEPendingMutation(
                title: title,
                summary: summary,
                operations: operations,
                expectedVersion: version,
                expectedConcurrencyToken: token,
                idempotencyKey: key,
                requestFingerprint: validation.requestFingerprint,
                agentFingerprint: agentFingerprint
            )
            notice = "Server validation pass — apply করার আগে confirm করুন।"
        } catch {
            self.error = message(error, fallback: "Operation validate হয়নি")
        }
    }

    func applyPendingMutation(_ pending: CSCEPendingMutation) async {
        guard let current = composition else { return }
        guard canEdit,
              pending.expectedVersion == current.currentVersion,
              pending.expectedConcurrencyToken == current.concurrencyToken
        else {
            pendingMutation = nil
            notice = "Validated plan stale হয়েছে — reload করে আবার review করুন।"
            return
        }
        actionBusy = true
        defer { actionBusy = false }
        do {
            let body = CSCEOperationCommandBody(
                expectedVersion: pending.expectedVersion,
                expectedConcurrencyToken: pending.expectedConcurrencyToken,
                idempotencyKey: pending.idempotencyKey,
                brandProfileId: brandID,
                operations: pending.operations
            )
            let receipt: CSCECommandReceipt = try await AlmaAPI.shared.send(
                "POST",
                "/api/assistant/creative-studio/compositions/\(compositionID)/operations/apply",
                body: body
            )
            guard receipt.batch.kind == "APPLY",
                  receipt.batch.expectedVersion == pending.expectedVersion,
                  receipt.batch.resultVersion == pending.expectedVersion + 1,
                  receipt.batch.operationCount == pending.operations.count,
                  receipt.batch.requestFingerprint == pending.requestFingerprint,
                  receipt.version.version == receipt.batch.resultVersion,
                  receipt.version.version == receipt.version.document.documentVersion,
                  receipt.version.concurrencyToken == receipt.version.document.concurrencyToken,
                  receipt.version.document.compositionId == compositionID,
                  receipt.version.document.project.projectId == projectID,
                  receipt.version.document.project.brandProfileId == brandID,
                  !receipt.rollbackPointId.isEmpty
            else { throw CSCEEditorError.invalidResponse }
            pendingMutation = nil
            agentPlan = nil
            agentAcknowledged = false
            composition = try await fetchComposition()
            seedSelection()
            error = nil
            notice = "Reversible ৳0 edit v\(receipt.version.version)-এ apply হয়েছে।"
        } catch {
            self.error = message(error, fallback: "Edit apply হয়নি")
        }
    }

    func runHistory(_ kind: String) async {
        guard canEdit, let composition else { return }
        guard kind == "undo" || kind == "redo" else { return }
        let target = kind == "undo"
            ? composition.history.currentUndoBatchId
            : composition.history.currentRedoBatchId
        guard let target else {
            notice = "\(kind.capitalized) target আর current নেই — reload করুন।"
            return
        }
        actionBusy = true
        defer { actionBusy = false }
        do {
            let body = CSCEHistoryCommandBody(
                expectedVersion: composition.currentVersion,
                expectedConcurrencyToken: composition.concurrencyToken,
                idempotencyKey: idempotencyKey(kind),
                brandProfileId: brandID,
                batchId: target
            )
            let receipt: CSCECommandReceipt = try await AlmaAPI.shared.send(
                "POST",
                "/api/assistant/creative-studio/compositions/\(compositionID)/\(kind)",
                body: body
            )
            let expectedKind = kind == "undo" ? "UNDO" : "REDO"
            guard receipt.batch.kind == expectedKind,
                  receipt.batch.expectedVersion == composition.currentVersion,
                  receipt.batch.resultVersion == composition.currentVersion + 1,
                  receipt.batch.targetBatchId == target,
                  receipt.version.version == receipt.batch.resultVersion,
                  receipt.version.version == receipt.version.document.documentVersion,
                  receipt.version.concurrencyToken == receipt.version.document.concurrencyToken
            else { throw CSCEEditorError.invalidResponse }
            self.composition = try await fetchComposition()
            seedSelection()
            agentPlan = nil
            agentAcknowledged = false
            notice = "\(kind.capitalized) নতুন version হিসেবে record হয়েছে।"
        } catch {
            self.error = message(error, fallback: "\(kind.capitalized) করা যায়নি")
        }
    }

    func rollbackLatestAgentBatch() async {
        guard canEdit, let composition,
              let batchID = composition.history.latestAgentBatchId,
              composition.history.canRollbackLatestAgentBatch,
              let point = composition.history.rollbackPoints.first(where: { $0.batchId == batchID })
        else { notice = "Agent rollback point নেই।"; return }
        actionBusy = true
        defer { actionBusy = false }
        do {
            let body = CSCERollbackCommandBody(
                expectedVersion: composition.currentVersion,
                expectedConcurrencyToken: composition.concurrencyToken,
                idempotencyKey: idempotencyKey("rollback"),
                brandProfileId: brandID,
                rollbackPointId: point.rollbackPointId
            )
            let receipt: CSCECommandReceipt = try await AlmaAPI.shared.send(
                "POST",
                "/api/assistant/creative-studio/compositions/\(compositionID)/rollback",
                body: body
            )
            guard receipt.batch.kind == "ROLLBACK",
                  receipt.batch.expectedVersion == composition.currentVersion,
                  receipt.batch.resultVersion == composition.currentVersion + 1,
                  receipt.version.version == receipt.batch.resultVersion,
                  receipt.version.version == receipt.version.document.documentVersion,
                  receipt.version.concurrencyToken == receipt.version.document.concurrencyToken
            else { throw CSCEEditorError.invalidResponse }
            self.composition = try await fetchComposition()
            seedSelection()
            agentPlan = nil
            agentAcknowledged = false
            notice = "Latest Agent batch rollback হয়েছে।"
        } catch {
            self.error = message(error, fallback: "Rollback করা যায়নি")
        }
    }

    func buildAgentPlan() async {
        guard let composition else { return }
        let instruction = agentInstruction.trimmingCharacters(in: .whitespacesAndNewlines)
        if let validation = agentInstructionValidationMessage {
            error = validation
            return
        }
        actionBusy = true
        defer { actionBusy = false }
        do {
            let body = CSCEAgentPlanBody(
                brandProfileId: brandID,
                projectId: projectID,
                instruction: instruction,
                selectedTrackId: selectedTrackID,
                selectedClipId: selectedClipID,
                playheadSec: playheadSec,
                firstBeatSec: 1.2
            )
            let response: CSCEAgentPlanEnvelope = try await AlmaAPI.shared.send(
                "POST",
                "/api/assistant/creative-studio/compositions/\(compositionID)/agent-plan",
                body: body
            )
            let proposal = response.proposal
            guard !response.executed,
                  response.zeroCostOnly,
                  proposal.origin == "agent",
                  proposal.scope.brandProfileId == brandID,
                  proposal.scope.projectId == projectID,
                  proposal.scope.compositionId == compositionID,
                  proposal.expectedVersion == composition.currentVersion,
                  proposal.expectedConcurrencyToken == composition.concurrencyToken,
                  proposal.actorRoleAtPlan == composition.accessRole,
                  proposal.totalLocalCostBdt == 0,
                  proposal.operations.allSatisfy({
                      $0.effect == "local_reversible"
                          && $0.estimatedCostBdt == 0
                          && ["owner", "creator"].contains($0.requiredRole)
                  }),
                  proposal.operations.count <= response.operations.count
            else { throw CSCEEditorError.invalidResponse }
            agentPlan = response
            agentAcknowledged = false
            error = nil
            notice = "Agent plan তৈরি হয়েছে; কোনো operation চালেনি।"
        } catch {
            self.error = message(error, fallback: "Agent plan তৈরি হয়নি")
        }
    }

    func validateAgentPlanForConfirmation() async {
        guard canApplyAgentPlan else {
            notice = "Agent plan apply শুধু authenticated owner করতে পারেন।"
            return
        }
        guard agentAcknowledged, let plan = agentPlan else {
            notice = "Exact Agent fingerprint acknowledge করুন।"
            return
        }
        let proposal = plan.proposal
        guard !proposal.requiresClarification, !plan.operations.isEmpty else {
            notice = "Plan-এ safe local operation নেই বা clarification দরকার।"
            return
        }
        let prefix = "csplan-v1-"
        guard proposal.fingerprint.hasPrefix(prefix) else {
            error = "Agent fingerprint invalid।"
            return
        }
        let digest = String(proposal.fingerprint.dropFirst(prefix.count))
        guard digest.range(
            of: "^[0-9a-f]{64}$",
            options: .regularExpression
        ) != nil else { error = "Agent fingerprint invalid।"; return }
        await validateAndStage(
            title: "Agent plan apply",
            summary: "\(proposal.operations.count) reversible local edit · \(proposal.pendingActions.count) pending action চলবে না · \(String(proposal.fingerprint.prefix(22)))…",
            operations: plan.operations,
            expectedVersion: proposal.expectedVersion,
            expectedConcurrencyToken: proposal.expectedConcurrencyToken,
            idempotency: "editor-agent-apply-\(digest)",
            agentFingerprint: proposal.fingerprint
        )
    }

    // MARK: Seven production local edit classes

    func reviewCaptionText(_ raw: String) async {
        do {
            let (track, clip, sourceNode) = try selectedContext()
            guard sourceNode.kind == "caption" || sourceNode.kind == "text" else {
                throw CSCEEditorError.unavailable("Selected clip caption নয়।")
            }
            let references = document?.tracks.reduce(0) { total, candidate in
                total + candidate.clips.filter { $0.nodeId == sourceNode.id }.count
            } ?? 0
            guard references == 1 else {
                throw CSCEEditorError.unavailable("Shared caption node safely edit করা যায় না।")
            }
            let text = String(raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
            guard !text.isEmpty else { throw CSCEEditorError.unavailable("Caption text দিন।") }
            var node = sourceNode
            node.content = text
            node.name = String(text.prefix(72))
            let operation: CSCEJSONValue = .object([
                "type": .string("node.replace"),
                "nodeId": .string(node.id),
                "node": try encodedJSON(node),
                "selection": selection(track: track, clip: clip),
            ])
            await validateAndStage(
                title: "Caption text",
                summary: "\(sourceNode.content ?? "—") → \(text)",
                operations: [operation]
            )
        } catch { self.error = message(error, fallback: "Caption edit প্রস্তুত হয়নি") }
    }

    func reviewCaptionTiming(startSec: Double, endSec: Double) async {
        do {
            let (track, sourceClip, node) = try selectedContext()
            guard node.kind == "caption" || node.kind == "text" else {
                throw CSCEEditorError.unavailable("Selected clip caption নয়।")
            }
            let startMs = try milliseconds(startSec, label: "Start")
            let endMs = try milliseconds(endSec, label: "End")
            guard endMs > startMs else { throw CSCEEditorError.unavailable("End অবশ্যই start-এর পরে হবে।") }
            var clip = sourceClip
            clip.startMs = startMs
            clip.durationMs = endMs - startMs
            let operation: CSCEJSONValue = .object([
                "type": .string("clip.replace"),
                "trackId": .string(track.id),
                "clipId": .string(sourceClip.id),
                "clip": try encodedJSON(clip),
                "selection": selection(track: track, clip: sourceClip),
                "timeRange": timeRange(startMs: startMs, endMs: endMs),
            ])
            await validateAndStage(
                title: "Caption timing",
                summary: String(format: "%.2fs–%.2fs → %.2fs–%.2fs", Double(sourceClip.startMs) / 1_000, Double(sourceClip.endMs) / 1_000, startSec, endSec),
                operations: [operation]
            )
        } catch { self.error = message(error, fallback: "Caption timing প্রস্তুত হয়নি") }
    }

    func reviewTrim(startSec: Double, endSec: Double) async {
        do {
            let (track, sourceClip, node) = try selectedContext()
            guard node.kind == "video" || node.kind == "image" else {
                throw CSCEEditorError.unavailable("Trim শুধু visual clip-এ করা যায়।")
            }
            let startMs = try milliseconds(startSec, label: "Trim start")
            let endMs = try milliseconds(endSec, label: "Trim end")
            guard startMs >= sourceClip.startMs,
                  endMs <= sourceClip.endMs,
                  endMs - startMs >= 200
            else { throw CSCEEditorError.unavailable("Trim range clip-এর ভেতরে অন্তত 0.2s হতে হবে।") }
            var clip = sourceClip
            clip.sourceOffsetMs += startMs - sourceClip.startMs
            clip.startMs = startMs
            clip.durationMs = endMs - startMs
            let operation: CSCEJSONValue = .object([
                "type": .string("clip.replace"),
                "trackId": .string(track.id),
                "clipId": .string(sourceClip.id),
                "clip": try encodedJSON(clip),
                "selection": selection(track: track, clip: sourceClip),
                "timeRange": timeRange(startMs: startMs, endMs: endMs),
            ])
            await validateAndStage(
                title: "Trim clip",
                summary: String(format: "%.2fs–%.2fs → %.2fs–%.2fs", Double(sourceClip.startMs) / 1_000, Double(sourceClip.endMs) / 1_000, startSec, endSec),
                operations: [operation]
            )
        } catch { self.error = message(error, fallback: "Trim প্রস্তুত হয়নি") }
    }

    func reviewSplit(at seconds: Double) async {
        do {
            let (track, sourceClip, node) = try selectedContext()
            guard node.kind == "video" || node.kind == "image" else {
                throw CSCEEditorError.unavailable("Split শুধু visual clip-এ করা যায়।")
            }
            let splitMs = try milliseconds(seconds, label: "Split point")
            guard splitMs - sourceClip.startMs >= 200,
                  sourceClip.endMs - splitMs >= 200
            else { throw CSCEEditorError.unavailable("Split point দুই edge থেকে অন্তত 0.2s দূরে দিন।") }
            guard let index = track.clips.firstIndex(where: { $0.id == sourceClip.id }) else {
                throw CSCEEditorError.invalidResponse
            }
            var left = sourceClip
            left.durationMs = splitMs - sourceClip.startMs
            var right = sourceClip
            right.id = "iossplit_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
            right.startMs = splitMs
            right.durationMs = sourceClip.endMs - splitMs
            right.sourceOffsetMs = sourceClip.sourceOffsetMs + left.durationMs
            let meta = selection(track: track, clip: sourceClip)
            let range = timeRange(startMs: sourceClip.startMs, endMs: sourceClip.endMs)
            let operations: [CSCEJSONValue] = [
                .object([
                    "type": .string("clip.remove"),
                    "trackId": .string(track.id),
                    "clipId": .string(sourceClip.id),
                    "selection": meta,
                    "timeRange": range,
                ]),
                .object([
                    "type": .string("clip.insert"),
                    "trackId": .string(track.id),
                    "clip": try encodedJSON(left),
                    "index": .number(Double(index)),
                    "selection": meta,
                    "timeRange": range,
                ]),
                .object([
                    "type": .string("clip.insert"),
                    "trackId": .string(track.id),
                    "clip": try encodedJSON(right),
                    "index": .number(Double(index + 1)),
                    "selection": meta,
                    "timeRange": range,
                ]),
            ]
            await validateAndStage(
                title: "Split clip",
                summary: String(format: "%@ at %.2fs → %@ + %@", sourceClip.id, seconds, left.id, right.id),
                operations: operations
            )
        } catch { self.error = message(error, fallback: "Split প্রস্তুত হয়নি") }
    }

    func reviewMove(direction: Int) async {
        do {
            let (sourceTrack, sourceClip, _) = try selectedContext()
            guard let index = sourceTrack.clips.firstIndex(where: { $0.id == sourceClip.id }) else {
                throw CSCEEditorError.invalidResponse
            }
            let nextIndex = index + direction
            guard nextIndex >= 0, nextIndex < sourceTrack.clips.count else { return }
            var track = sourceTrack
            let moved = track.clips.remove(at: index)
            track.clips.insert(moved, at: nextIndex)
            let operation: CSCEJSONValue = .object([
                "type": .string("track.replace"),
                "trackId": .string(sourceTrack.id),
                "track": try encodedJSON(track),
                "selection": selection(track: sourceTrack, clip: sourceClip),
            ])
            await validateAndStage(
                title: "Move clip",
                summary: "Index \(index) → \(nextIndex)",
                operations: [operation]
            )
        } catch { self.error = message(error, fallback: "Move প্রস্তুত হয়নি") }
    }

    func reviewTransform(x: Double, y: Double, scale: Double, rotation: Double, opacity: Double) async {
        do {
            let (track, sourceClip, _) = try selectedContext()
            guard let current = sourceClip.transform else {
                throw CSCEEditorError.unavailable("Selected clip-এর visual transform নেই।")
            }
            guard (-2...2).contains(x), (-2...2).contains(y), (0.1...4).contains(scale),
                  (-360...360).contains(rotation), (0...1).contains(opacity)
            else { throw CSCEEditorError.unavailable("Transform value safe range-এর বাইরে।") }
            let currentScale = (current.width * current.height).squareRoot()
            guard currentScale > 0 else { throw CSCEEditorError.invalidResponse }
            let ratio = scale / currentScale
            let width = current.width * ratio
            let height = current.height * ratio
            guard width > 0, height > 0, width <= 20, height <= 20 else {
                throw CSCEEditorError.unavailable("Scale Foundation limit-এর বাইরে।")
            }
            var clip = sourceClip
            clip.transform = CSCETransform(x: x, y: y, width: width, height: height, rotation: rotation, opacity: opacity)
            let operation: CSCEJSONValue = .object([
                "type": .string("clip.replace"),
                "trackId": .string(track.id),
                "clipId": .string(sourceClip.id),
                "clip": try encodedJSON(clip),
                "selection": selection(track: track, clip: sourceClip),
            ])
            await validateAndStage(
                title: "Transform clip",
                summary: String(format: "x %.2f · y %.2f · scale %.2f · rot %.0f° · opacity %.0f%%", x, y, scale, rotation, opacity * 100),
                operations: [operation]
            )
        } catch { self.error = message(error, fallback: "Transform প্রস্তুত হয়নি") }
    }

    func reviewVolume(_ value: Double) async {
        do {
            let (track, sourceClip, _) = try selectedContext()
            guard ["video", "voice", "music", "sfx"].contains(track.kind), (0...1).contains(value) else {
                throw CSCEEditorError.unavailable("Selected track-এ volume edit করা যায় না।")
            }
            var clip = sourceClip
            clip.volume = value == 0
                ? CSCEVolume(gainDb: -96, muted: true)
                : CSCEVolume(gainDb: max(-96, min(0, 20 * log10(value))), muted: false)
            let operation: CSCEJSONValue = .object([
                "type": .string("clip.replace"),
                "trackId": .string(track.id),
                "clipId": .string(sourceClip.id),
                "clip": try encodedJSON(clip),
                "selection": selection(track: track, clip: sourceClip),
            ])
            await validateAndStage(
                title: "Track volume",
                summary: String(format: "Volume → %.0f%%", value * 100),
                operations: [operation]
            )
        } catch { self.error = message(error, fallback: "Volume change প্রস্তুত হয়নি") }
    }

    private func message(_ error: Error, fallback: String) -> String {
        if let editor = error as? CSCEEditorError { return editor.localizedDescription }
        if let api = error as? AlmaAPIError {
            switch api {
            case .notAuthenticated: return "সেশন শেষ — আবার লগইন করুন।"
            case .http(_, let body):
                if let data = body.data(using: .utf8),
                   let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    return (object["message"] as? String) ?? (object["error"] as? String) ?? fallback
                }
            default: break
            }
        }
        return fallback
    }
}

// MARK: - Native composition editor screen

@available(iOS 17.0, *)
struct CreativeStudioCompositionEditorScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var model: CSCEEditorModel
    @State private var captionText = ""
    @State private var rangeStartSec: Double = 0
    @State private var rangeEndSec: Double = 1
    @State private var splitSec: Double = 0.5
    @State private var transformX: Double = 0
    @State private var transformY: Double = 0
    @State private var transformScale: Double = 1
    @State private var transformRotation: Double = 0
    @State private var transformOpacity: Double = 1
    @State private var volume: Double = 1

    init(brandID: String, projectID: String, compositionID: String, role: String) {
        _model = State(initialValue: CSCEEditorModel(
            brandID: brandID,
            projectID: projectID,
            compositionID: compositionID,
            role: role
        ))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                background.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let composition = model.composition {
                            identityCard(composition)
                            historyControls(composition)
                            canvasCard
                            trackBrowser
                            inspector
                            agentPanel
                            activityCard(composition)
                        } else if !model.loading {
                            ContentUnavailableView(
                                "Composition unavailable",
                                systemImage: "rectangle.3.group.bubble.left",
                                description: Text(model.error ?? "Foundation composition পাওয়া যায়নি।")
                            )
                        }
                        Color.clear.frame(height: 28)
                    }
                    .padding(16)
                }
                if model.loading {
                    ProgressView("Versioned composition লোড হচ্ছে…")
                        .padding(18)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18))
                }
            }
            .navigationTitle("Composition Editor")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await model.load(); seedInspector() }
                    } label: { Image(systemName: "arrow.clockwise") }
                    .disabled(model.loading || model.actionBusy)
                }
            }
        }
        .task {
            await model.load()
            seedInspector()
        }
        .onChange(of: model.selectedClipID) { _, _ in seedInspector() }
        .onChange(of: model.composition?.currentVersion) { _, _ in seedInspector() }
        .alert("Validated edit apply করবেন?", isPresented: Binding(
            get: { model.pendingMutation != nil },
            set: { if !$0 { model.pendingMutation = nil } }
        )) {
            Button("বাতিল", role: .cancel) { model.pendingMutation = nil }
            Button("Confirm ৳0 Apply") {
                guard let pending = model.pendingMutation else { return }
                Task { await model.applyPendingMutation(pending) }
            }
        } message: {
            if let pending = model.pendingMutation {
                Text(
                    "\(pending.title)\n\(pending.summary)"
                    + (pending.agentFingerprint.map { "\nAgent fingerprint: \($0)" } ?? "")
                    + "\nServer validation fingerprint: \(pending.requestFingerprint)"
                    + "\nProvider/render/publish কিছুই চলবে না।"
                )
            }
        }
        .alert("Composition Editor", isPresented: Binding(
            get: { model.error != nil },
            set: { if !$0 { model.error = nil } }
        )) {
            Button("ঠিক আছে", role: .cancel) { model.error = nil }
        } message: { Text(model.error ?? "") }
        .overlay(alignment: .top) {
            if let notice = model.notice {
                Text(notice)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(.black.opacity(0.82), in: Capsule())
                    .padding(.top, 8)
                    .task {
                        try? await Task.sleep(for: .seconds(3))
                        if model.notice == notice { model.notice = nil }
                    }
            }
        }
    }

    private var background: some View {
        LinearGradient(
            colors: colorScheme == .dark
                ? [Color(red: 0.05, green: 0.06, blue: 0.09), Color(red: 0.10, green: 0.06, blue: 0.08)]
                : [Color(red: 0.96, green: 0.95, blue: 0.94), Color(red: 0.94, green: 0.91, blue: 0.90)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private func identityCard(_ composition: CSCEComposition) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(composition.title).font(.headline)
                    Text("\(composition.document.project.name) · \(composition.document.project.erpProduct?.code ?? "No ERP product")")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text("v\(composition.currentVersion)")
                    .font(.caption.monospacedDigit().weight(.bold))
                    .padding(.horizontal, 9).padding(.vertical, 5)
                    .background(Color.orange.opacity(0.16), in: Capsule())
            }
            HStack(spacing: 8) {
                Label(composition.accessRole.capitalized, systemImage: "person.badge.shield.checkmark")
                Label(composition.readonly ? "Read only" : "Versioned", systemImage: composition.readonly ? "lock.fill" : "checkmark.shield.fill")
                Label("৳0 local only", systemImage: "banknote.fill")
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            if composition.accessRole != model.requestedRole {
                Label("Server role \(composition.accessRole) authoritative; caller role ignored.", systemImage: "exclamationmark.shield")
                    .font(.caption2).foregroundStyle(.orange)
            }
            if !model.canEdit {
                Text("Reviewer/read-only preview: inspector দেখা যাবে, mutation disabled।")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
        .padding(14).csceCard()
    }

    private func historyControls(_ composition: CSCEComposition) -> some View {
        HStack(spacing: 10) {
            Button {
                Task { await model.runHistory("undo") }
            } label: { Label("Undo \(composition.history.undoDepth)", systemImage: "arrow.uturn.backward") }
                .disabled(!model.canEdit || !composition.history.canUndo || model.actionBusy)
            Button {
                Task { await model.runHistory("redo") }
            } label: { Label("Redo \(composition.history.redoDepth)", systemImage: "arrow.uturn.forward") }
                .disabled(!model.canEdit || !composition.history.canRedo || model.actionBusy)
            Spacer()
            Button(role: .destructive) {
                Task { await model.rollbackLatestAgentBatch() }
            } label: { Label("Agent rollback", systemImage: "clock.arrow.circlepath") }
                .disabled(!model.canEdit || !composition.history.canRollbackLatestAgentBatch || model.actionBusy)
        }
        .font(.caption.weight(.bold))
        .buttonStyle(.bordered)
    }

    private var canvasCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Canvas", icon: "rectangle.on.rectangle.angled")
            if let canvas = model.canvas {
                HStack {
                    Text("\(canvas.name) · \(canvas.deliverableKind)").font(.subheadline.weight(.semibold))
                    Spacer()
                    Text("\(canvas.resolution.width)×\(canvas.resolution.height) · \(canvas.aspect.width):\(canvas.aspect.height) · \(String(format: "%.1fs", Double(canvas.durationMs) / 1_000))")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                GeometryReader { proxy in
                    let ratio = CGFloat(canvas.aspect.width) / CGFloat(max(1, canvas.aspect.height))
                    let availableHeight = min(340, proxy.size.height)
                    let fittedWidth = min(proxy.size.width, availableHeight * ratio)
                    let fittedHeight = fittedWidth / ratio
                    ZStack {
                        RoundedRectangle(cornerRadius: 18)
                            .fill(LinearGradient(colors: [.black.opacity(0.86), .gray.opacity(0.42)], startPoint: .top, endPoint: .bottom))
                        ForEach(Array(model.orderedTracks.enumerated()), id: \.element.id) { index, track in
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(track.id == model.selectedTrackID ? Color.orange : Color.white.opacity(0.18), lineWidth: track.id == model.selectedTrackID ? 2 : 1)
                                .padding(CGFloat(14 + index * 7))
                                .overlay(alignment: .topLeading) {
                                    Text(track.name)
                                        .font(.system(size: 8, weight: .bold))
                                        .foregroundStyle(track.id == model.selectedTrackID ? Color.orange : Color.white.opacity(0.65))
                                        .padding(CGFloat(18 + index * 7))
                                }
                        }
                        ForEach(canvas.safeZones) { zone in
                            Rectangle()
                                .stroke(Color.green.opacity(0.55), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                                .frame(width: fittedWidth * zone.width, height: fittedHeight * zone.height)
                                .position(x: fittedWidth * (zone.x + zone.width / 2), y: fittedHeight * (zone.y + zone.height / 2))
                        }
                        if let node = model.selectedNode {
                            VStack(spacing: 4) {
                                Image(systemName: node.kind == "caption" || node.kind == "text" ? "captions.bubble.fill" : "photo.on.rectangle.angled")
                                Text(node.name).font(.caption.weight(.bold)).lineLimit(2)
                            }.foregroundStyle(.white).padding(12)
                        }
                    }
                    .frame(width: fittedWidth, height: fittedHeight)
                    .position(x: proxy.size.width / 2, y: max(fittedHeight / 2, 1))
                }
                .frame(height: 350)
            }
        }
        .padding(14).csceCard()
    }

    private var trackBrowser: some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Tracks & clips", icon: "timeline.selection")
            if model.orderedTracks.isEmpty {
                Text("Track নেই।").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(model.orderedTracks) { track in
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Label(track.name, systemImage: trackIcon(track.kind)).font(.subheadline.weight(.semibold))
                        Spacer()
                        if track.locked { Image(systemName: "lock.fill") }
                        if track.muted { Image(systemName: "speaker.slash.fill") }
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(track.clips) { clip in
                                let node = model.document?.nodes.first { $0.id == clip.nodeId }
                                Button {
                                    model.select(track: track, clip: clip)
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(node?.name ?? clip.id).font(.caption.weight(.bold)).lineLimit(1)
                                        Text(String(format: "%.2f–%.2fs", Double(clip.startMs) / 1_000, Double(clip.endMs) / 1_000))
                                            .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                                    }
                                    .frame(width: 142, alignment: .leading)
                                    .padding(10)
                                    .background(
                                        model.selectedClipID == clip.id ? Color.orange.opacity(0.18) : Color.primary.opacity(0.045),
                                        in: RoundedRectangle(cornerRadius: 11)
                                    )
                                    .overlay(RoundedRectangle(cornerRadius: 11).stroke(model.selectedClipID == clip.id ? Color.orange : Color.clear))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(11)
                .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 13))
            }
        }
        .padding(14).csceCard()
    }

    @ViewBuilder private var inspector: some View {
        if let track = model.selectedTrack, let clip = model.selectedClip, let node = model.selectedNode {
            VStack(alignment: .leading, spacing: 14) {
                sectionTitle("Clip inspector", icon: "slider.horizontal.3")
                HStack {
                    VStack(alignment: .leading) {
                        Text(node.name).font(.headline)
                        Text("\(track.kind) · \(clip.id)").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(track.locked ? "Locked" : "Reversible")
                        .font(.caption2.weight(.bold)).foregroundStyle(track.locked ? .orange : .green)
                }

                if node.kind == "caption" || node.kind == "text" {
                    GroupBox("Caption text · caption.text.set") {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("Caption", text: $captionText, axis: .vertical).textFieldStyle(.roundedBorder)
                            Button("Validate caption text") {
                                Task { await model.reviewCaptionText(captionText) }
                            }.buttonStyle(.borderedProminent).tint(.orange)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    timingEditor(title: "Caption timing · caption.timing.set") {
                        Task { await model.reviewCaptionTiming(startSec: rangeStartSec, endSec: rangeEndSec) }
                    }
                }

                if node.kind == "video" || node.kind == "image" {
                    timingEditor(title: "Clip trim · clip.trim") {
                        Task { await model.reviewTrim(startSec: rangeStartSec, endSec: rangeEndSec) }
                    }
                    GroupBox("Split · clip.split") {
                        HStack {
                            TextField("Seconds", value: $splitSec, format: .number.precision(.fractionLength(2)))
                                .textFieldStyle(.roundedBorder).keyboardType(.decimalPad)
                            Button("Validate split") { Task { await model.reviewSplit(at: splitSec) } }
                                .buttonStyle(.borderedProminent).tint(.orange)
                        }
                    }
                }

                GroupBox("Order · clip.move") {
                    HStack {
                        Button { Task { await model.reviewMove(direction: -1) } } label: { Label("Earlier", systemImage: "arrow.left") }
                        Button { Task { await model.reviewMove(direction: 1) } } label: { Label("Later", systemImage: "arrow.right") }
                    }.buttonStyle(.bordered)
                }

                if clip.transform != nil {
                    transformEditor
                }

                if ["video", "voice", "music", "sfx"].contains(track.kind) {
                    GroupBox("Volume · track.volume.set") {
                        VStack(spacing: 8) {
                            HStack { Slider(value: $volume, in: 0...1); Text("\(Int(volume * 100))%").font(.caption.monospacedDigit()) }
                            Button("Validate volume") { Task { await model.reviewVolume(volume) } }
                                .buttonStyle(.borderedProminent).tint(.orange)
                        }
                    }
                }
            }
            .disabled(!model.canEdit || model.actionBusy || track.locked)
            .padding(14).csceCard()
        } else {
            Text("Inspect করতে একটি clip select করুন।")
                .font(.caption).foregroundStyle(.secondary).padding(14).csceCard()
        }
    }

    private func timingEditor(title: String, action: @escaping () -> Void) -> some View {
        GroupBox(title) {
            VStack(spacing: 8) {
                HStack {
                    TextField("Start", value: $rangeStartSec, format: .number.precision(.fractionLength(2)))
                        .textFieldStyle(.roundedBorder).keyboardType(.decimalPad)
                    TextField("End", value: $rangeEndSec, format: .number.precision(.fractionLength(2)))
                        .textFieldStyle(.roundedBorder).keyboardType(.decimalPad)
                }
                Button("Server validate") { action() }.buttonStyle(.borderedProminent).tint(.orange)
            }
        }
    }

    private var transformEditor: some View {
        GroupBox("Transform · node.transform.set") {
            VStack(alignment: .leading, spacing: 9) {
                valueSlider("X", value: $transformX, range: -2...2)
                valueSlider("Y", value: $transformY, range: -2...2)
                valueSlider("Scale", value: $transformScale, range: 0.1...4)
                valueSlider("Rotation", value: $transformRotation, range: -360...360)
                valueSlider("Opacity", value: $transformOpacity, range: 0...1)
                Button("Validate transform") {
                    Task {
                        await model.reviewTransform(
                            x: transformX, y: transformY, scale: transformScale,
                            rotation: transformRotation, opacity: transformOpacity
                        )
                    }
                }.buttonStyle(.borderedProminent).tint(.orange)
            }
        }
    }

    private func valueSlider(_ label: String, value: Binding<Double>, range: ClosedRange<Double>) -> some View {
        HStack {
            Text(label).font(.caption).frame(width: 58, alignment: .leading)
            Slider(value: value, in: range)
            Text(String(format: "%.2f", value.wrappedValue)).font(.caption2.monospacedDigit()).frame(width: 48)
        }
    }

    private var agentPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                sectionTitle("Creative Agent", icon: "sparkles.rectangle.stack")
                Spacer()
                Text("PLAN ONLY").font(.caption2.weight(.black)).foregroundStyle(.orange)
            }
            Text("Bangla/English instruction deterministicভাবে compile হবে। Paid generation, voice, render ও publish শুধু blocked/pending হিসেবে দেখা যাবে—execute হবে না।")
                .font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $model.agentInstruction)
                .frame(minHeight: 92)
                .padding(7)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.primary.opacity(0.08)))
            HStack(alignment: .firstTextBaseline) {
                if let validation = model.agentInstructionValidationMessage {
                    Text(validation).foregroundStyle(.orange)
                }
                Spacer()
                Text("\(model.agentInstruction.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count)/4000")
                    .monospacedDigit()
            }
            .font(.caption2)
            HStack {
                Text("Playhead \(String(format: "%.2fs", model.playheadSec))").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Spacer()
                Button(model.agentPlan == nil ? "Build plan" : "Re-plan") {
                    Task { await model.buildAgentPlan() }
                }
                .buttonStyle(.borderedProminent).tint(.orange)
                .disabled(model.actionBusy || model.agentInstructionValidationMessage != nil)
            }

            if let plan = model.agentPlan {
                Divider()
                HStack {
                    VStack(alignment: .leading) {
                        Text("\(plan.proposal.operations.count) local · \(plan.proposal.pendingActions.count) pending")
                            .font(.subheadline.weight(.bold))
                        Text("base v\(plan.proposal.expectedVersion) · \(String(plan.proposal.fingerprint.prefix(24)))…")
                            .font(.caption2.monospaced()).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(plan.proposal.totalLocalCostBdt == 0 ? "৳0" : "Blocked")
                        .font(.caption.weight(.black)).foregroundStyle(.green)
                }
                Text(plan.proposal.fingerprint)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                if plan.proposal.requiresClarification {
                    Label("Plan clarification দরকার; apply disabled।", systemImage: "exclamationmark.bubble.fill")
                        .font(.caption).foregroundStyle(.orange)
                }
                ForEach(plan.proposal.warnings) { warning in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(warning.code).font(.caption2.weight(.bold)).foregroundStyle(.orange)
                        Text(warning.message).font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(9).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                }
                ForEach(plan.proposal.operations) { operation in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack { Text(operation.label).font(.caption.weight(.bold)); Spacer(); Text("৳0").font(.caption2).foregroundStyle(.green) }
                        Text(operation.kind).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        Text("\(operation.before.compactDescription) → \(operation.after.compactDescription)")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(10).background(Color.green.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                }
                if !plan.operations.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Raw Foundation operations · \(plan.operations.count)")
                            .font(.caption.weight(.bold))
                        ForEach(Array(plan.operations.enumerated()), id: \.offset) { index, operation in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(index + 1). \(operation.operationType ?? "operation")")
                                    .font(.caption2.monospaced().weight(.semibold))
                                Text(operation.compactDescription)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(3)
                            }
                        }
                    }
                    .padding(10)
                    .background(Color.blue.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                }
                ForEach(plan.proposal.pendingActions) { action in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack { Label(action.label, systemImage: "lock.fill").font(.caption.weight(.bold)); Spacer(); Text(action.state).font(.caption2) }
                        Text("\(action.kind) · \(action.blockedReason ?? "separate confirmation") · estimated ৳\(Int(action.estimatedCostBdt))")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(10).background(Color.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                }
                Toggle(isOn: $model.agentAcknowledged) {
                    VStack(alignment: .leading) {
                        Text("Exact fingerprint reviewed").font(.caption.weight(.bold))
                        Text("শুধু listed reversible ৳0 operations apply হবে।").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .disabled(!model.canApplyAgentPlan || plan.proposal.requiresClarification || plan.operations.isEmpty)
                Button("Validate & review Agent apply") {
                    Task { await model.validateAgentPlanForConfirmation() }
                }
                .buttonStyle(.borderedProminent).tint(.green)
                .disabled(!model.canApplyAgentPlan || !model.agentAcknowledged || plan.proposal.requiresClarification || plan.operations.isEmpty || model.actionBusy)
                if model.effectiveRole != "owner" {
                    Text("Agent apply authenticated owner-only; \(model.effectiveRole) plan preview করতে পারেন।")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
        }
        .padding(14).csceCard()
    }

    private func activityCard(_ composition: CSCEComposition) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            sectionTitle("Durable activity", icon: "clock.arrow.2.circlepath")
            if composition.history.activity.isEmpty {
                Text("এখনো apply history নেই।").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(composition.history.activity.reversed().prefix(12)) { activity in
                HStack(alignment: .top) {
                    Image(systemName: activity.kind == "apply" ? "pencil.and.list.clipboard" : "arrow.triangle.2.circlepath")
                        .foregroundStyle(activity.origin == "agent" ? Color.orange : Color.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(activity.kind.capitalized) · v\(activity.resultVersion)").font(.caption.weight(.bold))
                        Text("\(activity.actorName) · \(activity.origin) · \(activity.operationIds.count) operations")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                }
            }
        }
        .padding(14).csceCard()
    }

    private func sectionTitle(_ value: String, icon: String) -> some View {
        Label(value, systemImage: icon).font(.system(size: 15, weight: .bold))
    }

    private func trackIcon(_ kind: String) -> String {
        switch kind {
        case "video": return "film.stack"
        case "image", "overlay": return "photo.stack"
        case "caption", "text": return "captions.bubble"
        case "voice": return "waveform.and.mic"
        case "music", "sfx": return "music.note"
        default: return "rectangle.3.group"
        }
    }

    private func seedInspector() {
        guard let clip = model.selectedClip else { return }
        captionText = model.selectedNode?.content ?? ""
        rangeStartSec = Double(clip.startMs) / 1_000
        rangeEndSec = Double(clip.endMs) / 1_000
        splitSec = (rangeStartSec + rangeEndSec) / 2
        if let transform = clip.transform {
            transformX = transform.x
            transformY = transform.y
            transformScale = (transform.width * transform.height).squareRoot()
            transformRotation = transform.rotation
            transformOpacity = transform.opacity
        } else {
            transformX = 0; transformY = 0; transformScale = 1
            transformRotation = 0; transformOpacity = 1
        }
        if let value = clip.volume {
            volume = value.muted ? 0 : min(1, max(0, pow(10, value.gainDb / 20)))
        } else {
            volume = 1
        }
    }
}

@available(iOS 17.0, *)
private extension View {
    func csceCard() -> some View {
        background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 17, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 17, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
    }
}
