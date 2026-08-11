import AVFoundation
import CryptoKit
import XCTest
@testable import App

@MainActor
final class LiveVoicePreviewTests: XCTestCase {
    private let models = [
        "gemini-2.5-flash-native-audio-preview-12-2025",
        "gemini-3.1-flash-live-preview",
    ]
    private let personas = [
        "Aoede": "মায়া", "Achernar": "নীলা", "Kore": "তারা",
        "Charon": "আরিফ", "Orus": "অর্ক", "Sulafat": "সামি",
    ]

    func testPreCallDraftSelectsVoiceButDoesNotRequestPreviewDuringCall() {
        var draft = AlmaLiveVoicePreCallDraft(modelID: models[0], voiceID: "Aoede")

        let shouldRequest = draft.selectVoice(
            "Kore",
            admission: .init(featureEnabled: true, callIsActive: true))

        XCTAssertFalse(shouldRequest)
        XCTAssertEqual(draft.voiceID, "Kore")
        XCTAssertEqual(draft.previewStatus, .unavailableDuringCall)
        XCTAssertEqual(draft.modelID, models[0])
    }

    func testPreCallDraftRequestsExactSelectedModelVoiceOnlyWhenAdmissionIsIdle() {
        var draft = AlmaLiveVoicePreCallDraft(modelID: models[0], voiceID: "Aoede")
        draft.selectModel(models[1])

        let shouldRequest = draft.selectVoice(
            "Sulafat",
            admission: .init(featureEnabled: true, callIsActive: false))

        XCTAssertTrue(shouldRequest)
        XCTAssertEqual(draft.modelID, models[1])
        XCTAssertEqual(draft.voiceID, "Sulafat")
        XCTAssertEqual(draft.previewStatus, .loading(voiceID: "Sulafat"))
    }

    func testPreCallDraftFeatureOffStillSelectsDraftWithoutPreviewRequest() {
        var draft = AlmaLiveVoicePreCallDraft(modelID: models[0], voiceID: "Aoede")

        let shouldRequest = draft.selectVoice(
            "Charon",
            admission: .init(featureEnabled: false, callIsActive: false))

        XCTAssertFalse(shouldRequest)
        XCTAssertEqual(draft.voiceID, "Charon")
        XCTAssertEqual(draft.previewStatus, .unavailable)
    }

    func testPreCallDraftReflectsVerifiedCoordinatorPlaybackWithoutChangingSelection() {
        var draft = AlmaLiveVoicePreCallDraft(modelID: models[1], voiceID: "Achernar")
        draft.reflect(.playing(7, modelID: models[1], voiceID: "Achernar"))

        XCTAssertEqual(draft.previewStatus, .playing(voiceID: "Achernar"))
        XCTAssertEqual(draft.modelID, models[1])
        XCTAssertEqual(draft.voiceID, "Achernar")

        draft.reflect(.stopped(8))
        XCTAssertEqual(draft.previewStatus, .idle)
    }

    func testPreviewFeatureOffHidesOnlyPreCallSettingsAndLeavesLiveCallEntry() {
        XCTAssertEqual(
            AlmaLiveVoiceComposerEntryVisibility.resolve(previewCatalogEnabled: false),
            .init(showsPreCallSettings: false, showsLiveCall: true))
        XCTAssertEqual(
            AlmaLiveVoiceComposerEntryVisibility.resolve(previewCatalogEnabled: true),
            .init(showsPreCallSettings: true, showsLiveCall: true))
    }

    func testPreCallControllerOpenHasZeroOperationalSideEffects() {
        let coordinator = PreCallPreviewSpy()
        var admissionReads = 0
        var preferenceWrites = 0

        let controller = AlmaLiveVoicePreCallSettingsController(
            modelID: models[0],
            voiceID: "Aoede",
            coordinator: coordinator,
            admission: {
                admissionReads += 1
                return .init(featureEnabled: true, callIsActive: false)
            },
            savePreferences: { _, _ in preferenceWrites += 1 })

        XCTAssertEqual(controller.draft.modelID, models[0])
        XCTAssertEqual(controller.draft.voiceID, "Aoede")
        XCTAssertEqual(admissionReads, 0)
        XCTAssertEqual(preferenceWrites, 0)
        XCTAssertEqual(coordinator.stateReadCount, 0)
        XCTAssertTrue(coordinator.playRequests.isEmpty)
        XCTAssertEqual(coordinator.stopCount, 0)
        XCTAssertEqual(coordinator.shutdownCount, 0)
    }

    func testPreCallControllerSavePersistsExactDraftWhileCancelPersistsNothing() {
        var writes: [(modelID: String, voiceID: String)] = []
        let blockedAdmission = AlmaLiveVoicePreviewGate(
            featureEnabled: true,
            callIsActive: true)

        let cancelled = AlmaLiveVoicePreCallSettingsController(
            modelID: models[0],
            voiceID: "Aoede",
            coordinator: PreCallPreviewSpy(),
            admission: { blockedAdmission },
            savePreferences: { writes.append((modelID: $0, voiceID: $1)) })
        cancelled.selectModel(models[1])
        cancelled.selectVoice("Kore")
        cancelled.cancel()
        XCTAssertTrue(writes.isEmpty)

        let saved = AlmaLiveVoicePreCallSettingsController(
            modelID: models[0],
            voiceID: "Aoede",
            coordinator: PreCallPreviewSpy(),
            admission: { blockedAdmission },
            savePreferences: { writes.append((modelID: $0, voiceID: $1)) })
        saved.selectModel(models[1])
        saved.selectVoice("Sulafat")
        saved.save()

        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(writes.first?.modelID, models[1])
        XCTAssertEqual(writes.first?.voiceID, "Sulafat")
    }

    func testPreCallControllerShutdownStopsAndCannotReplayStalePreview() async {
        let coordinator = PreCallPreviewSpy()
        coordinator.decision = .started(9)
        let controller = AlmaLiveVoicePreCallSettingsController(
            modelID: models[0],
            voiceID: "Aoede",
            coordinator: coordinator,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            savePreferences: { _, _ in XCTFail("shutdown must not save") })

        controller.selectVoice("Kore")
        XCTAssertEqual(coordinator.playRequests.count, 1)
        let statusAtShutdown = controller.draft.previewStatus
        controller.shutdown()
        coordinator.state = .playing(9, modelID: models[0], voiceID: "Kore")
        for _ in 0..<5 { await Task.yield() }
        controller.selectVoice("Orus")

        XCTAssertEqual(coordinator.shutdownCount, 1)
        XCTAssertEqual(coordinator.playRequests.count, 1)
        XCTAssertEqual(controller.draft.voiceID, "Kore")
        XCTAssertEqual(controller.draft.previewStatus, statusAtShutdown)
    }

    func testPreCallAccessibilityAnnouncementTracksSelectedVoiceAndStatus() {
        var draft = AlmaLiveVoicePreCallDraft(modelID: models[0], voiceID: "Aoede")
        _ = draft.selectVoice(
            "Kore",
            admission: .init(featureEnabled: true, callIsActive: true))
        XCTAssertTrue(draft.previewAccessibilityAnnouncement.contains("তারা"))
        XCTAssertTrue(draft.previewAccessibilityAnnouncement.contains("draft-এ নির্বাচিত"))

        draft.reflect(.playing(4, modelID: models[0], voiceID: "Kore"))
        XCTAssertEqual(draft.previewAccessibilityAnnouncement, "তারা-র Preview চলছে")
    }

    func testStrictCatalogAcceptsExactMatrixAndRejectsUnknownKeys() throws {
        _ = try AlmaLiveVoicePreviewCatalog.decodeStrict(catalogData())
        var root = try XCTUnwrap(jsonObject(catalogData()) as? [String: Any])
        root["unexpected"] = true

        XCTAssertThrowsError(try AlmaLiveVoicePreviewCatalog.decodeStrict(jsonData(root))) {
            XCTAssertEqual(
                $0 as? AlmaLiveVoicePreviewError,
                .malformedCatalog("unexpected keys at catalog"))
        }
    }

    func testStrictCatalogRejectsFilenameThatCouldSubstituteAnotherAsset() throws {
        var root = try XCTUnwrap(jsonObject(catalogData()) as? [String: Any])
        var entries = try XCTUnwrap(root["entries"] as? [[String: Any]])
        entries[0]["filename"] = entries[1]["filename"]
        root["entries"] = entries

        XCTAssertThrowsError(try AlmaLiveVoicePreviewCatalog.decodeStrict(jsonData(root)))
    }

    func testPendingCatalogSupportsIncrementalApprovalButNotTwelveOfTwelve() throws {
        var root = try XCTUnwrap(jsonObject(catalogData()) as? [String: Any])
        var entries = try XCTUnwrap(root["entries"] as? [[String: Any]])
        entries[0]["approved"] = true
        root["entries"] = entries
        _ = try AlmaLiveVoicePreviewCatalog.decodeStrict(jsonData(root))

        for index in entries.indices { entries[index]["approved"] = true }
        root["entries"] = entries
        XCTAssertThrowsError(try AlmaLiveVoicePreviewCatalog.decodeStrict(jsonData(root)))
    }

