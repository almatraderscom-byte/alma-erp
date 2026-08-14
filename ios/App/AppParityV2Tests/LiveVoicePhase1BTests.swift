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
        XCTAssertEqual(contract.contractVersion, "live-voice-2026-08-12-v2")
        XCTAssertEqual(contract.schemaVersion, 1)
        // 2026-08-14: the proven 3.1/Charon pair is the default (July bake-off
        // verdict, restored after the build-103 outage); 2.5 stays selectable.
        XCTAssertEqual(contract.defaults.modelID, contract.enabledModels[1].id)
        XCTAssertEqual(contract.defaults.modelID, "gemini-3.1-flash-live-preview")
        XCTAssertEqual(contract.defaults.voiceID, "Charon")
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
        // Affective dialog is off contract-wide: unusable over the
        // ephemeral-token transport (build-103 outage root cause).
        XCTAssertFalse(contract.enabledModels[0].capabilities.affectiveDialog)
        XCTAssertEqual(
            contract.enabledModels[1].capabilities.functionCallingMode,
            "synchronous-only")
    }

    func testBuiltProductCarriesTheExactCanonicalContract() throws {
        XCTAssertEqual(
            try AlmaLiveVoiceContractStore.load(bundle: .main),
            try contract())
    }

    func testDecodedCanonicalSessionSemanticsMatchSwiftRuntimePayload() throws {
        let protocolContract = try contract().sessionProtocol
        let canonicalData = try JSONEncoder().encode(protocolContract)
        let canonicalObject = try JSONSerialization.jsonObject(with: canonicalData)
        let runtimeObject: [String: Any] = [
            "systemInstruction": protocolContract.systemInstruction,
            "functionDeclarations": protocolContract.geminiFunctionDeclarations,
        ]

        XCTAssertEqual(
            try JSONSerialization.data(withJSONObject: runtimeObject, options: [.sortedKeys]),
            try JSONSerialization.data(withJSONObject: canonicalObject, options: [.sortedKeys]))
        XCTAssertEqual(
            protocolContract.functionDeclarations.map(\.name),
            ["quick_erp_lookup", "end_call", "run_agent_turn"])
        XCTAssertFalse(protocolContract.systemInstruction.contains("STATUS_NOTE"))
        XCTAssertFalse(protocolContract.systemInstruction.contains("NON_BLOCKING"))
    }

    func testSelectionMigrationPreservesValidLegacyAndBoundsUnknownValues() throws {
        let contract = try contract()
        let firstInstall = contract.migrate(.init(
            selectionVersion: nil,
            modelID: nil,
            voiceID: nil))
        XCTAssertEqual(firstInstall.selectionVersion, contract.schemaVersion)
        XCTAssertEqual(firstInstall.modelID, contract.defaults.modelID)
        XCTAssertEqual(firstInstall.voiceID, contract.defaults.voiceID)
        XCTAssertTrue(firstInstall.migrated,
                      "first install must persist one canonical selection version")

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

    func testSelectionMigrationReplacesAContractDeclaredRetiredModel() throws {
        var source = try XCTUnwrap(String(data: contractData(), encoding: .utf8))
        let legacyID = "gemini-2.5-flash-native-audio-preview-12-2025"
        let replacementID = "gemini-3.1-flash-live-preview"
        // The shipping default is already the replacement (3.1) — only the
        // legacy model needs retiring for this scenario.
        let modelNeedle = "\"id\": \"gemini-2.5-flash-native-audio-preview-12-2025\",\n      \"enabled\": true"
        let modelRange = try XCTUnwrap(source.range(of: modelNeedle))
        source.replaceSubrange(
            modelRange,
            with: "\"id\": \"gemini-2.5-flash-native-audio-preview-12-2025\",\n      \"enabled\": false")
        let retiredContract = try AlmaLiveVoiceContract.decodeStrict(Data(source.utf8))

        let migrated = retiredContract.migrate(.init(
            selectionVersion: retiredContract.schemaVersion,
            modelID: legacyID,
            voiceID: "Kore"))
        XCTAssertEqual(migrated.modelID, replacementID)
        XCTAssertEqual(migrated.voiceID, "Kore")
        XCTAssertTrue(migrated.migrated)
    }

    func testRemoteKillAcceptsOnlyExactContractDeclaredReplacement() throws {
        let contract = try contract()
        let replacement = "gemini-3.1-flash-live-preview"
        func failure(
            status: Int = 503,
            contractVersion: String? = nil,
            replacementModel: String? = replacement
        ) throws -> AlmaAPIError {
            var body: [String: Any] = [
                "error": "live_model_remotely_disabled",
                "contractVersion": contractVersion ?? contract.contractVersion,
            ]
            body["replacementModel"] = replacementModel ?? NSNull()
            let data = try JSONSerialization.data(withJSONObject: body)
            return .http(
                status: status,
                body: try XCTUnwrap(String(data: data, encoding: .utf8)))
        }

        // The model with a declared replacement is 2.5 (its replacement is the
        // 3.1 default); the default itself declares none.
        let killableModelID = "gemini-2.5-flash-native-audio-preview-12-2025"
        XCTAssertEqual(
            AlmaLiveVoiceRemoteReplacementPolicy.replacementModelID(
                for: try failure(),
                currentModelID: killableModelID,
                contract: contract),
            replacement)
        XCTAssertNil(AlmaLiveVoiceRemoteReplacementPolicy.replacementModelID(
            for: try failure(status: 500),
            currentModelID: killableModelID,
            contract: contract))
        XCTAssertNil(AlmaLiveVoiceRemoteReplacementPolicy.replacementModelID(
            for: try failure(contractVersion: "stale-contract"),
            currentModelID: contract.defaults.modelID,
            contract: contract))
        XCTAssertNil(AlmaLiveVoiceRemoteReplacementPolicy.replacementModelID(
            for: try failure(replacementModel: "unknown-model"),
            currentModelID: contract.defaults.modelID,
            contract: contract))
        XCTAssertNil(AlmaLiveVoiceRemoteReplacementPolicy.replacementModelID(
            for: try failure(replacementModel: nil),
            currentModelID: killableModelID,
            contract: contract))
        XCTAssertNil(AlmaLiveVoiceRemoteReplacementPolicy.replacementModelID(
            for: try failure(replacementModel: contract.defaults.modelID),
            currentModelID: contract.defaults.modelID,
            contract: contract),
            "a known enabled model is not selectable unless it is the declared replacement")
        XCTAssertNil(AlmaLiveVoiceRemoteReplacementPolicy.replacementModelID(
            for: try failure(),
            currentModelID: replacement,
            contract: contract),
            "a response declared for another current model must be rejected")
    }

    func testRetiredLifecycleIsNeverSelectableEvenWhenEnabled() throws {
        var source = try XCTUnwrap(String(data: contractData(), encoding: .utf8))
        // Retiring the DEFAULT would fail contract validation outright, so the
        // negative fixture retires the selectable non-default model instead.
        let retiredID = "gemini-2.5-flash-native-audio-preview-12-2025"
        let selectableNeedle = "\"id\": \"\(retiredID)\",\n      \"enabled\": true,\n      \"lifecycle\": \"preview\""
        let retiredRange = try XCTUnwrap(source.range(of: selectableNeedle))
        source.replaceSubrange(
            retiredRange,
            with: "\"id\": \"\(retiredID)\",\n      \"enabled\": true,\n      \"lifecycle\": \"retired\"")
        let retiredContract = try AlmaLiveVoiceContract.decodeStrict(Data(source.utf8))
        let retiredModel = try XCTUnwrap(
            retiredContract.models.first(where: { $0.id == retiredID }))

        XCTAssertTrue(retiredModel.enabled, "the negative fixture must remain enabled")
        XCTAssertEqual(retiredModel.lifecycle, "retired")
        XCTAssertNil(retiredContract.model(id: retiredID))
        XCTAssertFalse(retiredContract.enabledModels.contains(where: { $0.id == retiredID }))
        XCTAssertEqual(
            retiredContract.migrate(.init(
                selectionVersion: retiredContract.schemaVersion,
                modelID: retiredID,
                voiceID: retiredContract.defaults.voiceID)).modelID,
            retiredContract.defaults.modelID)

        let body = try XCTUnwrap(String(
            data: JSONSerialization.data(withJSONObject: [
                "error": "live_model_remotely_disabled",
                "replacementModel": retiredID,
                "contractVersion": retiredContract.contractVersion,
            ]),
            encoding: .utf8))
        XCTAssertNil(AlmaLiveVoiceRemoteReplacementPolicy.replacementModelID(
            for: AlmaAPIError.http(status: 503, body: body),
            currentModelID: retiredContract.defaults.modelID,
            contract: retiredContract))
    }

    func testReconnectFailurePreservesTypedRemoteKillBodyForEnginePolicy() throws {
        let contract = try contract()
        let replacement = "gemini-3.1-flash-live-preview"
        let body = try XCTUnwrap(String(
            data: JSONSerialization.data(withJSONObject: [
                "error": "live_model_remotely_disabled",
                "replacementModel": replacement,
                "contractVersion": contract.contractVersion,
            ]),
            encoding: .utf8))
        let delivery = AlmaLiveVoiceConnectionFailure(
            message: "reconnect failed",
            underlyingError: AlmaAPIError.http(status: 503, body: body))

        guard case AlmaAPIError.http(let status, let deliveredBody)? =
                delivery.underlyingError else {
            return XCTFail("typed HTTP failure was erased at the callback boundary")
        }
        XCTAssertEqual(status, 503)
        XCTAssertEqual(deliveredBody, body)
        XCTAssertEqual(
            AlmaLiveVoiceRemoteReplacementPolicy.replacementModelID(
                for: delivery.underlyingError,
                // 2.5 is the model with a declared replacement (3.1, the default).
                currentModelID: "gemini-2.5-flash-native-audio-preview-12-2025",
                contract: contract),
            replacement)
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
                of: #""modelID": "gemini-3.1-flash-live-preview""#,
                with: #""modelID": "gemini-2.5-flash-native-audio-preview-12-2025", "modelID": "gemini-3.1-flash-live-preview""#),
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

    func testStrictContractRejectsNestedDuplicateAndToolSchemaDrift() throws {
        let source = try XCTUnwrap(String(data: contractData(), encoding: .utf8))
        let nestedDuplicate = source.replacingOccurrences(
            of: #""sessionProtocol": {"#,
            with: #""sessionProtocol": { "system\u0049nstruction": "shadow","#)
        XCTAssertThrowsError(
            try AlmaLiveVoiceContract.decodeStrict(Data(nestedDuplicate.utf8))) {
            XCTAssertTrue(String(describing: $0).contains("duplicate key"))
        }

        let duplicateTool = source.replacingOccurrences(
            of: #""name": "end_call""#,
            with: #""name": "quick_erp_lookup""#)
        XCTAssertThrowsError(
            try AlmaLiveVoiceContract.decodeStrict(Data(duplicateTool.utf8))) {
            XCTAssertTrue(String(describing: $0).contains("session protocol"))
        }

        let requiredDrift = source.replacingOccurrences(
            of: #""required": ["tool"]"#,
            with: #""required": ["missing"]"#)
        XCTAssertThrowsError(
            try AlmaLiveVoiceContract.decodeStrict(Data(requiredDrift.utf8)))
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
