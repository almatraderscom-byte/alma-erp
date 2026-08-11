import Foundation

struct AlmaLiveVoiceContract: Decodable, Equatable {
    struct Defaults: Decodable, Equatable {
        let modelID: String
        let voiceID: String
    }

    struct ContextCompression: Decodable, Equatable {
        let triggerTokens: Int
        let targetTokens: Int
        let sourceURL: String
        let verifiedAt: String
    }

    struct LocalBudget: Decodable, Equatable {
        let warningMicroUSD: Int
        let terminationMicroUSD: Int
        let pollIntervalMilliseconds: Int
        let audioTokensPerSecond: Double
    }

    struct Thinking: Decodable, Equatable {
        let mode: String
        let budget: Int?
        let level: String?
    }

    struct Capabilities: Decodable, Equatable {
        let affectiveDialog: Bool
        let functionCallingMode: String
        let thinking: Thinking
        let inputAudioTranscription: Bool
        let outputAudioTranscription: Bool
    }

    struct Pricing: Decodable, Equatable {
        let inputText: Double
        let inputAudio: Double
        let outputText: Double
        let outputAudio: Double
    }

    struct ModelDisplay: Decodable, Equatable {
        let title: String
        let detail: String
        let badge: String
        let strengths: String
        let limitations: String
        let costLifecycle: String
        let bestUse: String
    }

    struct Model: Decodable, Equatable {
        let id: String
        let enabled: Bool
        let lifecycle: String
        let replacementModelID: String?
        let capabilities: Capabilities
        let pricingUSDPerMillionTokens: Pricing
        let display: ModelDisplay
    }

    struct VoiceDisplay: Decodable, Equatable {
        let name: String
        let detail: String
        let symbol: String
    }

    struct Voice: Decodable, Equatable {
        let id: String
        let enabled: Bool
        let display: VoiceDisplay
    }

    struct Migration: Decodable, Equatable {
        let fromSelectionVersion: Int
        let toSelectionVersion: Int
        let modelReplacements: [String: String]
        let voiceReplacements: [String: String]
    }

    let schemaVersion: Int
    let contractVersion: String
    let defaults: Defaults
    let contextCompression: ContextCompression
    let localBudget: LocalBudget
    let models: [Model]
    let voices: [Voice]
    let migrations: [Migration]

    var enabledModels: [Model] { models.filter(\.enabled) }
    var enabledVoices: [Voice] { voices.filter(\.enabled) }

    func model(id: String) -> Model? {
        models.first { $0.id == id && $0.enabled }
    }

    func voice(id: String) -> Voice? {
        voices.first { $0.id == id && $0.enabled }
    }

    var modelChoices: [AlmaLiveModelChoice] {
        enabledModels.map { model in
            .init(
                id: model.id,
                title: model.display.title,
                detail: model.display.detail,
                badge: model.display.badge,
                strengths: model.display.strengths,
                limitations: model.display.limitations,
                costLifecycle: model.display.costLifecycle,
                bestUse: model.display.bestUse)
        }
    }

    var voiceChoices: [AlmaLiveVoiceChoice] {
        enabledVoices.map { voice in
            .init(
                id: voice.id,
                name: voice.display.name,
                detail: voice.display.detail,
                symbol: voice.display.symbol)
        }
    }
}

enum AlmaLiveVoiceContractError: Error, Equatable {
    case malformed(String)
    case unsupportedSchema(Int)
    case invalid(String)
}

extension AlmaLiveVoiceContract {
    static func decodeStrict(_ data: Data) throws -> AlmaLiveVoiceContract {
        do {
            var scanner = JSONDuplicateKeyScanner(data: data)
            try scanner.validate()
        } catch let error as AlmaLiveVoiceContractError {
            throw error
        } catch {
            throw AlmaLiveVoiceContractError.malformed("invalid JSON token stream")
        }
        let raw: Any
        do {
            raw = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw AlmaLiveVoiceContractError.malformed("invalid JSON")
        }
        try validateShape(raw)

        let contract: AlmaLiveVoiceContract
        do {
            contract = try JSONDecoder().decode(AlmaLiveVoiceContract.self, from: data)
        } catch {
            throw AlmaLiveVoiceContractError.malformed("contract fields do not decode")
        }
        try contract.validateValues()
        return contract
    }

    /// Foundation accepts duplicate JSON object keys and keeps one value. This
    /// bounded parser rejects duplicates (including escaped-equivalent keys)
    /// before either JSONSerialization or Codable can erase that evidence.
    private struct JSONDuplicateKeyScanner {
        private let bytes: [UInt8]
        private var index = 0