    func testAssetStoreUsesBundleThenMemoryWithoutNetwork() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[0], voiceID: "Aoede")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))

        let first = try await fixture.store.asset(modelID: entry.modelID, voiceID: entry.voiceID)
        let second = try await fixture.store.asset(modelID: entry.modelID, voiceID: entry.voiceID)

        XCTAssertEqual(first.source, .bundle)
        XCTAssertEqual(second.source, .memory)
        XCTAssertEqual(first.data, fixture.data[entry.identity])
        XCTAssertEqual(fixture.network.fetchCount, 0)
        XCTAssertEqual(fixture.files.reads, [fixture.diskURL(entry).path, fixture.bundleURL(entry).path])
        XCTAssertEqual(fixture.files.writes, [fixture.diskURL(entry).path])
        XCTAssertEqual(fixture.files.trims.count, 1)
        XCTAssertEqual(fixture.files.trims.first?.1, 33_554_432)

        let freshStore = try AlmaLiveVoicePreviewAssetStore(
            catalog: fixture.catalog,
            diskRoot: fixture.diskRoot,
            bundleRoot: fixture.bundleRoot,
            cdnBaseURL: URL(string: "https://cdn.example")!,
            files: fixture.files,
            network: fixture.network)
        let freshAsset = try await freshStore.asset(modelID: entry.modelID, voiceID: entry.voiceID)
        XCTAssertEqual(freshAsset.source, .disk)
    }

    func testCorruptDiskIsRemovedBeforeExactBundleAssetIsUsed() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[0], voiceID: "Kore")
        fixture.files.put(Data(repeating: 0, count: entry.byteSize), at: fixture.diskURL(entry))
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))

        let asset = try await fixture.store.asset(modelID: entry.modelID, voiceID: entry.voiceID)

        XCTAssertEqual(asset.source, .bundle)
        XCTAssertEqual(fixture.files.removes, [fixture.diskURL(entry).path])
        XCTAssertEqual(fixture.network.fetchCount, 0)
    }

    func testCDNRequiresExactURLStatusMimeLengthSizeAndSHA() async throws {
        let badCases: [(String, (AlmaLiveVoicePreviewNetworkResponse) -> AlmaLiveVoicePreviewNetworkResponse)] = [
            ("redirect", { value in value.copy(wasRedirected: true) }),
            ("status", { value in value.copy(statusCode: 206) }),
            ("mime", { value in value.copy(mimeType: "text/html") }),
            ("length", { value in value.copy(expectedContentLength: Int64(value.data.count + 1)) }),
            ("size", { value in value.copy(data: value.data + Data([0])) }),
            ("hash", { value in value.copy(data: Data(repeating: 0, count: value.data.count)) }),
        ]
        for (name, mutate) in badCases {
            let fixture = try makeFixture()
            let entry = try fixture.catalog.entry(modelID: models[1], voiceID: "Sulafat")
            let response = fixture.response(for: entry)
            fixture.network.response = mutate(response)
            do {
                _ = try await fixture.store.asset(modelID: entry.modelID, voiceID: entry.voiceID)
                XCTFail("\(name) must fail closed")
            } catch {
                XCTAssertTrue(
                    error is AlmaLiveVoicePreviewError,
                    "\(name) returned unexpected error: \(error)")
            }
            XCTAssertTrue(fixture.files.writes.isEmpty, "\(name) must never reach disk")
        }
    }

    func testValidCDNAssetIsPersistedAtItsExactIdentityPath() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[1], voiceID: "Achernar")
        fixture.network.response = fixture.response(for: entry)

        let asset = try await fixture.store.asset(modelID: entry.modelID, voiceID: entry.voiceID)

        XCTAssertEqual(asset.source, .cdn)
        XCTAssertEqual(fixture.network.maximumBytes, [entry.byteSize])
        XCTAssertEqual(fixture.files.writes, [fixture.diskURL(entry).path])
        XCTAssertEqual(fixture.files.data(at: fixture.diskURL(entry)), fixture.data[entry.identity])
    }

    func testCorruptBundleFallsThroughOnlyToSameChecksumValidCDNIdentity() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[1], voiceID: "Orus")
        fixture.files.put(Data(repeating: 0, count: entry.byteSize), at: fixture.bundleURL(entry))
        fixture.network.response = fixture.response(for: entry)

        let asset = try await fixture.store.asset(modelID: entry.modelID, voiceID: entry.voiceID)

        XCTAssertEqual(asset.source, .cdn)
        XCTAssertEqual(asset.entry.identity, entry.identity)
        XCTAssertEqual(asset.data, fixture.data[entry.identity])
        XCTAssertEqual(fixture.files.writes, [fixture.diskURL(entry).path])
    }

    func testVoiceIdentityLookupIsCaseSensitive() throws {
        let catalog = try AlmaLiveVoicePreviewCatalog.decodeStrict(catalogData())
        XCTAssertThrowsError(try catalog.entry(modelID: models[0], voiceID: "aoede"))
    }

    func testFeatureOffAndActiveCallGuardsHaveZeroDependencyEffects() throws {
        let fixture = try makeFixture()
        let audio = AudioSpy()
        let player = PlayerSpy()
        let admission = AdmissionBox(.init(featureEnabled: false, callIsActive: false))
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { admission.value }, notificationCenter: nil)

        XCTAssertEqual(
            coordinator.play(modelID: models[0], voiceID: "Aoede"),
            .blockedFeatureOff)
        admission.value = .init(featureEnabled: true, callIsActive: true)
        XCTAssertEqual(
            coordinator.play(modelID: models[0], voiceID: "Aoede"),
            .blockedActiveCall)

        XCTAssertEqual(coordinator.state, .idle)
        XCTAssertTrue(fixture.files.reads.isEmpty)
        XCTAssertEqual(fixture.network.fetchCount, 0)
        XCTAssertTrue(audio.events.isEmpty)
        XCTAssertTrue(player.events.isEmpty)
    }

    func testNonCallAudioOccupancyIsIncludedInPreviewAdmission() throws {
        let registry = AlmaLiveVoiceNonCallAudioRegistry()
        let token = registry.claim(.assistantTTS) { _ in }
        let fixture = try makeFixture()
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store,
            audioSession: audio,
            player: player,
            admission: {
                .includingNonCallAudio(
                    featureEnabled: true,
                    callIsActive: false,
                    nonCallAudioIsActive: registry.isBusy)
            },
            notificationCenter: nil)

        XCTAssertTrue(registry.isBusy)
        XCTAssertEqual(
            AlmaLiveVoicePreviewGate.includingNonCallAudio(
                featureEnabled: true,
                callIsActive: false,
                nonCallAudioIsActive: registry.isBusy),
            .init(featureEnabled: true, callIsActive: true))
        XCTAssertEqual(
            coordinator.play(modelID: models[0], voiceID: "Aoede"),
            .blockedActiveCall)
        XCTAssertTrue(fixture.files.reads.isEmpty)
        XCTAssertTrue(audio.events.isEmpty)
        XCTAssertTrue(player.events.isEmpty)

        registry.release(token)
        XCTAssertFalse(registry.isBusy)
        XCTAssertEqual(
            AlmaLiveVoicePreviewGate.includingNonCallAudio(
                featureEnabled: true,
                callIsActive: false,
                nonCallAudioIsActive: registry.isBusy),
            .init(featureEnabled: true, callIsActive: false))
    }

    func testNonCallAudioRegistryRejectsStaleReleaseToken() {
        let registry = AlmaLiveVoiceNonCallAudioRegistry()
        let first = registry.claim(.assistantTTS) { _ in }
        let second = registry.claim(.composerDictation) { _ in }

        registry.release(first)
        XCTAssertTrue(registry.isBusy)
        XCTAssertEqual(registry.activeOwner, .composerDictation)

        registry.release(second)
        XCTAssertFalse(registry.isBusy)
    }

    func testNonCallAudioRegistryReplacementStopsEachDisplacedOwnerExactlyOnce() {
        let registry = AlmaLiveVoiceNonCallAudioRegistry()
        var firstStops: [AlmaLiveVoiceNonCallAudioRegistry.StopMode] = []
        var secondStops: [AlmaLiveVoiceNonCallAudioRegistry.StopMode] = []
        _ = registry.claim(.assistantTTS) { firstStops.append($0) }
        _ = registry.claim(.agentMedia) { secondStops.append($0) }
        let final = registry.claim(.robotSFX) { _ in }

        XCTAssertEqual(firstStops, [.restoreBeforeNextAppMutation])
        XCTAssertEqual(secondStops, [.restoreBeforeNextAppMutation])
        XCTAssertEqual(registry.activeOwner, .robotSFX)

        registry.release(final)
        XCTAssertEqual(firstStops.count, 1)
        XCTAssertEqual(secondStops.count, 1)
        XCTAssertFalse(registry.isBusy)
    }

    func testNonCallAudioRegistryStopModesClearBeforeReentrantCallbacks() {
        let registry = AlmaLiveVoiceNonCallAudioRegistry()
        var events: [String] = []
        _ = registry.claim(.intercomVoiceNote) { mode in
            XCTAssertFalse(registry.isBusy)
            events.append("intercom:\(mode)")
            _ = registry.claim(.creativeMedia) { nestedMode in
                XCTAssertFalse(registry.isBusy)
                events.append("creative:\(nestedMode)")
                let transient = registry.claim(.robotSFX) { _ in
                    XCTFail("released reentrant owner must not be stopped")
                }
                registry.release(transient)
            }
        }

        registry.stopAll(.restoreBeforeNextAppMutation)
        XCTAssertEqual(registry.activeOwner, .creativeMedia)
        registry.stopAll(.relinquishAfterActivatedSystemTakeover)

        XCTAssertEqual(events, [
            "intercom:restoreBeforeNextAppMutation",
            "creative:relinquishAfterActivatedSystemTakeover",
        ])
        XCTAssertFalse(registry.isBusy)
    }

    func testCallAudioAdmissionNormalClaimsAreExclusive() throws {
        let registry = AlmaCallAudioAdmission()
        let engine = NSObject()
        var stopCount = 0
        let assistant = try XCTUnwrap(registry.claimNormal(
            .assistant(engine: ObjectIdentifier(engine)),
            stop: { stopCount += 1 }))

        XCTAssertTrue(registry.isBusy)
        XCTAssertTrue(registry.isCurrent(assistant))
        XCTAssertNil(registry.claimNormal(
            .officeIntent(operation: 7, callID: nil),
            stop: { XCTFail("rejected owner must not install a callback") }))
        XCTAssertEqual(stopCount, 0)

        registry.release(assistant)
        XCTAssertFalse(registry.isBusy)
        XCTAssertEqual(stopCount, 0)
    }

    func testCallAudioAdmissionAllowsOnlyIdentityPreservingTransitions() throws {
        let callID = UUID().uuidString.lowercased()
        let callUUID = try XCTUnwrap(UUID(uuidString: callID))

        let mediaRegistry = AlmaCallAudioAdmission()
        let mediaToken = try XCTUnwrap(mediaRegistry.claimNormal(
            .officeIntent(operation: 11, callID: nil), stop: {}))
        XCTAssertTrue(mediaRegistry.transition(
            mediaToken,
            to: .officeIntent(operation: 11, callID: callID)))
        XCTAssertFalse(mediaRegistry.transition(
            mediaToken,
            to: .officeIntent(operation: 11, callID: nil)))
        XCTAssertFalse(mediaRegistry.transition(
            mediaToken,
            to: .officeMedia(operation: 12, callID: callID)))
        XCTAssertTrue(mediaRegistry.transition(
            mediaToken,
            to: .officeMedia(operation: 11, callID: callID)))
        XCTAssertFalse(mediaRegistry.transition(
            mediaToken,
            to: .ptt(generation: 11)))

        let systemRegistry = AlmaCallAudioAdmission()
        let systemToken = try XCTUnwrap(systemRegistry.claimNormal(
            .officeIntent(operation: 12, callID: callID), stop: {}))
        let reserved = AlmaCallAudioAdmission.Owner.callKit(
            uuid: callUUID,
            callID: callID,
            kind: .office,
            phase: .reservation)
        XCTAssertTrue(systemRegistry.transition(systemToken, to: reserved))
        XCTAssertTrue(systemRegistry.transition(
            systemToken,
            to: .callKit(
                uuid: callUUID,
                callID: callID,
                kind: .office,
                phase: .media)))
        XCTAssertFalse(systemRegistry.transition(systemToken, to: reserved))
        XCTAssertFalse(systemRegistry.transition(
            systemToken,
            to: .callKit(
                uuid: callUUID,
                callID: callID,
                kind: .agent,
                phase: .teardown)))
    }

    func testCallAudioAdmissionSystemPreemptsEveryEligibleNormalOwner() throws {
        let engine = NSObject()
        let owners: [AlmaCallAudioAdmission.Owner] = [
            .assistant(engine: ObjectIdentifier(engine)),
            .officeMedia(operation: 19, callID: UUID().uuidString.lowercased()),
            .ptt(generation: 23),
        ]

        for normalOwner in owners {
            let registry = AlmaCallAudioAdmission()
            let systemOwner = AlmaCallAudioAdmission.Owner.callKit(
                uuid: UUID(),
                callID: UUID().uuidString.lowercased(),
                kind: .agent,
                phase: .reported)
            var stopCount = 0
            var preemptCount = 0
            let displacedToken = try XCTUnwrap(registry.claimNormal(normalOwner) {
                stopCount += 1
                XCTAssertEqual(registry.activeOwner, systemOwner)
            })

            let systemToken = try XCTUnwrap(registry.claimSystem(systemOwner) {
                preemptCount += 1
                XCTAssertEqual(registry.activeOwner, systemOwner)
            })

            XCTAssertEqual(stopCount, 1)
            XCTAssertEqual(preemptCount, 1)
            XCTAssertFalse(registry.isCurrent(displacedToken))
            XCTAssertTrue(registry.isCurrent(systemToken))
            registry.release(displacedToken)
            XCTAssertTrue(registry.isCurrent(systemToken))
        }
    }

    func testCallAudioAdmissionBlocksSystemMediaUntilExactPreemptionReceiptCompletes() throws {
        let registry = AlmaCallAudioAdmission()
        let callID = UUID().uuidString.lowercased()
        let callUUID = try XCTUnwrap(UUID(uuidString: callID))
        let systemOwner = AlmaCallAudioAdmission.Owner.callKit(
            uuid: callUUID,
            callID: callID,
            kind: .agent,
            phase: .reported)
        var events: [String] = []
        let displacedToken = try XCTUnwrap(registry.claimNormal(
            .assistant(engine: ObjectIdentifier(NSObject())),
            stop: {
                events.append("stop")
                XCTAssertEqual(registry.activeOwner, systemOwner)
            },
            finishTeardown: {
                events.append("finish")
                XCTAssertEqual(registry.activeOwner, systemOwner)
            }))

        let systemToken = try XCTUnwrap(registry.claimSystem(systemOwner) {
            events.append("preempt")
        })

        XCTAssertEqual(events, ["stop", "preempt"])
        XCTAssertFalse(registry.acceptsMediaMutation(systemToken))
        XCTAssertFalse(registry.transition(
            systemToken,
            to: .callKit(
                uuid: callUUID,
                callID: callID,
                kind: .agent,
                phase: .activating)))
        XCTAssertFalse(registry.completeSystemPreemption(displacedToken))
        XCTAssertTrue(registry.completeSystemPreemption(systemToken))
        XCTAssertEqual(events, ["stop", "preempt", "finish"])
        XCTAssertTrue(registry.acceptsMediaMutation(systemToken))
        XCTAssertTrue(registry.completeSystemPreemption(systemToken))
        XCTAssertEqual(events, ["stop", "preempt", "finish"])
    }

    func testCallAudioAdmissionReleaseFinishesPendingSystemPreemptionExactlyOnce() throws {
        let registry = AlmaCallAudioAdmission()
        let systemOwner = AlmaCallAudioAdmission.Owner.callKit(
            uuid: UUID(),
            callID: UUID().uuidString.lowercased(),
            kind: .office,
            phase: .reported)
        var finishCount = 0
        _ = try XCTUnwrap(registry.claimNormal(
            .officeMedia(operation: 27, callID: UUID().uuidString.lowercased()),
            stop: {},
            finishTeardown: {
                finishCount += 1
                XCTAssertFalse(registry.isBusy)
            }))
        let systemToken = try XCTUnwrap(registry.claimSystem(systemOwner) {})

        XCTAssertFalse(registry.acceptsMediaMutation(systemToken))
        registry.release(systemToken)
        XCTAssertEqual(finishCount, 1)
        XCTAssertFalse(registry.isBusy)
        registry.release(systemToken)
        XCTAssertEqual(finishCount, 1)
    }

    func testCallAudioAdmissionSystemCannotPreemptIntentOrAnotherCallKit() throws {
        let registry = AlmaCallAudioAdmission()
        let callID = UUID().uuidString.lowercased()
        let systemOwner = AlmaCallAudioAdmission.Owner.callKit(
            uuid: UUID(), callID: callID, kind: .office, phase: .reservation)
        var callbacks = 0
        let intent = try XCTUnwrap(registry.claimNormal(
            .officeIntent(operation: 29, callID: callID),
            stop: { callbacks += 1 }))

        XCTAssertNil(registry.claimSystem(systemOwner) { callbacks += 1 })
        XCTAssertEqual(callbacks, 0)
        XCTAssertTrue(registry.isCurrent(intent))
        registry.release(intent)

        let systemToken = try XCTUnwrap(registry.claimSystem(systemOwner) {
            callbacks += 1
        })
        let duplicate = try XCTUnwrap(registry.claimSystem(systemOwner) {
            callbacks += 1
        })
        XCTAssertEqual(duplicate, systemToken)
        XCTAssertEqual(callbacks, 0)

        let competingOwner = AlmaCallAudioAdmission.Owner.callKit(
            uuid: UUID(),
            callID: UUID().uuidString.lowercased(),
            kind: .agent,
            phase: .reported)
        XCTAssertNil(registry.claimSystem(competingOwner) { callbacks += 1 })
        XCTAssertEqual(callbacks, 0)
        XCTAssertTrue(registry.isCurrent(systemToken))
    }

    func testCallAudioAdmissionTeardownStaysBusyUntilExactRelease() throws {
        let registry = AlmaCallAudioAdmission()
        let engine = NSObject()
        let token = try XCTUnwrap(registry.claimNormal(
            .assistant(engine: ObjectIdentifier(engine)), stop: {}))

        XCTAssertTrue(registry.acceptsMediaMutation(token))
        XCTAssertTrue(registry.beginTeardown(token))
        XCTAssertTrue(registry.isBusy)
        XCTAssertTrue(registry.isTearingDown)
        XCTAssertFalse(registry.acceptsMediaMutation(token))
        XCTAssertNil(registry.claimNormal(.ptt(generation: 30), stop: {}))
        XCTAssertNil(registry.claimSystem(
            .callKit(
                uuid: UUID(),
                callID: UUID().uuidString.lowercased(),
                kind: .agent,
                phase: .reported),
            preempt: {}))

        let otherRegistry = AlmaCallAudioAdmission()
        let otherToken = try XCTUnwrap(otherRegistry.claimNormal(
            .ptt(generation: 31), stop: {}))
        registry.release(otherToken)
        XCTAssertTrue(registry.isCurrent(token))

        registry.release(token)
        XCTAssertFalse(registry.isBusy)
    }

    func testCallAudioAdmissionRejectsStaleAndCrossRegistryTokens() throws {
        let first = AlmaCallAudioAdmission()
        let second = AlmaCallAudioAdmission()
        let firstToken = try XCTUnwrap(first.claimNormal(.ptt(generation: 41), stop: {}))
        let secondToken = try XCTUnwrap(second.claimNormal(.ptt(generation: 41), stop: {}))

        XCTAssertNotEqual(firstToken, secondToken)
        XCTAssertFalse(first.isCurrent(secondToken))
        XCTAssertFalse(first.transition(
            secondToken,
            to: .ptt(generation: 42)))
        XCTAssertFalse(first.beginTeardown(secondToken))
        first.release(secondToken)
        XCTAssertTrue(first.isCurrent(firstToken))

        first.resetForTests()
        let replacement = try XCTUnwrap(first.claimNormal(.ptt(generation: 41), stop: {}))
        XCTAssertNotEqual(firstToken, replacement)
        first.release(firstToken)
        XCTAssertTrue(first.isCurrent(replacement))
    }

    func testCallAudioAdmissionSystemPreemptionIsReentrantSafe() throws {
        let registry = AlmaCallAudioAdmission()
        let engine = NSObject()
        let systemOwner = AlmaCallAudioAdmission.Owner.callKit(
            uuid: UUID(),
            callID: UUID().uuidString.lowercased(),
            kind: .agent,
            phase: .reported)
        var displacedToken: AlmaCallAudioAdmission.Token?
        var duplicateToken: AlmaCallAudioAdmission.Token?
        var nestedCallbackCount = 0
        var events: [String] = []

        displacedToken = registry.claimNormal(
            .assistant(engine: ObjectIdentifier(engine))) {
                events.append("stop")
                XCTAssertEqual(registry.activeOwner, systemOwner)
                if let displacedToken { registry.release(displacedToken) }
                XCTAssertNil(registry.claimNormal(.ptt(generation: 51), stop: {}))
                duplicateToken = registry.claimSystem(systemOwner) {
                    nestedCallbackCount += 1
                }
            }

        let systemToken = try XCTUnwrap(registry.claimSystem(systemOwner) {
            events.append("preempt")
            XCTAssertEqual(registry.activeOwner, systemOwner)
        })

        XCTAssertEqual(events, ["stop", "preempt"])
        XCTAssertEqual(nestedCallbackCount, 0)
        XCTAssertEqual(duplicateToken, systemToken)
        XCTAssertTrue(registry.isCurrent(systemToken))
    }

    func testPreActivationCallKitTerminalFenceRequiresExactCallAndToken() throws {
        let registry = AlmaCallAudioAdmission()
        let callID = UUID().uuidString.lowercased()
        let first = try XCTUnwrap(registry.claimNormal(
            .officeIntent(operation: 61, callID: callID),
            stop: {}))
        registry.release(first)
        let stale = try XCTUnwrap(registry.claimNormal(
            .officeIntent(operation: 62, callID: callID),
            stop: {}))

        XCTAssertTrue(AlmaCallKitPreActivationTerminalFence.accepts(
            pendingCallID: callID.uppercased(),
            pendingToken: first,
            terminalCallID: callID,
            terminalToken: first))
        XCTAssertTrue(AlmaCallKitPreActivationTerminalFence.accepts(
            pendingCallID: callID,
            pendingToken: nil,
            terminalCallID: callID,
            terminalToken: first))
        XCTAssertFalse(AlmaCallKitPreActivationTerminalFence.accepts(
            pendingCallID: UUID().uuidString,
            pendingToken: first,
            terminalCallID: callID,
            terminalToken: first))
        XCTAssertFalse(AlmaCallKitPreActivationTerminalFence.accepts(
            pendingCallID: callID,
            pendingToken: stale,
            terminalCallID: callID,
            terminalToken: first))
    }

    func testPreviewRolloutGateHasDeterministicEnvironmentAndDefaultsPrecedence() throws {
        let suite = "alma-live-voice-preview-gate-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertTrue(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .previewCatalogV1, environment: [:], defaults: defaults))
        AlmaLiveVoiceRecoveryFeatures.set(false, for: .previewCatalogV1, defaults: defaults)
        XCTAssertFalse(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .previewCatalogV1, environment: [:], defaults: defaults))
        XCTAssertTrue(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .previewCatalogV1,
            environment: ["ALMA_LIVE_VOICE_PREVIEW_CATALOG_V1": "true"],
            defaults: defaults))
        XCTAssertFalse(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .previewCatalogV1,
            environment: ["ALMA_LIVE_VOICE_PREVIEW_CATALOG_V1": "0"],
            defaults: defaults))
    }

    func testDisablingFeatureStopsAnExistingPreviewAndReleasesItsSession() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[0], voiceID: "Aoede")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))
        let admission = AdmissionBox(.init(featureEnabled: true, callIsActive: false))
        let audio = AudioSpy()
        let player = PlayerSpy()
        let center = NotificationCenter()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store,
            audioSession: audio,
            player: player,
            admission: { admission.value },
            notificationCenter: center)

        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await coordinator.waitForCurrentRequest()
        admission.value = .init(featureEnabled: false, callIsActive: false)
        center.post(name: UserDefaults.didChangeNotification, object: nil)
        for _ in 0..<10 { await Task.yield() }

        guard case .stopped = coordinator.state else {
            return XCTFail("feature rollback must stop a preview already in progress")
        }
        XCTAssertEqual(player.events, ["play", "stop"])
        XCTAssertEqual(audio.events, ["activate", "deactivate"])
    }

    func testAudioActivatesOnlyAfterVerifiedBytesAndImmediatelyBeforePlay() async throws {
        let events = EventLog()
        let fixture = try makeFixture(eventLog: events)
        let entry = try fixture.catalog.entry(modelID: models[0], voiceID: "Charon")
        fixture.network.response = fixture.response(for: entry)
        let audio = AudioSpy(events: events)
        let player = PlayerSpy(events: events)
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)

        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await coordinator.waitForCurrentRequest()

        XCTAssertEqual(coordinator.state, .playing(1, modelID: entry.modelID, voiceID: entry.voiceID))
        let trace = events.values
        XCTAssertEqual(Array(trace.suffix(2)), ["audio.activate", "player.play"])
        XCTAssertTrue(trace.contains("file.write"), "verified CDN data is persisted before activation")
        XCTAssertEqual(audio.events, ["activate"])
    }

    func testAudioActivationFailureNeverStartsPlayer() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[0], voiceID: "Charon")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))
        let audio = AudioSpy()
        audio.activationError = CocoaError(.fileReadNoPermission)
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)

        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await coordinator.waitForCurrentRequest()

        XCTAssertEqual(coordinator.state, .failed(1, .audio))
        XCTAssertEqual(audio.events, ["activate"])
        XCTAssertTrue(player.events.isEmpty)
        XCTAssertTrue(player.playedData.isEmpty)
    }

    func testIntegrityFailureNeverTouchesAudioOrPlayer() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[0], voiceID: "Orus")
        fixture.network.response = fixture.response(for: entry).copy(
            data: Data(repeating: 0, count: entry.byteSize))
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)

        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await coordinator.waitForCurrentRequest()

        XCTAssertEqual(coordinator.state, .failed(1, .integrity))
        XCTAssertTrue(audio.events.isEmpty)
        XCTAssertTrue(player.events.isEmpty)
    }

    func testStalePlayerCompletionCannotFinishNewerPreview() async throws {
        let staleAVPlayer = try AVAudioPlayer(data: silentWAV())
        let currentAVPlayer = try AVAudioPlayer(data: silentWAV())
        XCTAssertFalse(AlmaLiveVoicePreviewSystemPlayer.acceptsCompletion(
            from: staleAVPlayer, currentPlayer: currentAVPlayer))
        XCTAssertTrue(AlmaLiveVoicePreviewSystemPlayer.acceptsCompletion(
            from: currentAVPlayer, currentPlayer: currentAVPlayer))

        let fixture = try makeFixture()
        let older = try fixture.catalog.entry(modelID: models[0], voiceID: "Aoede")
        let newer = try fixture.catalog.entry(modelID: models[0], voiceID: "Kore")
        fixture.files.put(fixture.data[older.identity]!, at: fixture.bundleURL(older))
        fixture.files.put(fixture.data[newer.identity]!, at: fixture.bundleURL(newer))
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)

        _ = coordinator.play(modelID: older.modelID, voiceID: older.voiceID)
        await coordinator.waitForCurrentRequest()
        _ = coordinator.play(modelID: newer.modelID, voiceID: newer.voiceID)
        await coordinator.waitForCurrentRequest()
        player.finish(at: 0)

        XCTAssertEqual(coordinator.state, .playing(2, modelID: newer.modelID, voiceID: newer.voiceID))
        player.finish(at: 1)
        XCTAssertEqual(coordinator.state, .idle)
    }

    func testAdmissionIsRecheckedAfterLoadingBeforeAudioActivation() async throws {
        let catalog = try AlmaLiveVoicePreviewCatalog.decodeStrict(catalogData())
        let data = fixtureData()
        let files = FileSpy()
        let network = ControlledNetwork()
        let roots = roots()
        let store = try AlmaLiveVoicePreviewAssetStore(
            catalog: catalog, diskRoot: roots.disk, bundleRoot: roots.bundle,
            cdnBaseURL: URL(string: "https://cdn.example")!, files: files, network: network)
        let entry = try catalog.entry(modelID: models[0], voiceID: "Sulafat")
        let admission = AdmissionBox(.init(featureEnabled: true, callIsActive: false))
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: store, audioSession: audio, player: player,
            admission: { admission.value }, notificationCenter: nil)

        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        let firstRequestReady = await network.waitForPending(1)
        XCTAssertTrue(firstRequestReady)
        admission.value = .init(featureEnabled: true, callIsActive: true)
        await network.complete(
            filename: entry.filename, response: Self.response(entry: entry, data: data))
        await coordinator.waitForCurrentRequest()

        XCTAssertEqual(coordinator.state, .stopped(1))
        XCTAssertTrue(audio.events.isEmpty)
        XCTAssertTrue(player.events.isEmpty)
    }

    func testCleanupDoesNotDeactivateSessionAfterCallAdmissionChanges() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[1], voiceID: "Charon")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))
        let admission = AdmissionBox(.init(featureEnabled: true, callIsActive: false))
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { admission.value }, notificationCenter: nil)

        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await coordinator.waitForCurrentRequest()
        admission.value = .init(featureEnabled: true, callIsActive: true)
        coordinator.handleLifecycle(.interruption)

        XCTAssertEqual(player.events, ["play", "stop"])
        XCTAssertEqual(
            audio.events, ["activate", "relinquish"],
            "CallKit/Agora may now own the session")
    }

    func testRapidABCSelectionOnlyAllowsLatestGenerationToPlay() async throws {
        let catalog = try AlmaLiveVoicePreviewCatalog.decodeStrict(catalogData())
        let data = fixtureData()
        let files = FileSpy()
        let network = ControlledNetwork()
        let roots = roots()
        let store = try AlmaLiveVoicePreviewAssetStore(
            catalog: catalog, diskRoot: roots.disk, bundleRoot: roots.bundle,
            cdnBaseURL: URL(string: "https://cdn.example")!, files: files, network: network)
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)
        let first = try catalog.entry(modelID: models[0], voiceID: "Aoede")
        let second = try catalog.entry(modelID: models[0], voiceID: "Kore")
        let latest = try catalog.entry(modelID: models[1], voiceID: "Sulafat")

        XCTAssertEqual(
            coordinator.play(modelID: first.modelID, voiceID: first.voiceID),
            .started(1))
        let firstPending = await network.waitForPending(1)
        XCTAssertTrue(firstPending)
        XCTAssertEqual(
            coordinator.play(modelID: second.modelID, voiceID: second.voiceID),
            .started(2))
        let firstTwoPending = await network.waitForPending(2)
        XCTAssertTrue(firstTwoPending)
        XCTAssertEqual(
            coordinator.play(modelID: latest.modelID, voiceID: latest.voiceID),
            .started(3))
        let allPending = await network.waitForPending(3)
        XCTAssertTrue(allPending)

        await network.complete(
            filename: latest.filename, response: Self.response(entry: latest, data: data))
        await coordinator.waitForCurrentRequest()
        await network.complete(
            filename: second.filename, response: Self.response(entry: second, data: data))
        await network.complete(
            filename: first.filename, response: Self.response(entry: first, data: data))
        let allReturned = await network.waitForReturnedFetches(3)
        XCTAssertTrue(allReturned)
        await waitForMainActorBarrier()

        XCTAssertEqual(coordinator.state, .playing(
            3, modelID: latest.modelID, voiceID: latest.voiceID))
        XCTAssertEqual(player.playedData, [data[latest.identity]!])
        XCTAssertEqual(audio.events, ["activate"])
    }

    func testEveryLifecycleBoundaryStopsWithoutAutoResume() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[1], voiceID: "Aoede")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)
        let events: [AlmaLiveVoicePreviewCoordinator.LifecycleEvent] = [
            .interruption, .routeChange, .willResignActive, .background, .mediaServicesReset,
        ]

        for (index, event) in events.enumerated() {
            _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
            await coordinator.waitForCurrentRequest()
            coordinator.handleLifecycle(event)
            guard case .stopped = coordinator.state else {
                return XCTFail("event \(index) did not stop")
            }
            for _ in 0..<3 { await Task.yield() }
            guard case .stopped = coordinator.state else {
                return XCTFail("event \(index) auto-resumed")
            }
        }

        XCTAssertEqual(player.events.filter { $0 == "play" }.count, 5)
        XCTAssertEqual(player.events.filter { $0 == "stop" }.count, 5)
        XCTAssertEqual(audio.events.filter { $0 == "deactivate" }.count, 5)
    }

    func testNotificationFiltersIgnoreEndedInterruptionAndCategoryChange() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[0], voiceID: "Achernar")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))
        let center = NotificationCenter()
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: center)
        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await coordinator.waitForCurrentRequest()

        center.post(
            name: AVAudioSession.interruptionNotification,
            object: nil,
            userInfo: [AVAudioSessionInterruptionTypeKey:
                        AVAudioSession.InterruptionType.ended.rawValue])
        center.post(
            name: AVAudioSession.routeChangeNotification,
            object: nil,
            userInfo: [AVAudioSessionRouteChangeReasonKey:
                        AVAudioSession.RouteChangeReason.categoryChange.rawValue])
        for _ in 0..<5 { await Task.yield() }
        XCTAssertEqual(coordinator.state, .playing(1, modelID: entry.modelID, voiceID: entry.voiceID))
        XCTAssertEqual(player.events, ["play"])

        center.post(
            name: AVAudioSession.routeChangeNotification,
            object: nil,
            userInfo: [AVAudioSessionRouteChangeReasonKey:
                        AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue])
        for _ in 0..<5 { await Task.yield() }
        guard case .stopped = coordinator.state else {
            return XCTFail("old-device-unavailable must stop")
        }
        XCTAssertEqual(player.events, ["play", "stop"])
    }

    func testNoSuitableRouteAndMediaServicesLostNotificationsStopWithoutResume() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[0], voiceID: "Achernar")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))
        let center = NotificationCenter()
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: center)

        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await coordinator.waitForCurrentRequest()
        center.post(
            name: AVAudioSession.routeChangeNotification,
            object: nil,
            userInfo: [AVAudioSessionRouteChangeReasonKey:
                        AVAudioSession.RouteChangeReason.noSuitableRouteForCategory.rawValue])
        let routeStopped = await waitUntil { Self.isStopped(coordinator.state) }
        XCTAssertTrue(routeStopped)

        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await coordinator.waitForCurrentRequest()
        center.post(name: AVAudioSession.mediaServicesWereLostNotification, object: nil)
        let mediaServicesStopped = await waitUntil { Self.isStopped(coordinator.state) }
        XCTAssertTrue(mediaServicesStopped)
        await waitForMainActorBarrier()

        XCTAssertTrue(Self.isStopped(coordinator.state), "notification handling must not auto-resume")
        XCTAssertEqual(player.events, ["play", "stop", "play", "stop"])
        XCTAssertEqual(audio.events, ["activate", "deactivate", "activate", "deactivate"])
    }

    func testProductionNetworkConfigurationHasNoCookieCredentialOrURLCache() {
        let configuration = AlmaLiveVoicePreviewEphemeralNetwork.productionConfiguration()
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertNil(configuration.urlCredentialStorage)
        XCTAssertNil(configuration.urlCache)
        XCTAssertFalse(configuration.waitsForConnectivity)
        XCTAssertTrue(configuration.httpAdditionalHeaders?.isEmpty ?? true)
    }

    func testDuckingAudioLeaseUsesIOSReportedNormalizedOptionsForExactRestore() {
        let options = AlmaOwnedAudioSessionOptions.duckingPlayback
        let expected: AVAudioSession.CategoryOptions = [
            .duckOthers,
            .mixWithOthers,
        ]

        XCTAssertTrue(options.contains(.duckOthers))
        XCTAssertTrue(options.contains(.mixWithOthers))
        XCTAssertEqual(options, expected)
    }

    func testBuiltProductCatalogAndAllTwelveAssetsResolveOfflineThroughSwiftStore() async throws {
        let catalog = try AlmaLiveVoicePreviewCatalog.loadBundled(from: .main)
        XCTAssertEqual(catalog.entries.count, 12)
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("alma-preview-product-\(UUID().uuidString)", isDirectory: true)
        defer {
            if FileManager.default.fileExists(atPath: root.path) {
                try? FileManager.default.removeItem(at: root)
            }
        }
        let resourceRoot = try XCTUnwrap(Bundle.main.resourceURL)
        let store = try AlmaLiveVoicePreviewAssetStore(
            catalog: catalog,
            diskRoot: root.appendingPathComponent("cache", isDirectory: true),
            bundleRoot: resourceRoot.appendingPathComponent("VoicePreviews", isDirectory: true),
            cdnBaseURL: nil)

        for entry in catalog.entries.sorted(by: { $0.filename < $1.filename }) {
            let asset = try await store.asset(modelID: entry.modelID, voiceID: entry.voiceID)
            XCTAssertEqual(asset.source, .bundle, entry.filename)
            XCTAssertEqual(asset.data.count, entry.byteSize, entry.filename)
        }
    }

    func testVerifiedBundlePlaybackSurvivesOrdinaryCachePersistenceFailure() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[0], voiceID: "Aoede")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))
        fixture.files.writeError = CocoaError(.fileWriteOutOfSpace)

        let asset = try await fixture.store.asset(modelID: entry.modelID, voiceID: entry.voiceID)

        XCTAssertEqual(asset.source, .bundle)
        XCTAssertEqual(asset.data, fixture.data[entry.identity])
    }

    func testUnsafeCachePersistencePathStillFailsClosed() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[0], voiceID: "Aoede")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))
        fixture.files.writeError = AlmaLiveVoicePreviewError.unsafePath("cache-root")

        do {
            _ = try await fixture.store.asset(modelID: entry.modelID, voiceID: entry.voiceID)
            XCTFail("unsafe cache paths must fail closed")
        } catch let error as AlmaLiveVoicePreviewError {
            guard case .unsafePath = error else { return XCTFail("unexpected error: \(error)") }
        }
    }

    func testRealFileSystemRejectsSymlinkedRootAndIntermediateRemovalEscape() throws {
        let manager = FileManager.default
        let base = manager.temporaryDirectory
            .appendingPathComponent("alma-preview-symlink-\(UUID().uuidString)", isDirectory: true)
        let outside = base.appendingPathComponent("outside", isDirectory: true)
        let rootLink = base.appendingPathComponent("root-link", isDirectory: true)
        try manager.createDirectory(at: outside, withIntermediateDirectories: true)
        let sentinel = outside.appendingPathComponent("sentinel.m4a")
        try Data("do-not-delete".utf8).write(to: sentinel)
        try manager.createSymbolicLink(at: rootLink, withDestinationURL: outside)
        defer { try? manager.removeItem(at: base) }
        let files = AlmaLiveVoicePreviewFileSystem()

        XCTAssertThrowsError(try files.readRegularFile(at: rootLink.appendingPathComponent(
            "sentinel.m4a"), beneath: rootLink))
        XCTAssertThrowsError(try files.removeRegularFile(at: rootLink.appendingPathComponent(
            "sentinel.m4a"), beneath: rootLink))
        XCTAssertTrue(manager.fileExists(atPath: sentinel.path))

        let physicalRoot = base.appendingPathComponent("physical", isDirectory: true)
        try manager.createDirectory(at: physicalRoot, withIntermediateDirectories: true)
        let intermediate = physicalRoot.appendingPathComponent("live-bn-v1", isDirectory: true)
        try manager.createSymbolicLink(at: intermediate, withDestinationURL: outside)
        let escaped = intermediate.appendingPathComponent("sentinel.m4a")
        XCTAssertThrowsError(try files.readRegularFile(at: escaped, beneath: physicalRoot))
        XCTAssertThrowsError(try files.removeRegularFile(at: escaped, beneath: physicalRoot))
        XCTAssertTrue(manager.fileExists(atPath: sentinel.path))
    }

    func testRealFileSystemTrimCountsAndEvictsHiddenRegularFiles() throws {
        let manager = FileManager.default
        let root = manager.temporaryDirectory
            .appendingPathComponent("alma-preview-hidden-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: root) }
        let hidden = root.appendingPathComponent(".leftover")
        let selected = root.appendingPathComponent("selected.m4a")
        try Data(repeating: 1, count: 20).write(to: hidden)
        try Data(repeating: 2, count: 20).write(to: selected)
        try manager.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)],
                                  ofItemAtPath: hidden.path)
        try manager.setAttributes([.modificationDate: Date()], ofItemAtPath: selected.path)

        try AlmaLiveVoicePreviewFileSystem().trimRegularFiles(
            beneath: root, maximumBytes: 25, preserving: [selected])

        XCTAssertFalse(manager.fileExists(atPath: hidden.path))
        XCTAssertTrue(manager.fileExists(atPath: selected.path))
    }

    func testAssetStoreRejectsFilesystemRootAsAssetRoot() throws {
        let catalog = try AlmaLiveVoicePreviewCatalog.decodeStrict(catalogData())
        XCTAssertThrowsError(try AlmaLiveVoicePreviewAssetStore(
            catalog: catalog,
            diskRoot: URL(fileURLWithPath: "/"),
            bundleRoot: URL(fileURLWithPath: "/tmp/bundle"),
            cdnBaseURL: nil))
    }

    func testSynchronousAudioTakeoverStopsPlayerAndRelinquishesWithoutDeactivation() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[1], voiceID: "Kore")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)
        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await coordinator.waitForCurrentRequest()

        AlmaLiveVoicePreviewTakeoverRelay.shared.stopBeforeAudioTakeover()

        guard case .stopped = coordinator.state else {
            return XCTFail("takeover must synchronously stop the preview")
        }
        XCTAssertEqual(player.events, ["play", "stop"])
        XCTAssertEqual(audio.events, ["activate", "relinquish"])
    }

    func testDirectStopWhilePlayingDeactivatesAndRejectsStaleCompletion() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[1], voiceID: "Kore")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)
        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await coordinator.waitForCurrentRequest()

        coordinator.stop()
        XCTAssertEqual(coordinator.state, .stopped(2))
        XCTAssertEqual(player.events, ["play", "stop"])
        XCTAssertEqual(audio.events, ["activate", "deactivate"])

        player.finish(at: 0)
        XCTAssertEqual(coordinator.state, .stopped(2))
        XCTAssertEqual(audio.events, ["activate", "deactivate"])
    }

    func testSecondCoordinatorReplacesFirstWithNormalDeactivationThenPlays() async throws {
        let fixture = try makeFixture()
        let firstEntry = try fixture.catalog.entry(modelID: models[0], voiceID: "Aoede")
        let secondEntry = try fixture.catalog.entry(modelID: models[1], voiceID: "Kore")
        fixture.files.put(fixture.data[firstEntry.identity]!, at: fixture.bundleURL(firstEntry))
        fixture.files.put(fixture.data[secondEntry.identity]!, at: fixture.bundleURL(secondEntry))
        let firstAudio = AudioSpy()
        let firstPlayer = PlayerSpy()
        let first = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: firstAudio, player: firstPlayer,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)
        let secondAudio = AudioSpy()
        let secondPlayer = PlayerSpy()
        let second = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: secondAudio, player: secondPlayer,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)

        _ = first.play(modelID: firstEntry.modelID, voiceID: firstEntry.voiceID)
        await first.waitForCurrentRequest()
        _ = second.play(modelID: secondEntry.modelID, voiceID: secondEntry.voiceID)
        await second.waitForCurrentRequest()

        XCTAssertTrue(Self.isStopped(first.state))
        XCTAssertEqual(firstPlayer.events, ["play", "stop"])
        XCTAssertEqual(
            firstAudio.events, ["activate", "deactivate"],
            "preview-to-preview replacement must restore the prior audio session")
        XCTAssertEqual(second.state, .playing(
            1, modelID: secondEntry.modelID, voiceID: secondEntry.voiceID))
        XCTAssertEqual(secondPlayer.playedData, [fixture.data[secondEntry.identity]!])
        XCTAssertEqual(secondAudio.events, ["activate"])
    }

    func testNaturalFinishAndPlayerStartFailureReleasePreviewSession() async throws {
        let fixture = try makeFixture()
        let entry = try fixture.catalog.entry(modelID: models[1], voiceID: "Aoede")
        fixture.files.put(fixture.data[entry.identity]!, at: fixture.bundleURL(entry))
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)
        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await coordinator.waitForCurrentRequest()
        player.finish(at: 0)
        XCTAssertEqual(coordinator.state, .idle)
        XCTAssertEqual(audio.events, ["activate", "deactivate"])

        let failingAudio = AudioSpy()
        let failingPlayer = PlayerSpy()
        failingPlayer.playbackError = AlmaLiveVoicePreviewError.audioPlaybackFailed
        let failingCoordinator = AlmaLiveVoicePreviewCoordinator(
            store: fixture.store, audioSession: failingAudio, player: failingPlayer,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)
        _ = failingCoordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        await failingCoordinator.waitForCurrentRequest()
        XCTAssertEqual(failingCoordinator.state, .failed(1, .audio))
        XCTAssertEqual(failingAudio.events, ["activate", "deactivate"])
    }

    func testStopDuringLoadRejectsLateNetworkWriteAndAudioStart() async throws {
        let catalog = try AlmaLiveVoicePreviewCatalog.decodeStrict(catalogData())
        let files = FileSpy()
        let network = ControlledNetwork()
        let roots = roots()
        let store = try AlmaLiveVoicePreviewAssetStore(
            catalog: catalog, diskRoot: roots.disk, bundleRoot: roots.bundle,
            cdnBaseURL: URL(string: "https://cdn.example")!, files: files, network: network)
        let entry = try catalog.entry(modelID: models[0], voiceID: "Charon")
        let audio = AudioSpy()
        let player = PlayerSpy()
        let coordinator = AlmaLiveVoicePreviewCoordinator(
            store: store, audioSession: audio, player: player,
            admission: { .init(featureEnabled: true, callIsActive: false) },
            notificationCenter: nil)

        _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
        let requestReady = await network.waitForPending(1)
        XCTAssertTrue(requestReady)
        coordinator.stop()
        await network.complete(
            filename: entry.filename, response: Self.response(entry: entry, data: fixtureData()))
        let returned = await network.waitForReturnedFetches(1)
        XCTAssertTrue(returned)
        await waitForMainActorBarrier()

        guard case .stopped = coordinator.state else { return XCTFail("stop must be terminal") }
        XCTAssertTrue(files.writes.isEmpty)
        XCTAssertTrue(audio.events.isEmpty)
        XCTAssertTrue(player.events.isEmpty)
    }

    func testLifecycleAndShutdownDuringLoadRejectLateWritesAndAudio() async throws {
        enum Termination: CaseIterable { case lifecycle, shutdown }

        for termination in Termination.allCases {
            let catalog = try AlmaLiveVoicePreviewCatalog.decodeStrict(catalogData())
            let files = FileSpy()
            let network = ControlledNetwork()
            let roots = roots()
            let store = try AlmaLiveVoicePreviewAssetStore(
                catalog: catalog, diskRoot: roots.disk, bundleRoot: roots.bundle,
                cdnBaseURL: URL(string: "https://cdn.example")!, files: files, network: network)
            let entry = try catalog.entry(modelID: models[0], voiceID: "Orus")
            let audio = AudioSpy()
            let player = PlayerSpy()
            let coordinator = AlmaLiveVoicePreviewCoordinator(
                store: store, audioSession: audio, player: player,
                admission: { .init(featureEnabled: true, callIsActive: false) },
                notificationCenter: NotificationCenter())

            _ = coordinator.play(modelID: entry.modelID, voiceID: entry.voiceID)
            let pending = await network.waitForPending(1)
            XCTAssertTrue(pending, "\(termination) request never started")
            switch termination {
            case .lifecycle:
                coordinator.handleLifecycle(.background)
            case .shutdown:
                coordinator.shutdown()
            }
            await network.complete(
                filename: entry.filename,
                response: Self.response(entry: entry, data: fixtureData()))
            let returned = await network.waitForReturnedFetches(1)
            XCTAssertTrue(returned)
            await waitForMainActorBarrier()

            XCTAssertTrue(Self.isStopped(coordinator.state), "\(termination) must be terminal")
            XCTAssertTrue(files.writes.isEmpty, "\(termination) allowed a stale cache write")
            XCTAssertTrue(audio.events.isEmpty, "\(termination) allowed audio activation")
            XCTAssertTrue(player.events.isEmpty, "\(termination) allowed playback")
        }
    }

    // MARK: - Fixtures

    private struct Fixture {
        let catalog: AlmaLiveVoicePreviewCatalog
        let data: [String: Data]
        let files: FileSpy
        let network: NetworkSpy
        let store: AlmaLiveVoicePreviewAssetStore
        let diskRoot: URL
        let bundleRoot: URL

        func diskURL(_ entry: AlmaLiveVoicePreviewCatalog.Entry) -> URL {
            diskRoot.appendingPathComponent("live-bn-v1/\(entry.filename)")
        }

        func bundleURL(_ entry: AlmaLiveVoicePreviewCatalog.Entry) -> URL {
            bundleRoot.appendingPathComponent("live-bn-v1/\(entry.filename)")
        }

        func response(for entry: AlmaLiveVoicePreviewCatalog.Entry) -> AlmaLiveVoicePreviewNetworkResponse {
            LiveVoicePreviewTests.response(entry: entry, data: data)
        }
    }

    private func makeFixture(eventLog: EventLog? = nil) throws -> Fixture {
        let catalog = try AlmaLiveVoicePreviewCatalog.decodeStrict(catalogData())
        let files = FileSpy(events: eventLog)
        let network = NetworkSpy(events: eventLog)
        let roots = roots()
        let store = try AlmaLiveVoicePreviewAssetStore(
            catalog: catalog,
            diskRoot: roots.disk,
            bundleRoot: roots.bundle,
            cdnBaseURL: URL(string: "https://cdn.example")!,
            files: files,
            network: network)
        return Fixture(
            catalog: catalog, data: fixtureData(), files: files, network: network,
            store: store, diskRoot: roots.disk, bundleRoot: roots.bundle)
    }

    private func roots() -> (disk: URL, bundle: URL) {
        let root = URL(fileURLWithPath: "/tmp/alma-live-preview-tests", isDirectory: true)
        return (
            root.appendingPathComponent("disk", isDirectory: true),
            root.appendingPathComponent("bundle", isDirectory: true))
    }

    private func fixtureData() -> [String: Data] {
        Dictionary(uniqueKeysWithValues: models.flatMap { model in
            personas.keys.map { voice in
                ("\(model)\u{0}\(voice)", Data("audio|\(model)|\(voice)".utf8))
            }
        })
    }

    private func catalogData() -> Data {
        let data = fixtureData()
        let entries: [[String: Any]] = models.flatMap { model in
            personas.keys.sorted().map { voice in
                let identity = "\(model)\u{0}\(voice)"
                let bytes = data[identity]!
                return [
                    "modelID": model,
                    "modelLifecycle": "preview",
                    "voiceID": voice,
                    "persona": personas[voice]!,
                    "filename": model.replacingOccurrences(of: ".", with: "-")
                        + "--\(voice.lowercased())--bn-BD--v1--aac-v1.m4a",
                    "sha256": sha256(bytes),
                    "byteSize": bytes.count,
                    "durationSeconds": 1.0,
                    "approved": false,
                    "generatedAt": "2026-08-09T11:14:52.559Z",
                    "generationTranscript": NSNull(),
                ]
            }
        }
        return jsonData([
            "schemaVersion": 1,
            "catalogVersion": "live-bn-v1",
            "status": "generated_pending_owner_approval",
            "locale": "bn-BD",
            "scriptVersion": "v1",
            "codecVersion": "aac-v1",
            "cdnPath": "/voice-previews/live-bn-v1/",
            "cache": [
                "immutable": true,
                "memory": true,
                "diskLimitBytes": 33_554_432,
                "revalidateAfterSeconds": 604_800,
                "checksum": "sha256",
            ],
            "scriptLines": AlmaLiveVoicePreviewCatalog.expectedScriptLines,
            "entries": entries,
            "generatedAt": "2026-08-09T11:43:32.017Z",
        ])
    }

    nonisolated private static func response(
        entry: AlmaLiveVoicePreviewCatalog.Entry,
        data: [String: Data]
    ) -> AlmaLiveVoicePreviewNetworkResponse {
        let bytes = data[entry.identity]!
        return AlmaLiveVoicePreviewNetworkResponse(
            data: bytes,
            statusCode: 200,
            mimeType: "audio/mp4",
            expectedContentLength: Int64(bytes.count),
            finalURL: URL(string: "https://cdn.example/voice-previews/live-bn-v1/\(entry.filename)")!,
            wasRedirected: false)
    }

    private func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func jsonData(_ object: Any) -> Data {
        try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func jsonObject(_ data: Data) -> Any {
        try! JSONSerialization.jsonObject(with: data)
    }

    private func silentWAV() -> Data {
        Data([
            0x52, 0x49, 0x46, 0x46, 0x26, 0x00, 0x00, 0x00,
            0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
            0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
            0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00,
            0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74, 0x61,
            0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
        ])
    }

    private static func isStopped(_ state: AlmaLiveVoicePreviewCoordinator.State) -> Bool {
        if case .stopped = state { return true }
        return false
    }

    private func waitUntil(
        attempts: Int = 1_000,
        _ predicate: @MainActor () -> Bool
    ) async -> Bool {
        for _ in 0..<attempts {
            if predicate() { return true }
            await Task.yield()
        }
        return predicate()
    }

    private func waitForMainActorBarrier() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}

