//
//  AssistantTransport.swift
//  ALMA ERP — assistant protocol + transport layer (roadmap Phase 2.5 split).
//
//  First extraction from the AssistantSwiftUI.swift monolith: everything between
//  the wire and the reducer — turn diagnostics/signposts, transport error
//  classification, the SSE wire DTO + typed AgentTurnEvent contract, the
//  spec-shaped SSE parser, the delta-coalescing event buffer, and the streaming
//  URLSession layer. No UI code lives here. AssistantSwiftUI.swift keeps the
//  view model + views until the next extraction PR (each must compile alone).
//

import Foundation
import UIKit
import os.signpost

// MARK: - Turn diagnostics + transport classification (roadmap Phase 0 / 1.1)

/// os_signpost timeline for the agent turn lifecycle (Instruments/log-visible).
/// Carries lifecycle timing only — never prompt, reply or tool contents.
enum AlmaTurnLog {
    static let log = OSLog(subsystem: "com.almatraders.erp.agent", category: "AgentTurn")
    static func event(_ name: StaticString, _ info: String = "") {
        os_signpost(.event, log: log, name: name, "%{public}s", info)
    }
}

/// Typed classification of a thrown stream/request error (roadmap Phase 1.1).
/// A backgrounded/suspended SSE socket is an EXPECTED interruption while the
/// server deliberately keeps the turn alive — it must never surface as a raw
/// English failure toast. Only real terminal conditions may show an error.
enum TurnFailureKind {
    case transportInterrupted   // socket dropped/suspended/timed out — turn may still run
    case offline                // no network path at all — turn may STILL be running server-side
    case authentication
    case server(status: Int)
    case terminalAgentError     // the server itself reported the turn failed

    static func classify(_ error: Error) -> TurnFailureKind {
        if let api = error as? AlmaAPIError {
            switch api {
            case .notAuthenticated: return .authentication
            case .http(let status, _): return .server(status: status)
            case .decoding: return .transportInterrupted
            case .transport(let inner): return classify(inner)
            }
        }
        if let url = error as? URLError {
            switch url.code {
            case .notConnectedToInternet, .dataNotAllowed: return .offline
            default: return .transportInterrupted   // connectionLost/cancelled/timedOut/suspension…
            }
        }
        return .transportInterrupted
    }

    /// Owner-facing Bangla copy for REAL failures (transport interruptions never toast).
    var banglaMessage: String {
        switch self {
        case .transportInterrupted: return "সংযোগে সমস্যা হয়েছে — আবার চেষ্টা করুন"
        case .offline: return "ইন্টারনেট নেই — সংযোগ ফিরলে আবার চেষ্টা করুন"
        case .authentication: return "লগইন লাগবে — আবার সাইন ইন করুন"
        case .server(let s): return "সার্ভার সমস্যা (\(s)) — একটু পরে চেষ্টা করুন"
        case .terminalAgentError: return "সমস্যা হয়েছে — আবার চেষ্টা করুন"
        }
    }
}

struct TurnEnqueueResponse: Decodable { let turnId: String; let conversationId: String? }
struct TurnStatusResponse: Decodable {
    let status: String?
    let turnId: String?
    let startedAt: String?
    /// Terminal turn ended continuation-eligible — the ONLY signal left when both
    /// the direct SSE and the durable tail are gone and polling finds the terminal.
    let continuationNeeded: Bool?
}

/// Server-authored image-render estimate pinned to one model selection. These
/// values are render-only pricing metadata; the client never derives a quote
/// from token cost or from a legacy approval-card estimate.
struct AgentImageModelQuoteWire: Equatable, Sendable {
    let version: Int
    let currency: String
    let kind: String
    let model: String
    let provider: String
    let quality: String
    let imageSize: String
    let requestedImages: Int
    let unitPriceUsd: Double
    let minCostUsd: Double
    let maxCostUsd: Double
    let maxPaidGenerationsPerImage: Int
    let pricingBasis: String
    let pricingLastVerifiedAt: String
    let excludes: [String]
    private let decodedContractShapeIsValid: Bool

    init(
        version: Int, currency: String, kind: String, model: String, provider: String,
        quality: String, imageSize: String, requestedImages: Int, unitPriceUsd: Double,
        minCostUsd: Double, maxCostUsd: Double, maxPaidGenerationsPerImage: Int,
        pricingBasis: String, pricingLastVerifiedAt: String, excludes: [String],
        decodedContractShapeIsValid: Bool = true
    ) {
        self.version = version
        self.currency = currency
        self.kind = kind
        self.model = model
        self.provider = provider
        self.quality = quality
        self.imageSize = imageSize
        self.requestedImages = requestedImages
        self.unitPriceUsd = unitPriceUsd
        self.minCostUsd = minCostUsd
        self.maxCostUsd = maxCostUsd
        self.maxPaidGenerationsPerImage = maxPaidGenerationsPerImage
        self.pricingBasis = pricingBasis
        self.pricingLastVerifiedAt = pricingLastVerifiedAt
        self.excludes = excludes
        self.decodedContractShapeIsValid = decodedContractShapeIsValid
    }

    var hasValidContractShape: Bool {
        decodedContractShapeIsValid
            && version == 1
            && currency == "USD" && kind == "provider_render_estimate"
            && !model.isEmpty && !provider.isEmpty
            && ["standard", "pro"].contains(quality)
            && ["1K", "2K", "4K"].contains(imageSize)
            && (1...4).contains(requestedImages) && maxPaidGenerationsPerImage > 0
            && unitPriceUsd.isFinite && unitPriceUsd >= 0
            && minCostUsd.isFinite && minCostUsd >= 0
            && maxCostUsd.isFinite && maxCostUsd >= minCostUsd
            && pricingBasis == "internal_list_estimate"
            && !pricingLastVerifiedAt.isEmpty
    }
}

extension AgentImageModelQuoteWire: Decodable {
    private enum CodingKeys: String, CodingKey {
        case version, currency, kind, model, provider, quality, imageSize, requestedImages
        case unitPriceUsd, minCostUsd, maxCostUsd, maxPaidGenerationsPerImage
        case pricingBasis, pricingLastVerifiedAt, excludes
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init(
                version: 0, currency: "", kind: "", model: "", provider: "",
                quality: "", imageSize: "", requestedImages: 0,
                unitPriceUsd: .nan, minCostUsd: .nan, maxCostUsd: .nan,
                maxPaidGenerationsPerImage: 0, pricingBasis: "",
                pricingLastVerifiedAt: "", excludes: [],
                decodedContractShapeIsValid: false)
            return
        }
        let version = try? c.decode(Int.self, forKey: .version)
        let currency = try? c.decode(String.self, forKey: .currency)
        let kind = try? c.decode(String.self, forKey: .kind)
        let model = try? c.decode(String.self, forKey: .model)
        let provider = try? c.decode(String.self, forKey: .provider)
        let quality = try? c.decode(String.self, forKey: .quality)
        let imageSize = try? c.decode(String.self, forKey: .imageSize)
        let requestedImages = try? c.decode(Int.self, forKey: .requestedImages)
        let unitPriceUsd = try? c.decode(Double.self, forKey: .unitPriceUsd)
        let minCostUsd = try? c.decode(Double.self, forKey: .minCostUsd)
        let maxCostUsd = try? c.decode(Double.self, forKey: .maxCostUsd)
        let paidCap = try? c.decode(Int.self, forKey: .maxPaidGenerationsPerImage)
        let pricingBasis = try? c.decode(String.self, forKey: .pricingBasis)
        let verifiedAt = try? c.decode(String.self, forKey: .pricingLastVerifiedAt)
        let excludes = try? c.decode([String].self, forKey: .excludes)
        let allRequired = [currency, kind, model, provider, quality, imageSize,
                           pricingBasis, verifiedAt].allSatisfy { $0 != nil }
            && version != nil && requestedImages != nil && unitPriceUsd != nil
            && minCostUsd != nil && maxCostUsd != nil && paidCap != nil && excludes != nil
        self.init(
            version: version ?? 0, currency: currency ?? "", kind: kind ?? "",
            model: model ?? "", provider: provider ?? "", quality: quality ?? "",
            imageSize: imageSize ?? "", requestedImages: requestedImages ?? 0,
            unitPriceUsd: unitPriceUsd ?? .nan, minCostUsd: minCostUsd ?? .nan,
            maxCostUsd: maxCostUsd ?? .nan, maxPaidGenerationsPerImage: paidCap ?? 0,
            pricingBasis: pricingBasis ?? "", pricingLastVerifiedAt: verifiedAt ?? "",
            excludes: excludes ?? [], decodedContractShapeIsValid: allRequired)
    }
}