        init(data: Data) { bytes = Array(data) }

        mutating func validate() throws {
            skipWhitespace()
            try parseValue()
            skipWhitespace()
            guard index == bytes.count else { try malformed("trailing JSON bytes") }
        }

        private mutating func parseValue() throws {
            skipWhitespace()
            guard let byte = current else { try malformed("missing JSON value") }
            switch byte {
            case UInt8(ascii: "{"):
                try parseObject()
            case UInt8(ascii: "["):
                try parseArray()
            case UInt8(ascii: "\""):
                _ = try parseString()
            case UInt8(ascii: "t"):
                try consumeLiteral("true")
            case UInt8(ascii: "f"):
                try consumeLiteral("false")
            case UInt8(ascii: "n"):
                try consumeLiteral("null")
            default:
                try parseNumber()
            }
        }

        private mutating func parseObject() throws {
            try consume(UInt8(ascii: "{"))
            skipWhitespace()
            if consumeIf(UInt8(ascii: "}")) { return }
            var keys = Set<String>()
            while true {
                skipWhitespace()
                let key = try parseString()
                guard keys.insert(key).inserted else {
                    throw AlmaLiveVoiceContractError.malformed("duplicate key: \(key)")
                }
                skipWhitespace()
                try consume(UInt8(ascii: ":"))
                try parseValue()
                skipWhitespace()
                if consumeIf(UInt8(ascii: "}")) { return }
                try consume(UInt8(ascii: ","))
            }
        }

        private mutating func parseArray() throws {
            try consume(UInt8(ascii: "["))
            skipWhitespace()
            if consumeIf(UInt8(ascii: "]")) { return }
            while true {
                try parseValue()
                skipWhitespace()
                if consumeIf(UInt8(ascii: "]")) { return }
                try consume(UInt8(ascii: ","))
            }
        }

        private mutating func parseString() throws -> String {
            guard current == UInt8(ascii: "\"") else {
                try malformed("object key/string expected")
            }
            let start = index
            index += 1
            while let byte = current {
                if byte == UInt8(ascii: "\"") {
                    index += 1
                    let encoded = Data(bytes[start..<index])
                    guard let value = try? JSONDecoder().decode(String.self, from: encoded) else {
                        try malformed("invalid JSON string")
                    }
                    return value
                }
                if byte == UInt8(ascii: "\\") {
                    index += 1
                    guard let escaped = current else { try malformed("unterminated escape") }
                    if escaped == UInt8(ascii: "u") {
                        index += 1
                        for _ in 0..<4 {
                            guard let scalar = current,
                                  (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(scalar)
                                    || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(scalar)
                                    || (UInt8(ascii: "A")...UInt8(ascii: "F")).contains(scalar)
                            else { try malformed("invalid unicode escape") }
                            index += 1
                        }
                    } else {
                        guard [0x22, 0x5C, 0x2F, 0x62, 0x66, 0x6E, 0x72, 0x74]
                            .contains(escaped)
                        else { try malformed("invalid string escape") }
                        index += 1
                    }
                } else {
                    guard byte >= 0x20 else { try malformed("control byte in string") }
                    index += 1
                }
            }
            try malformed("unterminated JSON string")
        }

        private mutating func parseNumber() throws {
            let start = index
            while let byte = current,
                  ![UInt8(ascii: ","), UInt8(ascii: "]"), UInt8(ascii: "}"),
                    UInt8(ascii: " "), UInt8(ascii: "\n"), UInt8(ascii: "\r"),
                    UInt8(ascii: "\t")].contains(byte) {
                index += 1
            }
            guard index > start else { try malformed("invalid JSON number") }
        }

        private mutating func consumeLiteral(_ literal: String) throws {
            for byte in literal.utf8 { try consume(byte) }
        }

        private mutating func consume(_ expected: UInt8) throws {
            guard current == expected else { try malformed("unexpected JSON token") }
            index += 1
        }

        private mutating func consumeIf(_ expected: UInt8) -> Bool {
            guard current == expected else { return false }
            index += 1
            return true
        }

        private mutating func skipWhitespace() {
            while let byte = current,
                  [UInt8(ascii: " "), UInt8(ascii: "\n"), UInt8(ascii: "\r"),
                   UInt8(ascii: "\t")].contains(byte) {
                index += 1
            }
        }

        private var current: UInt8? { index < bytes.count ? bytes[index] : nil }

        private func malformed(_ reason: String) throws -> Never {
            throw AlmaLiveVoiceContractError.malformed(reason)
        }
    }