private extension AlmaLiveVoicePreviewNetworkResponse {
    func copy(
        data: Data? = nil,
        statusCode: Int? = nil,
        mimeType: String? = nil,
        expectedContentLength: Int64? = nil,
        finalURL: URL? = nil,
        wasRedirected: Bool? = nil
    ) -> Self {
        .init(
            data: data ?? self.data,
            statusCode: statusCode ?? self.statusCode,
            mimeType: mimeType ?? self.mimeType,
            expectedContentLength: expectedContentLength ?? self.expectedContentLength,
            finalURL: finalURL ?? self.finalURL,
            wasRedirected: wasRedirected ?? self.wasRedirected)
    }
}

private final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []
    var values: [String] { lock.withLock { storage } }
    func append(_ value: String) { lock.withLock { storage.append(value) } }
}

private final class FileSpy: AlmaLiveVoicePreviewFileAccess, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: Data] = [:]
    private var readStorage: [String] = []
    private var writeStorage: [String] = []
    private var removeStorage: [String] = []
    private var trimStorage: [(String, Int, Set<URL>)] = []
    private let events: EventLog?
    var writeError: Error?
    var trimError: Error?

    init(events: EventLog? = nil) { self.events = events }
    var reads: [String] { lock.withLock { readStorage } }
    var writes: [String] { lock.withLock { writeStorage } }
    var removes: [String] { lock.withLock { removeStorage } }
    var trims: [(String, Int, Set<URL>)] { lock.withLock { trimStorage } }

    func put(_ data: Data, at url: URL) { lock.withLock { storage[url.path] = data } }
    func data(at url: URL) -> Data? { lock.withLock { storage[url.path] } }

    func readRegularFile(at url: URL, beneath root: URL) throws -> Data? {
        events?.append("file.read")
        return lock.withLock {
            readStorage.append(url.path)
            return storage[url.path]
        }
    }

    func writeAtomically(_ data: Data, to url: URL, beneath root: URL) throws {
        events?.append("file.write")
        if let writeError { throw writeError }
        lock.withLock {
            writeStorage.append(url.path)
            storage[url.path] = data
        }
    }

    func removeRegularFile(at url: URL, beneath root: URL) throws {
        lock.withLock {
            removeStorage.append(url.path)
            storage.removeValue(forKey: url.path)
        }
    }

    func trimRegularFiles(
        beneath root: URL, maximumBytes: Int, preserving urls: Set<URL>
    ) throws {
        if let trimError { throw trimError }
        lock.withLock { trimStorage.append((root.path, maximumBytes, urls)) }
    }
}