struct AgentImageModelOptionWire: Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let provider: String
    let enabled: Bool
    let unavailableReason: String?
    let quote: AgentImageModelQuoteWire?
    private let decodedContractShapeIsValid: Bool

    init(
        id: String, label: String, provider: String, enabled: Bool,
        unavailableReason: String?, quote: AgentImageModelQuoteWire?,
        decodedContractShapeIsValid: Bool = true
    ) {
        self.id = id
        self.label = label
        self.provider = provider
        self.enabled = enabled
        self.unavailableReason = unavailableReason
        self.quote = quote
        self.decodedContractShapeIsValid = decodedContractShapeIsValid
    }

    var hasValidContractShape: Bool {
        guard decodedContractShapeIsValid, !id.isEmpty, !label.isEmpty, !provider.isEmpty else {
            return false
        }
        if enabled && quote == nil { return false }
        if let quote {
            guard quote.hasValidContractShape,
                  quote.model == id,
                  quote.provider.caseInsensitiveCompare(provider) == .orderedSame else { return false }
        }
        return true
    }
}

extension AgentImageModelOptionWire: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, label, provider, enabled, unavailableReason, quote
    }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init(
                id: "", label: "", provider: "", enabled: false,
                unavailableReason: nil, quote: nil, decodedContractShapeIsValid: false)
            return
        }
        let id = try? c.decode(String.self, forKey: .id)
        let label = try? c.decode(String.self, forKey: .label)
        let provider = try? c.decode(String.self, forKey: .provider)
        let enabled = try? c.decode(Bool.self, forKey: .enabled)
        let reason = try? c.decodeIfPresent(String.self, forKey: .unavailableReason)
        let quote = try? c.decodeIfPresent(AgentImageModelQuoteWire.self, forKey: .quote)
        self.init(
            id: id ?? "", label: label ?? "", provider: provider ?? "",
            enabled: enabled ?? false, unavailableReason: reason ?? nil, quote: quote ?? nil,
            decodedContractShapeIsValid: id != nil && label != nil && provider != nil && enabled != nil)
    }
}

struct AgentImageModelSelectionWire: Equatable, Sendable {
    let selectedModel: String
    let options: [AgentImageModelOptionWire]
    let quote: AgentImageModelQuoteWire
    private let decodedContractShapeIsValid: Bool

    init(
        selectedModel: String, options: [AgentImageModelOptionWire],
        quote: AgentImageModelQuoteWire, decodedContractShapeIsValid: Bool = true
    ) {
        self.selectedModel = selectedModel
        self.options = options
        self.quote = quote
        self.decodedContractShapeIsValid = decodedContractShapeIsValid
    }

    var trustedValue: Self? {
        guard decodedContractShapeIsValid,
              !selectedModel.isEmpty,
              !options.isEmpty,
              options.allSatisfy({ $0.hasValidContractShape }),
              Set(options.map(\.id)).count == options.count,
              quote.hasValidContractShape,
              quote.model == selectedModel,
              let selected = options.first(where: { $0.id == selectedModel }) else { return nil }
        // Historical terminal cards may truthfully show a now-disabled pinned
        // model. A selectable option, however, must carry the exact same quote
        // the card presents; accepting mismatched nested metadata could approve
        // a different price/model than the owner saw.
        if selected.enabled && selected.quote != quote { return nil }
        return self
    }
}

extension AgentImageModelSelectionWire: Decodable {
    private enum CodingKeys: String, CodingKey { case selectedModel, options, quote }

    init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init(
                selectedModel: "", options: [], quote: .init(
                    version: 0, currency: "", kind: "", model: "", provider: "",
                    quality: "", imageSize: "", requestedImages: 0,
                    unitPriceUsd: .nan, minCostUsd: .nan, maxCostUsd: .nan,
                    maxPaidGenerationsPerImage: 0, pricingBasis: "",
                    pricingLastVerifiedAt: "", excludes: [],
                    decodedContractShapeIsValid: false),
                decodedContractShapeIsValid: false)
            return
        }
        let selectedModel = try? c.decode(String.self, forKey: .selectedModel)
        let options = try? c.decode([AgentImageModelOptionWire].self, forKey: .options)
        let quote = try? c.decode(AgentImageModelQuoteWire.self, forKey: .quote)
        self.init(
            selectedModel: selectedModel ?? "", options: options ?? [],
            quote: quote ?? .init(
                version: 0, currency: "", kind: "", model: "", provider: "",
                quality: "", imageSize: "", requestedImages: 0,
                unitPriceUsd: .nan, minCostUsd: .nan, maxCostUsd: .nan,
                maxPaidGenerationsPerImage: 0, pricingBasis: "",
                pricingLastVerifiedAt: "", excludes: [],
                decodedContractShapeIsValid: false),
            decodedContractShapeIsValid: selectedModel != nil && options != nil && quote != nil)
    }
}

// MARK: - Build 103 Issue 2 — v2 image render selection (preset/aspect/exact
// dimensions/quality/count/model + revisioned quote). Decoded leniently so an
// unknown future field can never drop the card; `trustedValue` is the gate.

struct AgentImageRenderConfigWire: Decodable, Equatable, Sendable {
    let version: Int
    let presetId: String
    let sizeMode: String
    let aspectRatio: String
    let imageSize: String
    let width: Int
    let height: Int
    let quality: String
    let providerQuality: String?
    let variationCount: Int
    let pipelineMode: String

    private enum CodingKeys: String, CodingKey {
        case version, presetId, sizeMode, aspectRatio, imageSize, width, height,
             quality, providerQuality, variationCount, pipelineMode
    }