    private static func validateShape(_ raw: Any) throws {
        let root = try object(
            raw,
            allowed: [
                "schemaVersion", "contractVersion", "defaults", "contextCompression",
                "localBudget", "models", "voices", "migrations",
            ],
            path: "contract")
        _ = try object(
            root["defaults"],
            allowed: ["modelID", "voiceID"],
            path: "defaults")
        _ = try object(
            root["contextCompression"],
            allowed: ["triggerTokens", "targetTokens", "sourceURL", "verifiedAt"],
            path: "contextCompression")
        _ = try object(
            root["localBudget"],
            allowed: [
                "warningMicroUSD", "terminationMicroUSD", "pollIntervalMilliseconds",
                "audioTokensPerSecond",
            ],
            path: "localBudget")

        for (index, rawModel) in try array(root["models"], path: "models").enumerated() {
            let model = try object(
                rawModel,
                allowed: [
                    "id", "enabled", "lifecycle", "replacementModelID", "capabilities",
                    "pricingUSDPerMillionTokens", "display",
                ],
                path: "models[\(index)]")
            let capabilities = try object(
                model["capabilities"],
                allowed: [
                    "affectiveDialog", "functionCallingMode", "thinking",
                    "inputAudioTranscription", "outputAudioTranscription",
                ],
                path: "models[\(index)].capabilities")
            _ = try object(
                capabilities["thinking"],
                allowed: ["mode", "budget", "level"],
                path: "models[\(index)].capabilities.thinking")
            _ = try object(
                model["pricingUSDPerMillionTokens"],
                allowed: ["inputText", "inputAudio", "outputText", "outputAudio"],
                path: "models[\(index)].pricingUSDPerMillionTokens")
            _ = try object(
                model["display"],
                allowed: [
                    "title", "detail", "badge", "strengths", "limitations",
                    "costLifecycle", "bestUse",
                ],
                path: "models[\(index)].display")
        }

        for (index, rawVoice) in try array(root["voices"], path: "voices").enumerated() {
            let voice = try object(
                rawVoice,
                allowed: ["id", "enabled", "display"],
                path: "voices[\(index)]")
            _ = try object(
                voice["display"],
                allowed: ["name", "detail", "symbol"],
                path: "voices[\(index)].display")
        }

        for (index, rawMigration) in try array(
            root["migrations"], path: "migrations"
        ).enumerated() {
            _ = try object(
                rawMigration,
                allowed: [
                    "fromSelectionVersion", "toSelectionVersion",
                    "modelReplacements", "voiceReplacements",
                ],
                path: "migrations[\(index)]")
        }
    }

    private static func object(
        _ raw: Any?,
        allowed: Set<String>,
        path: String
    ) throws -> [String: Any] {
        guard let value = raw as? [String: Any] else {
            throw AlmaLiveVoiceContractError.malformed("expected object at \(path)")
        }
        let unknown = Set(value.keys).subtracting(allowed)
        guard unknown.isEmpty else {
            throw AlmaLiveVoiceContractError.malformed(
                "unexpected keys at \(path): \(unknown.sorted().joined(separator: ","))")
        }
        return value
    }

    private static func array(_ raw: Any?, path: String) throws -> [Any] {
        guard let value = raw as? [Any] else {
            throw AlmaLiveVoiceContractError.malformed("expected array at \(path)")
        }
        return value
    }