private final class NetworkSpy: AlmaLiveVoicePreviewNetworking, @unchecked Sendable {
    private let lock = NSLock()
    private var fetchCountStorage = 0
    private var maximumBytesStorage: [Int] = []
    private var responseStorage: AlmaLiveVoicePreviewNetworkResponse?
    private let events: EventLog?

    init(events: EventLog? = nil) { self.events = events }
    var fetchCount: Int { lock.withLock { fetchCountStorage } }
    var maximumBytes: [Int] { lock.withLock { maximumBytesStorage } }
    var response: AlmaLiveVoicePreviewNetworkResponse? {
        get { lock.withLock { responseStorage } }
        set { lock.withLock { responseStorage = newValue } }
    }

    func fetch(_ url: URL, maximumBytes: Int) async throws -> AlmaLiveVoicePreviewNetworkResponse {
        events?.append("network.fetch")
        return try lock.withLock {
            fetchCountStorage += 1
            maximumBytesStorage.append(maximumBytes)
            guard let responseStorage else {
                throw AlmaLiveVoicePreviewError.assetMissing(url.lastPathComponent)
            }
            return responseStorage
        }
    }
}

private actor ControlledNetwork: AlmaLiveVoicePreviewNetworking {
    private var pending: [String: CheckedContinuation<AlmaLiveVoicePreviewNetworkResponse, Error>] = [:]
    private var returnedFetches = 0

    func fetch(_ url: URL, maximumBytes: Int) async throws -> AlmaLiveVoicePreviewNetworkResponse {
        let response = try await withCheckedThrowingContinuation { continuation in
            pending[url.lastPathComponent] = continuation
        }
        returnedFetches += 1
        return response
    }

    func waitForPending(_ count: Int) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(5))
        while clock.now < deadline {
            if pending.count >= count { return true }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        return pending.count >= count
    }

    func complete(filename: String, response: AlmaLiveVoicePreviewNetworkResponse) {
        pending.removeValue(forKey: filename)?.resume(returning: response)
    }

    func waitForReturnedFetches(_ count: Int) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(5))
        while clock.now < deadline {
            if returnedFetches >= count { return true }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        return returnedFetches >= count
    }
}