    init(version: Int, presetId: String, sizeMode: String, aspectRatio: String,
         imageSize: String, width: Int, height: Int, quality: String,
         providerQuality: String?, variationCount: Int, pipelineMode: String) {
        self.version = version
        self.presetId = presetId
        self.sizeMode = sizeMode
        self.aspectRatio = aspectRatio
        self.imageSize = imageSize
        self.width = width
        self.height = height
        self.quality = quality
        self.providerQuality = providerQuality
        self.variationCount = variationCount
        self.pipelineMode = pipelineMode
    }

    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        self.init(
            version: (try? c?.decode(Int.self, forKey: .version)) ?? 0,
            presetId: (try? c?.decode(String.self, forKey: .presetId)) ?? "",
            sizeMode: (try? c?.decode(String.self, forKey: .sizeMode)) ?? "",
            aspectRatio: (try? c?.decode(String.self, forKey: .aspectRatio)) ?? "",
            imageSize: (try? c?.decode(String.self, forKey: .imageSize)) ?? "",
            width: (try? c?.decode(Int.self, forKey: .width)) ?? 0,
            height: (try? c?.decode(Int.self, forKey: .height)) ?? 0,
            quality: (try? c?.decode(String.self, forKey: .quality)) ?? "",
            providerQuality: (try? c?.decodeIfPresent(String.self, forKey: .providerQuality)) ?? nil,
            variationCount: (try? c?.decode(Int.self, forKey: .variationCount)) ?? 0,
            pipelineMode: (try? c?.decode(String.self, forKey: .pipelineMode)) ?? "")
    }

    var hasValidContractShape: Bool {
        version == 1 && sizeMode == "tier"
            && !presetId.isEmpty && !aspectRatio.isEmpty
            && ["1K", "2K", "4K"].contains(imageSize)
            && width > 0 && height > 0
            && (quality == "standard" || quality == "pro")
            && (1...4).contains(variationCount)
            && (pipelineMode == "preview" || pipelineMode == "production")
    }
}

struct AgentImageRenderQuoteWire: Decodable, Equatable, Sendable {
    let version: Int
    let currency: String
    let model: String
    let provider: String
    let presetId: String
    let aspectRatio: String
    let imageSize: String
    let width: Int
    let height: Int
    let quality: String
    let providerQuality: String?
    let requestedImages: Int
    let unitPriceUsd: Double
    let minCostUsd: Double
    let maxCostUsd: Double
    let maxPaidGenerationsPerImage: Int
    let configFingerprint: String
    let pricingBasis: String
    let pricingLastVerifiedAt: String
    let pricedComponents: [String]
    let excludes: [String]

    private enum CodingKeys: String, CodingKey {
        case version, currency, model, provider, presetId, aspectRatio, imageSize,
             width, height, quality, providerQuality, requestedImages, unitPriceUsd,
             minCostUsd, maxCostUsd, maxPaidGenerationsPerImage, configFingerprint,
             pricingBasis, pricingLastVerifiedAt, pricedComponents, excludes
    }

    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        version = (try? c?.decode(Int.self, forKey: .version)) ?? 0
        currency = (try? c?.decode(String.self, forKey: .currency)) ?? ""
        model = (try? c?.decode(String.self, forKey: .model)) ?? ""
        provider = (try? c?.decode(String.self, forKey: .provider)) ?? ""
        presetId = (try? c?.decode(String.self, forKey: .presetId)) ?? ""
        aspectRatio = (try? c?.decode(String.self, forKey: .aspectRatio)) ?? ""
        imageSize = (try? c?.decode(String.self, forKey: .imageSize)) ?? ""
        width = (try? c?.decode(Int.self, forKey: .width)) ?? 0
        height = (try? c?.decode(Int.self, forKey: .height)) ?? 0
        quality = (try? c?.decode(String.self, forKey: .quality)) ?? ""
        providerQuality = (try? c?.decodeIfPresent(String.self, forKey: .providerQuality)) ?? nil
        requestedImages = (try? c?.decode(Int.self, forKey: .requestedImages)) ?? 0
        unitPriceUsd = (try? c?.decode(Double.self, forKey: .unitPriceUsd)) ?? .nan
        minCostUsd = (try? c?.decode(Double.self, forKey: .minCostUsd)) ?? .nan
        maxCostUsd = (try? c?.decode(Double.self, forKey: .maxCostUsd)) ?? .nan
        maxPaidGenerationsPerImage = (try? c?.decode(Int.self, forKey: .maxPaidGenerationsPerImage)) ?? 0
        configFingerprint = (try? c?.decode(String.self, forKey: .configFingerprint)) ?? ""
        pricingBasis = (try? c?.decode(String.self, forKey: .pricingBasis)) ?? ""
        pricingLastVerifiedAt = (try? c?.decode(String.self, forKey: .pricingLastVerifiedAt)) ?? ""
        pricedComponents = (try? c?.decode([String].self, forKey: .pricedComponents)) ?? []
        excludes = (try? c?.decode([String].self, forKey: .excludes)) ?? []
    }

    var hasValidContractShape: Bool {
        version == 2 && currency == "USD" && !model.isEmpty
            && !configFingerprint.isEmpty
            && unitPriceUsd.isFinite && unitPriceUsd >= 0
            && minCostUsd.isFinite && minCostUsd >= 0
            && maxCostUsd.isFinite && maxCostUsd >= minCostUsd
            && maxPaidGenerationsPerImage >= 1
            && (1...4).contains(requestedImages)
            && pricingBasis == "internal_list_estimate"
    }
}

struct AgentImageRenderModelOptionWire: Decodable, Equatable, Sendable {
    let id: String
    let label: String
    let provider: String
    let enabled: Bool
    let unavailableReason: String?

    private enum CodingKeys: String, CodingKey { case id, label, provider, enabled, unavailableReason }
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        id = (try? c?.decode(String.self, forKey: .id)) ?? ""
        label = (try? c?.decode(String.self, forKey: .label)) ?? ""
        provider = (try? c?.decode(String.self, forKey: .provider)) ?? ""
        enabled = (try? c?.decode(Bool.self, forKey: .enabled)) ?? false
        unavailableReason = (try? c?.decodeIfPresent(String.self, forKey: .unavailableReason)) ?? nil
    }
    var hasValidContractShape: Bool { !id.isEmpty && !label.isEmpty }
}

struct AgentImagePresetOptionWire: Decodable, Equatable, Sendable {
    let id: String
    let label: String
    let aspectRatio: String
    let enabled: Bool
    let unavailableReason: String?

    private enum CodingKeys: String, CodingKey { case id, label, aspectRatio, enabled, unavailableReason }
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        id = (try? c?.decode(String.self, forKey: .id)) ?? ""
        label = (try? c?.decode(String.self, forKey: .label)) ?? ""
        aspectRatio = (try? c?.decode(String.self, forKey: .aspectRatio)) ?? ""
        enabled = (try? c?.decode(Bool.self, forKey: .enabled)) ?? false
        unavailableReason = (try? c?.decodeIfPresent(String.self, forKey: .unavailableReason)) ?? nil
    }
    var hasValidContractShape: Bool { !id.isEmpty && !aspectRatio.isEmpty }
}

struct AgentImageSizeOptionWire: Decodable, Equatable, Sendable {
    let id: String
    let enabled: Bool
    let width: Int?
    let height: Int?
    let unavailableReason: String?

    private enum CodingKeys: String, CodingKey { case id, enabled, width, height, unavailableReason }
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        id = (try? c?.decode(String.self, forKey: .id)) ?? ""
        enabled = (try? c?.decode(Bool.self, forKey: .enabled)) ?? false
        width = (try? c?.decodeIfPresent(Int.self, forKey: .width)) ?? nil
        height = (try? c?.decodeIfPresent(Int.self, forKey: .height)) ?? nil
        unavailableReason = (try? c?.decodeIfPresent(String.self, forKey: .unavailableReason)) ?? nil
    }
    var hasValidContractShape: Bool { ["1K", "2K", "4K"].contains(id) }
}