    private func validateValues() throws {
        guard schemaVersion == 1 else {
            throw AlmaLiveVoiceContractError.unsupportedSchema(schemaVersion)
        }
        guard contractVersion.range(
            of: #"^live-voice-\d{4}-\d{2}-\d{2}-v\d+$"#,
            options: .regularExpression) != nil
        else { throw AlmaLiveVoiceContractError.invalid("contract version") }
        guard contextCompression.targetTokens > 0,
              contextCompression.targetTokens < contextCompression.triggerTokens,
              contextCompression.sourceURL
                == "https://ai.google.dev/gemini-api/docs/live-api/best-practices",
              contextCompression.verifiedAt == "2026-08-11"
        else { throw AlmaLiveVoiceContractError.invalid("context compression bounds") }
        guard localBudget.warningMicroUSD > 0,
              localBudget.warningMicroUSD < localBudget.terminationMicroUSD,
              (100...5_000).contains(localBudget.pollIntervalMilliseconds),
              localBudget.audioTokensPerSecond.isFinite,
              localBudget.audioTokensPerSecond > 0
        else { throw AlmaLiveVoiceContractError.invalid("local budget bounds") }

        let modelIDs = Set(models.map(\.id))
        let voiceIDs = Set(voices.map(\.id))
        guard !models.isEmpty, modelIDs.count == models.count,
              !voices.isEmpty, voiceIDs.count == voices.count
        else { throw AlmaLiveVoiceContractError.invalid("duplicate or empty catalog") }
        guard model(id: defaults.modelID) != nil, voice(id: defaults.voiceID) != nil else {
            throw AlmaLiveVoiceContractError.invalid("disabled or missing default")
        }
        guard migrations.contains(where: {
            $0.fromSelectionVersion == 0 && $0.toSelectionVersion == schemaVersion
        }) else { throw AlmaLiveVoiceContractError.invalid("missing v0 migration") }

        for model in models {
            guard ["preview", "stable", "retired"].contains(model.lifecycle),
                  model.replacementModelID.map(modelIDs.contains) ?? true,
                  ["synchronous-only", "synchronous-and-asynchronous"]
                    .contains(model.capabilities.functionCallingMode)
            else { throw AlmaLiveVoiceContractError.invalid("model lifecycle/capability") }
            switch model.capabilities.thinking.mode {
            case "budget":
                guard let budget = model.capabilities.thinking.budget,
                      budget >= 0,
                      model.capabilities.thinking.level == nil
                else { throw AlmaLiveVoiceContractError.invalid("thinking budget") }
            case "level":
                guard let level = model.capabilities.thinking.level,
                      ["MINIMAL", "LOW", "MEDIUM", "HIGH"].contains(level),
                      model.capabilities.thinking.budget == nil
                else { throw AlmaLiveVoiceContractError.invalid("thinking level") }
            default:
                throw AlmaLiveVoiceContractError.invalid("thinking mode")
            }
            let pricing = model.pricingUSDPerMillionTokens
            guard [pricing.inputText, pricing.inputAudio, pricing.outputText, pricing.outputAudio]
                .allSatisfy({ $0.isFinite && $0 >= 0 })
            else { throw AlmaLiveVoiceContractError.invalid("model pricing") }
        }
    }
}

struct AlmaLiveVoiceStoredSelection: Equatable {
    let selectionVersion: Int?
    let modelID: String?
    let voiceID: String?
}

struct AlmaLiveVoiceMigratedSelection: Equatable {
    let selectionVersion: Int
    let modelID: String
    let voiceID: String
    let migrated: Bool
}

extension AlmaLiveVoiceContract {
    func migrate(_ stored: AlmaLiveVoiceStoredSelection) -> AlmaLiveVoiceMigratedSelection {
        let originalVersion = max(0, stored.selectionVersion ?? 0)
        var version = originalVersion
        var modelID = stored.modelID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var voiceID = stored.voiceID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var steps = 0

        while version < schemaVersion, steps <= migrations.count,
              let migration = migrations.first(where: {
                  $0.fromSelectionVersion == version
                      && $0.toSelectionVersion > version
                      && $0.toSelectionVersion <= schemaVersion
              }) {
            modelID = migration.modelReplacements[modelID] ?? modelID
            voiceID = migration.voiceReplacements[voiceID] ?? voiceID
            version = migration.toSelectionVersion
            steps += 1
        }

        if model(id: modelID) == nil {
            let replacementID = models.first(where: { $0.id == modelID })?.replacementModelID
            modelID = replacementID.flatMap { model(id: $0)?.id } ?? defaults.modelID
        }
        if voice(id: voiceID) == nil { voiceID = defaults.voiceID }
        version = schemaVersion

        return .init(
            selectionVersion: version,
            modelID: modelID,
            voiceID: voiceID,
            migrated: originalVersion != version
                || stored.modelID != modelID
                || stored.voiceID != voiceID)
    }
}

enum AlmaLiveVoiceContractStore {
    static let resourceName = "live-voice-v1"
    static let resourceSubdirectory = "LiveVoice"

    static func load(bundle: Bundle = .main) throws -> AlmaLiveVoiceContract {
        guard let url = bundle.url(
            forResource: resourceName,
            withExtension: "json",
            subdirectory: resourceSubdirectory)
        else { throw AlmaLiveVoiceContractError.malformed("bundled contract missing") }
        return try AlmaLiveVoiceContract.decodeStrict(Data(contentsOf: url))
    }

    /// Turning the rollout gate off, or failing to load an exact contract,
    /// returns nil so callers atomically retain the legacy profile behavior.
    static func active(
        featureEnabled: Bool,
        bundle: Bundle = .main
    ) -> AlmaLiveVoiceContract? {
        guard featureEnabled else { return nil }
        return try? load(bundle: bundle)
    }