@MainActor
private final class AudioSpy: AlmaLiveVoicePreviewAudioSession {
    private(set) var events: [String] = []
    private let log: EventLog?
    var activationError: Error?
    init(events: EventLog? = nil) { log = events }
    func activateForVerifiedPreview() throws {
        events.append("activate")
        log?.append("audio.activate")
        if let activationError { throw activationError }
    }
    func deactivateAfterPreview() {
        events.append("deactivate")
        log?.append("audio.deactivate")
    }
    func relinquishWithoutMutatingAudioSession() {
        events.append("relinquish")
        log?.append("audio.relinquish")
    }
}

@MainActor
private final class PlayerSpy: AlmaLiveVoicePreviewPlayer {
    private(set) var events: [String] = []
    private(set) var playedData: [Data] = []
    private var completions: [@MainActor () -> Void] = []
    private let log: EventLog?
    var playbackError: Error?
    init(events: EventLog? = nil) { log = events }
    func playVerifiedData(
        _ data: Data, onFinished: @escaping @MainActor () -> Void
    ) throws {
        events.append("play")
        playedData.append(data)
        log?.append("player.play")
        if let playbackError { throw playbackError }
        completions.append(onFinished)
    }
    func stop() {
        events.append("stop")
        log?.append("player.stop")
    }
    func finish(at index: Int) { completions[index]() }
}