struct AgentImageQualityOptionWire: Decodable, Equatable, Sendable {
    let id: String
    let providerQuality: String?
    let description: String

    private enum CodingKeys: String, CodingKey { case id, providerQuality, description }
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        id = (try? c?.decode(String.self, forKey: .id)) ?? ""
        providerQuality = (try? c?.decodeIfPresent(String.self, forKey: .providerQuality)) ?? nil
        description = (try? c?.decode(String.self, forKey: .description)) ?? ""
    }
    var hasValidContractShape: Bool { id == "standard" || id == "pro" }
}

struct AgentImageRenderSelectionWire: Decodable, Equatable, Sendable {
    let contractVersion: Int
    let revision: Int
    let selectedModel: String
    let config: AgentImageRenderConfigWire?
    let configFingerprint: String
    let modelOptions: [AgentImageRenderModelOptionWire]
    let presetOptions: [AgentImagePresetOptionWire]
    let sizeOptions: [AgentImageSizeOptionWire]
    let qualityOptions: [AgentImageQualityOptionWire]
    let countOptions: [Int]
    let quote: AgentImageRenderQuoteWire?

    private enum CodingKeys: String, CodingKey {
        case contractVersion, revision, selectedModel, config, configFingerprint,
             modelOptions, presetOptions, sizeOptions, qualityOptions, countOptions, quote
    }

    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        contractVersion = (try? c?.decode(Int.self, forKey: .contractVersion)) ?? 0
        revision = (try? c?.decode(Int.self, forKey: .revision)) ?? -1
        selectedModel = (try? c?.decode(String.self, forKey: .selectedModel)) ?? ""
        config = (try? c?.decodeIfPresent(AgentImageRenderConfigWire.self, forKey: .config)) ?? nil
        configFingerprint = (try? c?.decode(String.self, forKey: .configFingerprint)) ?? ""
        modelOptions = (try? c?.decode([AgentImageRenderModelOptionWire].self, forKey: .modelOptions)) ?? []
        presetOptions = (try? c?.decode([AgentImagePresetOptionWire].self, forKey: .presetOptions)) ?? []
        sizeOptions = (try? c?.decode([AgentImageSizeOptionWire].self, forKey: .sizeOptions)) ?? []
        qualityOptions = (try? c?.decode([AgentImageQualityOptionWire].self, forKey: .qualityOptions)) ?? []
        countOptions = (try? c?.decode([Int].self, forKey: .countOptions)) ?? []
        quote = (try? c?.decodeIfPresent(AgentImageRenderQuoteWire.self, forKey: .quote)) ?? nil
    }

    /// Non-nil only for a complete, internally-consistent v2 projection: the
    /// quote must bind the exact selection fingerprint the card presents —
    /// approving anything else could spend a different price than shown.
    var trustedValue: AgentImageRenderSelection? {
        guard contractVersion == 2,
              revision >= 0,
              !selectedModel.isEmpty,
              let config, config.hasValidContractShape,
              !configFingerprint.isEmpty,
              let quote, quote.hasValidContractShape,
              quote.configFingerprint == configFingerprint,
              quote.model == selectedModel,
              quote.width == config.width, quote.height == config.height,
              quote.requestedImages == config.variationCount,
              !modelOptions.isEmpty,
              modelOptions.allSatisfy(\.hasValidContractShape),
              Set(modelOptions.map(\.id)).count == modelOptions.count,
              modelOptions.contains(where: { $0.id == selectedModel }),
              !presetOptions.isEmpty,
              presetOptions.allSatisfy(\.hasValidContractShape),
              presetOptions.contains(where: { $0.id == config.presetId }),
              !sizeOptions.isEmpty,
              sizeOptions.allSatisfy(\.hasValidContractShape),
              !qualityOptions.isEmpty,
              qualityOptions.allSatisfy(\.hasValidContractShape),
              !countOptions.isEmpty,
              countOptions.allSatisfy({ (1...4).contains($0) })
        else { return nil }
        return AgentImageRenderSelection(
            revision: revision, selectedModel: selectedModel, config: config,
            configFingerprint: configFingerprint, modelOptions: modelOptions,
            presetOptions: presetOptions, sizeOptions: sizeOptions,
            qualityOptions: qualityOptions, countOptions: countOptions, quote: quote)
    }
}

/// Validated domain value the UI renders — only constructible via `trustedValue`.
struct AgentImageRenderSelection: Equatable, Sendable {
    let revision: Int
    let selectedModel: String
    let config: AgentImageRenderConfigWire
    let configFingerprint: String
    let modelOptions: [AgentImageRenderModelOptionWire]
    let presetOptions: [AgentImagePresetOptionWire]
    let sizeOptions: [AgentImageSizeOptionWire]
    let qualityOptions: [AgentImageQualityOptionWire]
    let countOptions: [Int]
    let quote: AgentImageRenderQuoteWire
}

// MARK: - Build 103 Issue 3 — typed work-step tracker wire contract

struct AgentWireStep: Decodable, Equatable, Sendable {
    // work_steps_snapshot shape
    let id: String?
    let position: Int?
    let title: String?
    let status: String?
    let toolCallIds: [String]?
    let startedAt: String?
    let finishedAt: String?
    // plan_progress shape (decoded so it can never arrive as unknown)
    let seq: Int?
    let action: String?

    private enum CodingKeys: String, CodingKey {
        case id, position, title, status, toolCallIds, startedAt, finishedAt, seq, action
    }
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        id = (try? c?.decodeIfPresent(String.self, forKey: .id)) ?? nil
        position = (try? c?.decodeIfPresent(Int.self, forKey: .position)) ?? nil
        title = (try? c?.decodeIfPresent(String.self, forKey: .title)) ?? nil
        status = (try? c?.decodeIfPresent(String.self, forKey: .status)) ?? nil
        toolCallIds = (try? c?.decodeIfPresent([String].self, forKey: .toolCallIds)) ?? nil
        startedAt = (try? c?.decodeIfPresent(String.self, forKey: .startedAt)) ?? nil
        finishedAt = (try? c?.decodeIfPresent(String.self, forKey: .finishedAt)) ?? nil
        seq = (try? c?.decodeIfPresent(Int.self, forKey: .seq)) ?? nil
        action = (try? c?.decodeIfPresent(String.self, forKey: .action)) ?? nil
    }
}

struct AgentWorkStepsBlockerWire: Decodable, Equatable, Sendable {
    let kind: String?
    let refId: String?
}

/// Validated typed snapshot — the reducer stores these keyed by trackerId with
/// monotonic revisions; live, replay, polling and cold load all merge here.
struct AgentWorkStepsSnapshot: Equatable, Sendable {
    struct Step: Equatable, Sendable, Identifiable {
        let id: String
        let position: Int
        let title: String
        let status: String
        let startedAt: String?
        let finishedAt: String?
    }
    let trackerId: String
    let originTurnId: String
    let currentTurnId: String
    let turnIds: [String]
    let conversationId: String
    let originAssistantMessageId: String?
    let revision: Int
    let sourceId: String
    let goal: String
    let status: String
    let headline: String
    let blockedByKind: String?
    let blockedByRefId: String?
    let steps: [Step]
    let updatedAt: String