    static func active(featureEnabled: Bool, data: Data) -> AlmaLiveVoiceContract? {
        guard featureEnabled else { return nil }
        return try? AlmaLiveVoiceContract.decodeStrict(data)
    }
}

enum AlmaLiveVoiceLocalBudgetDisposition: String, Equatable {
    case withinBudget
    case warning
    case terminate
}

struct AlmaLiveVoiceLocalBudgetEvaluation: Equatable {
    let disposition: AlmaLiveVoiceLocalBudgetDisposition
    let estimatedMicroUSD: Int
    let unresolvedTranscription: Bool
    let unpricedSegmentCount: Int
}

enum AlmaLiveVoiceLocalBudgetAction: Equatable {
    case alert(estimatedMicroUSD: Int)
    case terminate(estimatedMicroUSD: Int)
}

struct AlmaLiveVoiceLocalBudgetGuard: Equatable {
    private(set) var didAlert = false
    private(set) var didTerminate = false

    mutating func consume(
        _ evaluation: AlmaLiveVoiceLocalBudgetEvaluation
    ) -> AlmaLiveVoiceLocalBudgetAction? {
        guard !didTerminate else { return nil }
        switch evaluation.disposition {
        case .withinBudget:
            return nil
        case .warning where !didAlert:
            didAlert = true
            return .alert(estimatedMicroUSD: evaluation.estimatedMicroUSD)
        case .warning:
            return nil
        case .terminate:
            didTerminate = true
            return .terminate(estimatedMicroUSD: evaluation.estimatedMicroUSD)
        }
    }
}

enum AlmaLiveVoiceLocalBudgetEvaluator {
    private static let inputPCMBytesPerSecond = 16_000 * 2
    private static let outputPCMBytesPerSecond = 24_000 * 2
    /// Uses provider modality tokens when present. Otherwise it prices only the
    /// PCM bytes already accepted/received at the measured audio boundary.
    /// Transcript character counts remain explicitly unresolved, never guessed.
    static func evaluate(
        report: AlmaLiveVoiceUsageReport?,
        contract: AlmaLiveVoiceContract
    ) -> AlmaLiveVoiceLocalBudgetEvaluation {
        var microUSD = 0.0
        var unresolvedTranscription = false
        var unpricedSegmentCount = 0

        for segment in report?.segments ?? [] {
            guard let model = contract.model(id: segment.model) else {
                unpricedSegmentCount += 1
                continue
            }
            let usage = segment.providerUsage
            let inputAudioTokens = usage.inputAudioTokens > 0
                ? Double(usage.inputAudioTokens)
                : Double(max(0, segment.inputAudioQueuedBytes))
                    / Double(inputPCMBytesPerSecond) * contract.localBudget.audioTokensPerSecond
            let outputAudioTokens = usage.outputAudioTokens > 0
                ? Double(usage.outputAudioTokens)
                : Double(max(0, segment.outputAudioReceivedBytes))
                    / Double(outputPCMBytesPerSecond) * contract.localBudget.audioTokensPerSecond
            let pricing = model.pricingUSDPerMillionTokens
            // USD-per-million-token converts directly to micro-USD-per-token.
            microUSD += inputAudioTokens * pricing.inputAudio
                + outputAudioTokens * pricing.outputAudio
                + Double(max(0, usage.inputTextTokens)) * pricing.inputText
                + Double(max(0, usage.outputTextTokens)) * pricing.outputText
            if segment.inputTranscriptionCharacters + segment.outputTranscriptionCharacters > 0,
               usage.inputTextTokens + usage.outputTextTokens == 0 {
                unresolvedTranscription = true
            }
        }

        let estimatedMicroUSD: Int
        if !microUSD.isFinite || microUSD >= Double(Int.max) {
            estimatedMicroUSD = Int.max
        } else {
            estimatedMicroUSD = max(0, Int(ceil(microUSD)))
        }
        let disposition: AlmaLiveVoiceLocalBudgetDisposition
        if unpricedSegmentCount > 0
            || estimatedMicroUSD >= contract.localBudget.terminationMicroUSD {
            disposition = .terminate
        } else if estimatedMicroUSD >= contract.localBudget.warningMicroUSD {
            disposition = .warning
        } else {
            disposition = .withinBudget
        }
        return .init(
            disposition: disposition,
            estimatedMicroUSD: estimatedMicroUSD,
            unresolvedTranscription: unresolvedTranscription,
            unpricedSegmentCount: unpricedSegmentCount)
    }
}