@MainActor
private final class PreCallPreviewSpy: AlmaLiveVoicePreCallPreviewCoordinating {
    private var stateStorage: AlmaLiveVoicePreviewCoordinator.State = .idle
    private(set) var stateReadCount = 0
    private(set) var playRequests: [(modelID: String, voiceID: String)] = []
    private(set) var stopCount = 0
    private(set) var shutdownCount = 0
    var decision: AlmaLiveVoicePreviewCoordinator.RequestDecision = .blockedActiveCall

    var state: AlmaLiveVoicePreviewCoordinator.State {
        get {
            stateReadCount += 1
            return stateStorage
        }
        set { stateStorage = newValue }
    }

    func play(
        modelID: String,
        voiceID: String
    ) -> AlmaLiveVoicePreviewCoordinator.RequestDecision {
        playRequests.append((modelID: modelID, voiceID: voiceID))
        if case .started(let generation) = decision {
            stateStorage = .loading(generation)
        }
        return decision
    }

    func stop() {
        stopCount += 1
        stateStorage = .stopped(UInt64(stopCount))
    }

    func shutdown() {
        shutdownCount += 1
        stateStorage = .stopped(UInt64(shutdownCount))
    }
}

@MainActor
private final class AdmissionBox {
    var value: AlmaLiveVoicePreviewGate
    init(_ value: AlmaLiveVoicePreviewGate) { self.value = value }
}