    var isTerminal: Bool { ["completed", "failed", "cancelled"].contains(status) }
    var completedCount: Int { steps.filter { $0.status == "completed" || $0.status == "skipped" }.count }

    static let overallStatuses: Set<String> = [
        "preparing", "running", "waiting_owner", "waiting_worker",
        "paused", "completed", "failed", "cancelled",
    ]
    static let stepStatuses: Set<String> = [
        "pending", "running", "waiting_owner", "waiting_worker",
        "completed", "failed", "cancelled", "skipped",
    ]

    /// Build from the flat SSE event/cold JSON. Nil = malformed (telemetry).
    static func from(
        version: Int?, trackerId: String?, originTurnId: String?, currentTurnId: String?,
        turnIds: [String]?, conversationId: String?, originAssistantMessageId: String?,
        revision: Int?, sourceId: String?, goal: String?, status: String?, headline: String?,
        blockedBy: AgentWorkStepsBlockerWire?, steps: [AgentWireStep]?, updatedAt: String?
    ) -> AgentWorkStepsSnapshot? {
        guard version == 1,
              let trackerId, !trackerId.isEmpty,
              let originTurnId, !originTurnId.isEmpty,
              let revision, revision >= 1,
              let goal, let status, overallStatuses.contains(status),
              let steps else { return nil }
        var mapped: [Step] = []
        for step in steps {
            guard let id = step.id, !id.isEmpty,
                  let position = step.position, position >= 1,
                  let title = step.title,
                  let stepStatus = step.status, stepStatuses.contains(stepStatus)
            else { return nil }
            mapped.append(Step(
                id: id, position: position, title: title, status: stepStatus,
                startedAt: step.startedAt, finishedAt: step.finishedAt))
        }
        return AgentWorkStepsSnapshot(
            trackerId: trackerId,
            originTurnId: originTurnId,
            currentTurnId: currentTurnId ?? originTurnId,
            turnIds: turnIds ?? [originTurnId],
            conversationId: conversationId ?? "",
            originAssistantMessageId: originAssistantMessageId,
            revision: revision,
            sourceId: sourceId ?? trackerId,
            goal: goal,
            status: status,
            headline: headline ?? "",
            blockedByKind: blockedBy?.kind,
            blockedByRefId: blockedBy?.refId,
            steps: mapped.sorted { $0.position < $1.position },
            updatedAt: updatedAt ?? "")
    }
}

struct AgentSSEEvent: Decodable {
    let type: String
    let id: String?
    let delta: String?
    let text: String?           // preamble
    let modelId: String?        // model_info — canonical registry identity
    let label: String?
    let displayName: String?     // model_info — the name Boss reads
    let name: String?
    let success: Bool?
    let resultPreview: String?
    let input: AgentJSONValue?
    let pendingActionId: String?
    let summary: String?
    let actionType: String?
    let costEstimate: Double?
    let imageModelSelection: AgentImageModelSelectionWire?
    let askCardId: String?
    let question: String?
    let options: [String]?
    /// Multi-question ask card (Claude-Code-style): every question with its
    /// own options; question/options above mirror the first entry.
    let questions: [AgentAskQuestionWire]?
    let message: String?
    let error: String?
    let title: String?          // artifact_saved
    let artifactType: String?   // artifact_saved
    // Phase 2 (roadmap 2.1) — full wire parity; every field the server emits:
    let active: Bool?           // personal_mode
    let screenshot: String?     // tool_end (browser tools)
    let role: String?           // subagent_start/end
    let roleLabel: String?      // subagent_start
    let task: String?           // subagent_start
    let toolsUsed: [String]?    // subagent_end
    let attempt: Int?           // verification_retry
    let maxAttempts: Int?       // verification_retry
    let toLabel: String?        // model_switch_required
    let fromLabel: String?      // model_switch_required
    let fallbackModelId: String?// model_switch_required
    let messageId: String?      // done
    let tokensIn: Int?          // done
    let tokensOut: Int?         // done
    let cacheCreation: Int?     // done
    let cacheRead: Int?         // done
    let costUsd: Double?        // done
    let needContinue: Bool?     // done — serverless deadline hit mid-task
    let apiRounds: Int?         // done
    let roundCostsUsd: [Double]?// done
    let conversationId: String? // conversation_compacted + turn_snapshot
    let status: String?         // turn_snapshot
    let lastSeq: Int?           // turn_snapshot
    let assistantMessageId: String? // turn_snapshot
    let afterSeq: Int?          // replay_continue
    let turnId: String?         // turn_snapshot
    // SK-3 — skill_pinned. The web has shown this since 2026-07-26; the native
    // transport never decoded it, so the phone silently dropped the one line the
    // owner asked for ("🧠 <skill> ব্যবহার করছি").
    let skill: String?          // skill_pinned
    let source: String?         // skill_pinned — "owner" | "router"
    let layer: String?          // skill_pinned
    let reason: String?         // skill_pinned + skill_held_back
    let isolated: Bool?         // skill_pinned — SK-7, ran on the skill's own prompt
    let state: String?          // skill_held_back — changed | unapproved | revoked
    // steering_delivered — the running turn actually PICKED UP a steer. The
    // client uuids are the matching key; the row ids are for correlation only.
    let clientMessageIds: [String]?
    let ids: [String]?
    // Build 103 Issue 2 — v2 image render selection beside the v1 picker.
    let imageRenderSelection: AgentImageRenderSelectionWire?
    // Build 103 Issue 3 — plan_progress / turn_progress / work_steps_snapshot.
    let planId: String?         // plan_progress
    let goal: String?           // plan_progress + work_steps_snapshot
    let headline: String?       // plan_progress + work_steps_snapshot
    let doneCount: Int?         // plan_progress
    let total: Int?             // plan_progress
    let steps: [AgentWireStep]? // plan_progress + work_steps_snapshot
    let round: Int?             // turn_progress
    let elapsedSec: Int?        // turn_progress
    let lastToolLabel: String?  // turn_progress
    let version: Int?           // work_steps_snapshot
    let trackerId: String?      // work_steps_snapshot
    let originTurnId: String?   // work_steps_snapshot
    let currentTurnId: String?  // work_steps_snapshot
    let turnIds: [String]?      // work_steps_snapshot
    let originAssistantMessageId: String? // work_steps_snapshot
    let revision: Int?          // work_steps_snapshot
    let sourceId: String?       // work_steps_snapshot
    let blockedBy: AgentWorkStepsBlockerWire? // work_steps_snapshot
    let updatedAt: String?      // work_steps_snapshot
}

