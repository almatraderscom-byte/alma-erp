import XCTest
@testable import App

final class LiveVoicePhase1BTests: XCTestCase {
    private func contractData() throws -> Data {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try Data(contentsOf: root
            .appendingPathComponent("config/live-voice/live-voice-v1.json"))
    }

    private func contract() throws -> AlmaLiveVoiceContract {
        try AlmaLiveVoiceContract.decodeStrict(contractData())
    }

    func testContractOwnsDefaultsCapabilitiesAndBoundedContext() throws {
        let contract = try contract()
        XCTAssertEqual(contract.contractVersion, "live-voice-2026-08-11-v1")
        XCTAssertEqual(contract.schemaVersion, 1)
        XCTAssertEqual(contract.defaults.modelID, contract.enabledModels[0].id)
        XCTAssertEqual(contract.defaults.voiceID, "Aoede")
        XCTAssertEqual(contract.contextCompression.triggerTokens, 25_000)
        XCTAssertEqual(contract.contextCompression.targetTokens, 8_000)
        XCTAssertEqual(
            contract.contextCompression.sourceURL,
            "https://ai.google.dev/gemini-api/docs/live-api/best-practices")
        XCTAssertEqual(contract.contextCompression.verifiedAt, "2026-08-11")
        XCTAssertEqual(contract.localBudget.audioTokensPerSecond, 25)
        XCTAssertLessThan(
            contract.contextCompression.targetTokens,
            contract.contextCompression.triggerTokens)
        XCTAssertTrue(contract.enabledModels[0].capabilities.affectiveDialog)
        XCTAssertEqual(
            contract.enabledModels[1].capabilities.functionCallingMode,
            "synchronous-only")
    }

    func testBuiltProductCarriesTheExactCanonicalContract() throws {
        XCTAssertEqual(
            try AlmaLiveVoiceContractStore.load(bundle: .main),
            try contract())
    }

    func testSelectionMigrationPreservesValidLegacyAndBoundsUnknownValues() throws {
        let contract = try contract()
        let preserved = contract.migrate(.init(
            selectionVersion: 0,
            modelID: "gemini-3.1-flash-live-preview",
            voiceID: "Kore"))
        XCTAssertEqual(preserved.selectionVersion, 1)
        XCTAssertEqual(preserved.modelID, "gemini-3.1-flash-live-preview")
        XCTAssertEqual(preserved.voiceID, "Kore")
        XCTAssertTrue(preserved.migrated)

        let bounded = contract.migrate(.init(
            selectionVersion: 0,
            modelID: "retired-model",
            voiceID: "removed-voice"))
        XCTAssertEqual(bounded.modelID, contract.defaults.modelID)
        XCTAssertEqual(bounded.voiceID, contract.defaults.voiceID)
    }

    func testRolloutGateAndMalformedContractAtomicallyReturnLegacyPath() throws {
        let data = try contractData()
        XCTAssertNil(AlmaLiveVoiceContractStore.active(featureEnabled: false, data: data))
        XCTAssertNotNil(AlmaLiveVoiceContractStore.active(featureEnabled: true, data: data))
        XCTAssertNil(AlmaLiveVoiceContractStore.active(
            featureEnabled: true,
            data: Data(#"{"schemaVersion":1,"unexpected":true}"#.utf8)))
    }

    func testStrictContractRejectsDuplicateRootDefaultAndEnabledKeys() throws {
        let source = try XCTUnwrap(String(data: contractData(), encoding: .utf8))
        let duplicates = [
            source.replacingOccurrences(
                of: #""schemaVersion": 1,"#,
                with: #""schemaVersion": 1, "schema\u0056ersion": 1,"#),
            source.replacingOccurrences(
                of: #""modelID": "gemini-2.5-flash-native-audio-preview-12-2025""#,
                with: #""modelID": "gemini-3.1-flash-live-preview", "modelID": "gemini-2.5-flash-native-audio-preview-12-2025""#),
            source.replacingOccurrences(
                of: #""enabled": true,"#,
                with: #""enabled": false, "enabled": true,"#),
        ]

        for duplicate in duplicates {
            XCTAssertThrowsError(try AlmaLiveVoiceContract.decodeStrict(Data(duplicate.utf8))) {
                XCTAssertTrue(
                    String(describing: $0).contains("duplicate key"),
                    "unexpected error: \($0)")
            }
        }
    }

    func testBudgetUsesProviderTokensAndTransitionsAtExactBounds() throws {
        let contract = try contract()
        let warningReport = report(outputAudioTokens: 62_500)
        let warning = AlmaLiveVoiceLocalBudgetEvaluator.evaluate(
            report: warningReport,
            contract: contract)
        XCTAssertEqual(warning.estimatedMicroUSD, 750_000)
        XCTAssertEqual(warning.disposition, .warning)

        let terminated = AlmaLiveVoiceLocalBudgetEvaluator.evaluate(
            report: report(outputAudioTokens: 83_334),
            contract: contract)
        XCTAssertEqual(terminated.estimatedMicroUSD, 1_000_008)
        XCTAssertEqual(terminated.disposition, .terminate)
    }

    func testBudgetGuardAlertsAndTerminatesAtMostOnce() {
        var guardrail = AlmaLiveVoiceLocalBudgetGuard()
        let warning = AlmaLiveVoiceLocalBudgetEvaluation(
            disposition: .warning,
            estimatedMicroUSD: 750_000,
            unresolvedTranscription: false,
            unpricedSegmentCount: 0)
        let termination = AlmaLiveVoiceLocalBudgetEvaluation(
            disposition: .terminate,
            estimatedMicroUSD: 1_000_000,
            unresolvedTranscription: false,
            unpricedSegmentCount: 0)

        XCTAssertEqual(
            guardrail.consume(warning),
            .alert(estimatedMicroUSD: 750_000))
        XCTAssertNil(guardrail.consume(warning))
        XCTAssertEqual(
            guardrail.consume(termination),
            .terminate(estimatedMicroUSD: 1_000_000))
        XCTAssertNil(guardrail.consume(termination))
    }

    func testBudgetFallsBackToMeasuredPCMWithoutGuessingTranscriptTokens() throws {
        let contract = try contract()
        var segment = AlmaLiveVoiceUsageSegment(
            model: contract.defaults.modelID,
            voice: contract.defaults.voiceID)
        segment.inputAudioQueuedBytes = 16_000 * 2 * 40
        segment.outputAudioReceivedBytes = 24_000 * 2 * 20
        segment.inputTranscriptionCharacters = 100
        segment.outputTranscriptionCharacters = 200
        let report = AlmaLiveVoiceUsageReport(
            callId: "call-budget-pcm",
            conversationId: nil,
            segments: [segment])

        let evaluation = AlmaLiveVoiceLocalBudgetEvaluator.evaluate(
            report: report,
            contract: contract)
        XCTAssertEqual(evaluation.estimatedMicroUSD, 9_000)
        XCTAssertTrue(evaluation.unresolvedTranscription)
        XCTAssertEqual(evaluation.disposition, .withinBudget)
    }

    private func report(outputAudioTokens: Int) -> AlmaLiveVoiceUsageReport {
        var segment = AlmaLiveVoiceUsageSegment(
            model: "gemini-2.5-flash-native-audio-preview-12-2025",
            voice: "Aoede")
        segment.providerUsage.outputAudioTokens = outputAudioTokens
        return .init(
            callId: "call-budget-provider",
            conversationId: nil,
            segments: [segment])
    }
}