/// Roadmap 2.1 — the typed native event contract. Mirrors `src/agent/lib/core.ts`
/// `AgentEvent` plus the route-level envelope events. `.unknown` keeps protocol
/// drift OBSERVABLE (telemetry) instead of silently dropped rows.
enum AgentTurnEvent: Sendable {
    case conversationId(String)
    case turnId(String)
    case personalMode(Bool)
    case modelInfo(modelId: String, label: String, displayName: String)
    case modelSwitchRequired(toLabel: String, fromLabel: String, fallbackModelId: String?)
    case thinkingDelta(String)
    /// Provider-neutral, truthful work headline. Unlike `thinkingDelta`, this is
    /// never presented as private model reasoning; it is an explicit progress
    /// update emitted by the turn runner for every provider.
    case progressUpdate(String)
    case textDelta(String)
    case toolStart(id: String, name: String, inputPretty: String?)
    case toolEnd(id: String, ok: Bool, resultPreview: String?, screenshot: String?)
    case subagentStart(id: String, role: String, roleLabel: String, task: String?)
    case subagentEnd(id: String, ok: Bool, summary: String?, toolsUsed: [String]?)
    case artifactSaved(id: String, title: String)
    case confirmCard(pendingActionId: String, summary: String, actionType: String?, costEstimate: Double?,
                     imageModelSelection: AgentImageModelSelectionWire?,
                     imageRenderSelection: AgentImageRenderSelection?)
    /// Build 103 Issue 3 — live checklist projection (web parity event). The
    /// native tracker is driven by `workSteps`; this is decoded so it can
    /// never surface as `unknown` telemetry.
    case planProgress(planId: String, goal: String, headline: String, doneCount: Int, total: Int)
    /// Deterministic server status line for long silent turns — decoded typed.
    case turnProgress(round: Int, elapsedSec: Int, lastToolLabel: String?, text: String)
    /// Build 103 Issue 3 — full authoritative work-step tracker snapshot.
    case workSteps(AgentWorkStepsSnapshot)
    case askCard(id: String, question: String, options: [String], questions: [AgentAskQuestionWire]?)
    case verificationRetry(attempt: Int, maxAttempts: Int)
    /// Speak-first (owner rule 2026-07-25): the opening line the head wrote
    /// BEFORE it ran anything. It already arrived as text_delta; this marker
    /// says "that prose is the line Boss read" so the client can keep it while
    /// still clearing ordinary mid-turn narration.
    case preamble(String)
    /// SK-3 — which skill is running this job, announced BEFORE any work starts
    /// so the owner sees it up front and can change it.
    case skillPinned(skill: String, source: String, reason: String, isolated: Bool)
    /// SK-8 — a matching skill was withheld by the server's provenance gate.
    /// This is factual product state, not model reasoning or an inferred error.
    case skillHeldBack(skill: String, state: String, reason: String)
    /// A mid-turn message the RUNNING TURN has now read — the step after "the
    /// server accepted it". Without this the phone showed both states the same.
    case steeringDelivered(clientMessageIds: [String])
    case conversationCompacted(newConversationId: String)
    case done(messageId: String?, tokensIn: Int?, tokensOut: Int?, costUsd: Double?,
              needContinue: Bool, apiRounds: Int?, cacheCreation: Int?, cacheRead: Int?,
              roundCostsUsd: [Double]?)
    case turnError(message: String)
    /// Durable-stream hello (roadmap 3.5/PR 5): current turn state on (re)connect.
    case turnSnapshot(turnId: String?, conversationId: String?, status: String?, lastSeq: Int?)
    /// Page-capped replay ended early — reconnect from this cursor.
    case replayContinue(afterSeq: Int)
    case unknown(type: String)

    /// True for events that must flush buffered deltas FIRST (exact chronology).
    var isControl: Bool {
        switch self {
        case .textDelta, .thinkingDelta: return false
        default: return true
        }
    }

    init(dto ev: AgentSSEEvent) {
        switch ev.type {
        case "conversation_id":
            self = ev.id.map(AgentTurnEvent.conversationId) ?? .unknown(type: "conversation_id/noid")
        case "turn_id":
            self = ev.id.map(AgentTurnEvent.turnId) ?? .unknown(type: "turn_id/noid")
        case "personal_mode":
            self = .personalMode(ev.active == true)
        case "model_info":
            self = .modelInfo(modelId: ev.modelId ?? "", label: ev.label ?? "",
                              displayName: ev.displayName ?? "")
        case "model_switch_required":
            self = .modelSwitchRequired(toLabel: ev.toLabel ?? "প্রিমিয়াম মডেল", fromLabel: ev.fromLabel ?? "",
                                        fallbackModelId: ev.fallbackModelId)
        case "thinking_delta":
            self = .thinkingDelta(ev.delta ?? "")
        case "progress_update":
            self = .progressUpdate(ev.label ?? "")
        case "text_delta":
            self = .textDelta(ev.delta ?? "")
        case "tool_start":
            self = .toolStart(id: ev.id ?? UUID().uuidString, name: ev.name ?? "টুল",
                              inputPretty: ev.input?.pretty())
        case "tool_end":
            self = .toolEnd(id: ev.id ?? "", ok: ev.success ?? true,
                            resultPreview: ev.resultPreview, screenshot: ev.screenshot)
        case "subagent_start":
            self = .subagentStart(id: ev.id ?? UUID().uuidString,
                                  role: ev.role ?? "",
                                  roleLabel: ev.roleLabel ?? ev.role ?? "সহকারী",
                                  task: ev.task)
        case "subagent_end":
            self = .subagentEnd(id: ev.id ?? "", ok: ev.success ?? true, summary: ev.summary,
                                toolsUsed: ev.toolsUsed)
        case "artifact_saved":
            self = ev.id.map { .artifactSaved(id: $0, title: ev.title ?? "ডকুমেন্ট") }
                ?? .unknown(type: "artifact_saved/noid")
        case "confirm_card":
            self = ev.pendingActionId.map {
                .confirmCard(pendingActionId: $0, summary: ev.summary ?? "",
                             actionType: ev.actionType, costEstimate: ev.costEstimate,
                             imageModelSelection: ev.imageModelSelection?.trustedValue,
                             imageRenderSelection: ev.imageRenderSelection?.trustedValue)
            } ?? .unknown(type: "confirm_card/noid")
        case "plan_progress":
            self = .planProgress(planId: ev.planId ?? "", goal: ev.goal ?? "",
                                 headline: ev.headline ?? "",
                                 doneCount: ev.doneCount ?? 0, total: ev.total ?? 0)
        case "turn_progress":
            self = .turnProgress(round: ev.round ?? 0, elapsedSec: ev.elapsedSec ?? 0,
                                 lastToolLabel: ev.lastToolLabel, text: ev.text ?? "")
        case "work_steps_snapshot":
            self = AgentWorkStepsSnapshot.from(
                version: ev.version, trackerId: ev.trackerId,
                originTurnId: ev.originTurnId, currentTurnId: ev.currentTurnId,
                turnIds: ev.turnIds, conversationId: ev.conversationId,
                originAssistantMessageId: ev.originAssistantMessageId,
                revision: ev.revision, sourceId: ev.sourceId, goal: ev.goal,
                status: ev.status, headline: ev.headline, blockedBy: ev.blockedBy,
                steps: ev.steps, updatedAt: ev.updatedAt,
            ).map(AgentTurnEvent.workSteps) ?? .unknown(type: "work_steps_snapshot/invalid")
        case "ask_card":
            self = ev.askCardId.map {
                .askCard(id: $0, question: ev.question ?? "", options: ev.options ?? [],
                         questions: ev.questions)
            } ?? .unknown(type: "ask_card/noid")
        case "verification_retry":
            self = .verificationRetry(attempt: ev.attempt ?? 1, maxAttempts: ev.maxAttempts ?? 1)
        case "preamble":
            self = .preamble(ev.text ?? ev.delta ?? "")
        case "skill_pinned":
            self = .skillPinned(skill: ev.skill ?? "",
                                source: ev.source == "owner" ? "owner" : "router",
                                reason: ev.reason ?? "",
                                isolated: ev.isolated == true)
        case "skill_held_back":
            self = .skillHeldBack(skill: ev.skill ?? "",
                                  state: ev.state ?? "",
                                  reason: ev.reason ?? "")
        case "steering_delivered":
            self = .steeringDelivered(clientMessageIds: ev.clientMessageIds ?? [])
        case "conversation_compacted":
            self = ev.conversationId.map(AgentTurnEvent.conversationCompacted)
                ?? .unknown(type: "conversation_compacted/noid")
        case "done":
            self = .done(messageId: ev.messageId, tokensIn: ev.tokensIn, tokensOut: ev.tokensOut,
                         costUsd: ev.costUsd, needContinue: ev.needContinue == true, apiRounds: ev.apiRounds,
                         cacheCreation: ev.cacheCreation, cacheRead: ev.cacheRead,
                         roundCostsUsd: ev.roundCostsUsd)
        case "error":
            self = .turnError(message: ev.message ?? ev.error ?? "সমস্যা হয়েছে — আবার চেষ্টা করুন")
        case "turn_snapshot":
            self = .turnSnapshot(turnId: ev.turnId, conversationId: ev.conversationId,
                                 status: ev.status, lastSeq: ev.lastSeq)
        case "replay_continue":
            self = .replayContinue(afterSeq: ev.afterSeq ?? -1)
        default:
            self = .unknown(type: ev.type)
        }
    }
}

/// Roadmap 2.2 — spec-shaped SSE line parser. Handles `data:` with/without the
/// space, CRLF and LF, multi-line data joined with \n, `:` comment keepalives,
/// `id:`/`retry:`/`event:` fields, and a trailing event with no final blank line.
/// Pure + synchronous so it is testable without a network.
struct AlmaSSEParser {
    private var dataLines: [String] = []
    /// Last `id:` field seen — the durable stream stamps each frame with its seq,
    /// so this is the client's replay cursor (`?afterSeq=`) after a drop (PR 5).
    private(set) var lastEventId: String?

    /// Feed one line (no trailing \n). Returns a complete event payload when a
    /// blank line closes the pending event.
    mutating func consume(line rawLine: String) -> String? {
        var line = rawLine
        if line.hasSuffix("\r") { line.removeLast() }          // CRLF wire
        if line.isEmpty {
            guard !dataLines.isEmpty else { return nil }
            defer { dataLines = [] }
            return dataLines.joined(separator: "\n")
        }
        if line.hasPrefix(":") { return nil }                  // ": ping" keepalive
        guard let colon = line.firstIndex(of: ":") else {
            if line == "data" { dataLines.append("") }         // field, empty value
            return nil
        }
        let field = String(line[..<colon])
        var value = String(line[line.index(after: colon)...])
        if value.hasPrefix(" ") { value.removeFirst() }        // exactly one optional space
        if field == "data" { dataLines.append(value) }
        if field == "id" { lastEventId = value }
        return nil
    }

    /// Stream ended without a final blank line — emit what is pending.
    mutating func flushTrailing() -> String? {
        guard !dataLines.isEmpty else { return nil }
        defer { dataLines = [] }
        return dataLines.joined(separator: "\n")
    }
}

/// Roadmap 2.3 — event batching between the network task and MainActor. Adjacent
/// text/thinking deltas coalesce for ~40ms; control events flush the pending batch
/// FIRST so chronology stays exact. Up to 25 visual updates per second keeps the
/// reply visibly live while still avoiding one MainActor/layout pass per raw SSE
/// fragment. Tool/card/control events still land immediately.
actor AgentEventBuffer {
    private var batch: [AgentTurnEvent] = []
    private var flushScheduled = false
    private var flushCount = 0
    private let apply: @MainActor ([AgentTurnEvent]) -> Void

    init(apply: @escaping @MainActor ([AgentTurnEvent]) -> Void) {
        self.apply = apply
    }

    func push(_ ev: AgentTurnEvent) async {
        if ev.isControl {
            batch.append(ev)
            await flushNow()                       // deltas before it already queued in order
            return
        }
        switch (ev, batch.last) {
        case (.textDelta(let d), .textDelta(let prev)):
            batch[batch.count - 1] = .textDelta(prev + d)
        case (.thinkingDelta(let d), .thinkingDelta(let prev)):
            batch[batch.count - 1] = .thinkingDelta(prev + d)
        default:
            batch.append(ev)
        }
        scheduleFlush()
    }

    private func scheduleFlush() {
        guard !flushScheduled else { return }
        flushScheduled = true
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 40_000_000)     // 25 flushes/s ceiling
            await self?.flushNow()
        }
    }

    func flushNow() async {
        flushScheduled = false
        guard !batch.isEmpty else { return }
        let out = batch
        batch = []
        flushCount += 1
        if flushCount == 1 || flushCount % 25 == 0 {
            AlmaTurnLog.event("stream.bufferFlush", "n=\(flushCount) batch=\(out.count)")
        }
        await apply(out)
    }

    /// Stream closed — deliver whatever is left.
    func finish() async { await flushNow() }
}

// MARK: - Networking (SSE + multipart; JSON goes through AlmaAPI)

/// Streaming + multipart companion to AlmaAPI (which is JSON-only). Shares the
/// same cookie bridge: HTTPCookieStorage.shared, refreshed via AlmaAPI.syncCookies().
enum AssistantNet {
    static let base = AlmaAPI.baseURL

    /// Long-lived session for SSE turns (a turn may legitimately run ~5 minutes).
    static let streamSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 330
        cfg.timeoutIntervalForResource = 660
        cfg.httpShouldSetCookies = true
        cfg.httpAdditionalHeaders = ["Accept": "text/event-stream",
                                     "X-Requested-With": "XMLHttpRequest"]
        #if DEBUG
        if AlmaMergeReadinessURLProtocol.scenario != nil {
            cfg.protocolClasses = [AlmaMergeReadinessURLProtocol.self]
        }
        #endif
        return URLSession(configuration: cfg, delegate: AssistantRedirectBlocker(), delegateQueue: nil)
    }()

    /// Multipart upload (images / mic audio). Returns the raw response data on 2xx.
    static func uploadMultipart(path: String, fileField: String, filename: String,
                                mime: String, data: Data,
                                extraFields: [String: String] = [:]) async throws -> Data {
        await AlmaAPI.shared.syncCookies()
        let boundary = "alma-\(UUID().uuidString)"
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        func append(_ s: String) { body.append(s.data(using: .utf8)!) }
        for (k, v) in extraFields {
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(k)\"\r\n\r\n\(v)\r\n")
        }
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(filename)\"\r\nContent-Type: \(mime)\r\n\r\n")
        body.append(data)
        append("\r\n--\(boundary)--\r\n")
        req.httpBody = body
        let (respData, resp) = try await streamSession.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw AlmaAPIError.transport(URLError(.badServerResponse)) }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 || http.statusCode == 403 { throw AlmaAPIError.notAuthenticated }
            throw AlmaAPIError.http(status: http.statusCode, body: String(data: respData, encoding: .utf8) ?? "")
        }
        return respData
    }

    /// POST a small JSON body and return raw bytes (the TTS endpoint answers audio/mpeg).
    static func postJSONForData(path: String, body: [String: String]) async throws -> Data {
        await AlmaAPI.shared.syncCookies()
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await streamSession.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            #if DEBUG
            NSLog("ALMA-NET JSON %@ failed status=%d", path, status)
            #endif
            throw AlmaAPIError.http(
                status: status,
                body: String(data: data, encoding: .utf8) ?? "json_request_failed")
        }
        return data
    }

    /// Open an SSE stream and yield parsed events. Caller cancels via Task cancellation.
    /// Monotonic one-way flag, safely readable across tasks (first-event watchdog).
    final class EventFlag: @unchecked Sendable {
        private(set) var raised = false
        func raise() { raised = true }
    }

    /// The server answered a (retried) send with a JSON duplicate-turn snapshot
    /// instead of SSE (Phase 3 idempotency) — the caller attaches to the existing
    /// turn's durable stream instead of executing anything again.
    struct DuplicateTurn: Error, Decodable {
        let turnId: String
        let conversationId: String?
        let status: String?
        let lastSeq: Int?
    }

    /// Phase 2 (roadmap 2.2/2.3): bytes are split + parsed + JSON-decoded OFF the
    /// main actor, then batched through `AgentEventBuffer` — MainActor sees at most
    /// ~25 applies/second, not one per token. Malformed payloads are telemetry,
    /// never a stream kill; cancellation propagates as CancellationError.
    /// `onSeq` fires with each durable frame's `id:` seq (replay cursor, PR 5).
    static func streamEvents(request: URLRequest,
                             buffer: AgentEventBuffer,
                             firstEvent: EventFlag? = nil,
                             onSeq: (@Sendable (Int) -> Void)? = nil) async throws {
        let (bytes, resp) = try await streamSession.bytes(for: request)
        guard let http = resp as? HTTPURLResponse else { throw AlmaAPIError.transport(URLError(.badServerResponse)) }
        if http.statusCode == 401 || http.statusCode == 403 || (300..<400).contains(http.statusCode) {
            throw AlmaAPIError.notAuthenticated
        }
        // Idempotent duplicate: 202 + JSON body carrying the existing turn.
        if http.statusCode == 202,
           (http.value(forHTTPHeaderField: "Content-Type") ?? "").contains("application/json") {
            var body = Data()
            for try await byte in bytes { body.append(byte) }
            if let dup = try? JSONDecoder().decode(DuplicateTurn.self, from: body) { throw dup }
            throw AlmaAPIError.http(status: 202, body: "duplicate")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AlmaAPIError.http(status: http.statusCode, body: "stream")
        }
        var parser = AlmaSSEParser()
        let decoder = JSONDecoder()

        func dispatch(_ payload: String) async {
            guard let d = payload.data(using: .utf8) else { return }
            guard let dto = try? decoder.decode(AgentSSEEvent.self, from: d) else {
                AlmaTurnLog.event("stream.malformedEvent", String(payload.prefix(80)))
                return                                   // one bad frame never kills the rest
            }
            firstEvent?.raise()
            let ev = AgentTurnEvent(dto: dto)
            if case .unknown(let t) = ev { AlmaTurnLog.event("stream.unknownEvent", t) }
            await buffer.push(ev)
        }

        var lineBuf: [UInt8] = []
        lineBuf.reserveCapacity(1024)
        for try await byte in bytes {
            if byte == 0x0A {                            // \n — CR handled by the parser
                let line = String(decoding: lineBuf, as: UTF8.self)
                lineBuf.removeAll(keepingCapacity: true)
                try Task.checkCancellation()
                if let payload = parser.consume(line: line) {
                    await dispatch(payload)
                    if let onSeq, let idStr = parser.lastEventId, let seq = Int(idStr) { onSeq(seq) }
                }
            } else {
                lineBuf.append(byte)
            }
        }
        // Trailing event without the final blank line (roadmap 2.2).
        if !lineBuf.isEmpty, let p = parser.consume(line: String(decoding: lineBuf, as: UTF8.self)) {
            await dispatch(p)
        }
        if let p = parser.flushTrailing() { await dispatch(p) }
        await buffer.finish()
    }

    /// DTO-callback variant on the SAME robust parser — the voice console needs
    /// per-event delivery (each text_delta feeds TTS immediately; batching would
    /// add spoken latency). Chat uses the buffered variant above.
    static func streamEvents(request: URLRequest,
                             stopOn: (@Sendable (AgentSSEEvent) -> Bool)? = nil,
                             onEvent: @MainActor @escaping (AgentSSEEvent) -> Void) async throws {
        let (bytes, resp) = try await streamSession.bytes(for: request)
        guard let http = resp as? HTTPURLResponse else { throw AlmaAPIError.transport(URLError(.badServerResponse)) }
        if http.statusCode == 401 || http.statusCode == 403 || (300..<400).contains(http.statusCode) {
            throw AlmaAPIError.notAuthenticated
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AlmaAPIError.http(status: http.statusCode, body: "stream")
        }
        var parser = AlmaSSEParser()
        let decoder = JSONDecoder()
        func dispatch(_ payload: String) async -> Bool {
            guard let d = payload.data(using: .utf8),
                  let ev = try? decoder.decode(AgentSSEEvent.self, from: d) else {
                AlmaTurnLog.event("stream.malformedEvent", String(payload.prefix(80)))
                return false
            }
            await onEvent(ev)
            return stopOn?(ev) ?? false
        }
        var lineBuf: [UInt8] = []
        lineBuf.reserveCapacity(1024)
        for try await byte in bytes {
            if byte == 0x0A {
                let line = String(decoding: lineBuf, as: UTF8.self)
                lineBuf.removeAll(keepingCapacity: true)
                try Task.checkCancellation()
                // A caller-supplied terminal event (e.g. "done") ends the await
                // immediately — some deployments keep the SSE socket open with
                // keepalives after the turn, which left voice turns hanging
                // until the stall watchdog killed them (sim finding 2026-07-23:
                // the head answered in 24s but the reply was never spoken).
                if let payload = parser.consume(line: line), await dispatch(payload) { return }
            } else {
                lineBuf.append(byte)
            }
        }
        if !lineBuf.isEmpty, let p = parser.consume(line: String(decoding: lineBuf, as: UTF8.self)) {
            _ = await dispatch(p)
        }
        if let p = parser.flushTrailing() { _ = await dispatch(p) }
    }
}

/// Same policy as AlmaAPI's RedirectBlocker (private there): a 307 → /login must
/// surface as a status code, not a silently-followed login HTML page.
final class AssistantRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        #if DEBUG
        // Vercel's temporary preview-access URL performs one same-resource 307
        // solely to set its short-lived cookie and remove `_vercel_share`. Allow
        // that exact debug-preview hop; auth redirects to /login and every
        // cross-host/path redirect remain blocked below.
        if response.statusCode == 307,
           let original = task.originalRequest?.url,
           let redirect = request.url,
           original.host == redirect.host,
           original.path == redirect.path,
           URLComponents(url: original, resolvingAgainstBaseURL: false)?
            .queryItems?.contains(where: { $0.name == "_vercel_share" }) == true {
            completionHandler(request)
            return
        }
        #endif
        completionHandler(nil)
    }
}


/// One entry of a multi-question ask card ("questions" on the ask_card event).
struct AgentAskQuestionWire: Decodable, Equatable, Sendable {
    let question: String
    let options: [String]
}
