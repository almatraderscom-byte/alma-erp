import XCTest
@testable import App

@MainActor
final class AssistantParityV2Tests: XCTestCase {
    func testHugeSessionMountAndSearchIndexStayBounded() {
        let vm = AssistantVM()
        vm.loadHugeSessionFixture()

        XCTAssertEqual(vm.messages.count, AssistantVM.mountedHistoryLimit)
        XCTAssertEqual(vm.searchableMessages.count, 600)
        XCTAssertLessThanOrEqual(vm.messages.count, 72)
    }

    func testCachedSearchHitPromotesExactMessageWithoutGrowingMount() {
        let vm = AssistantVM()
        vm.loadHugeSessionFixture()

        XCTAssertFalse(vm.messages.contains { $0.id == "huge-u-20" })
        XCTAssertTrue(vm.focusCachedMessage("huge-u-20"))
        XCTAssertTrue(vm.messages.contains { $0.id == "huge-u-20" })
        XCTAssertEqual(vm.messages.count, AssistantVM.mountedHistoryLimit)
    }

    func testCachedPromotionCannotEvictActiveStreamingTail() {
        let vm = AssistantVM()
        vm.loadHugeSessionFixture()
        vm.loadMergeReadinessRecoverySeed()
        let tailIds = vm.messages.map(\.id)
        XCTAssertFalse(vm.focusCachedMessage("huge-u-20"))
        XCTAssertEqual(vm.messages.map(\.id), tailIds)
        XCTAssertTrue(vm.isStreaming)
    }

    func testParityPresentationSubsystemsDefaultOn() {
        for subsystem in AgentParitySubsystem.allCases {
            UserDefaults.standard.removeObject(
                forKey: "alma.assistant.parity-v2." + subsystem.rawValue)
            XCTAssertTrue(AgentParityFlags.isEnabled(subsystem))
        }
    }

    func testProvisionalDraftKeepsStableIdentityAcrossVMRelaunch() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: "alma.assistant.selectedSessionIdentity.v2")
        defaults.removeObject(forKey: "alma.assistant.composerDrafts.v2")

        let first = AssistantVM()
        first.composerDraft = "kill-এর পরও draft থাকবে"
        let identity = first.debugSelectedSessionIdentity

        let relaunched = AssistantVM()
        relaunched.debugRestoreComposerDraft()
        XCTAssertEqual(relaunched.debugSelectedSessionIdentity, identity)
        XCTAssertTrue(relaunched.debugShouldRestoreProvisionalSession)
        XCTAssertEqual(relaunched.composerDraft, "kill-এর পরও draft থাকবে")
    }

    func testDurableDictationAudioRearmsRetryWhenMarkerWasLost() {
        let first = AssistantVM()
        first.loadDictationRecoveryFixture()
        XCTAssertTrue(first.canRetryDictation)
        first.dictationFailure = nil // process died after clearing UI state

        let relaunched = AssistantVM()
        relaunched.debugRestoreDurableDictationRecovery()
        XCTAssertTrue(relaunched.canRetryDictation)
        XCTAssertNotNil(relaunched.dictationFailure)
    }

    func testCanonicalPresentationUsesServerStableBlockIDsAndUsage() throws {
        let json = #"""
        {"id":"m1","role":"assistant","content":[{"type":"text","text":"final"}],
         "presentation":{"version":1,"messageId":"m1","selfCorrected":true,
          "blocks":[
           {"id":"m1:b0","type":"prose","text":"draft","state":"superseded"},
           {"id":"m1:b1","type":"activity","activityType":"tool","label":"inventory","status":"done","toolName":"inventory","result":"ok"},
           {"id":"m1:b2","type":"prose","text":"final","state":"final"}],
          "usage":{"tokensIn":10,"tokensOut":5,"cacheCreation":2,"cacheRead":3,"costUsd":0.04,"apiRounds":2,"roundCostsUsd":[0.01,0.03]}}}
        """#
        let wire = try JSONDecoder().decode(AgentMessageWire.self, from: Data(json.utf8))
        let message = AgentChatMessage.from(wire)
        XCTAssertEqual(message.blocks.map(\.id), ["m1:b0", "m1:b1", "m1:b2"])
        XCTAssertEqual(message.supersededBlockIds, Set(["m1:b0"]))
        XCTAssertEqual(message.tools.first?.id, "m1:b1")
        XCTAssertEqual(message.tokensIn, 10)
        XCTAssertEqual(message.apiRounds, 2)
        XCTAssertTrue(message.selfCorrected)
    }

    func testCacheOverflowStaysBoundedAndKeepsForwardRecovery() async {
        let vm = AssistantVM()
        vm.loadHistoryCacheOverflowFixture()
        XCTAssertEqual(vm.messages.count, AssistantVM.mountedHistoryLimit)
        XCTAssertTrue(vm.canLoadNewer)
        for _ in 0..<12 { await vm.loadNewerMessages() }
        XCTAssertEqual(vm.messages.count, AssistantVM.mountedHistoryLimit)
        XCTAssertEqual(Set(vm.searchableMessages.map(\.id)).count, vm.searchableMessages.count)
        XCTAssertTrue(vm.canLoadNewer, "trimmed tail must remain recoverable through the server after-cursor")
    }

    func testLibraryClassifiesAssistantFileRefAsGenerated() {
        let vm = AssistantVM()
        var uploaded = AgentChatMessage(id: "u", role: .user, text: "upload")
        uploaded.fileRefs = [.init(bucket: "b", path: "owner.pdf", mediaType: "application/pdf")]
        var generated = AgentChatMessage(id: "a", role: .assistant, text: "generated")
        generated.fileRefs = [.init(bucket: "b", path: "report.pdf", mediaType: "application/pdf")]
        vm.messages = [uploaded, generated]
        XCTAssertEqual(vm.sessionFiles.first { $0.name == "owner.pdf" }?.origin, .uploaded)
        XCTAssertEqual(vm.sessionFiles.first { $0.name == "report.pdf" }?.origin, .generated)
    }

    func testActiveTurnBlocksArchiveAndDeleteBeforeNetworkMutation() async {
        let vm = AssistantVM()
        vm.loadMergeReadinessRecoverySeed()
        let archived = await vm.archiveConversation("fixture-recovery-conversation")
        let deleted = await vm.deleteConversation("fixture-recovery-conversation")
        XCTAssertFalse(archived)
        XCTAssertFalse(deleted)
        XCTAssertEqual(vm.conversationId, "fixture-recovery-conversation")
        XCTAssertTrue(vm.conversationMutationBlocked)
    }

    func testNonSelectedBackgroundTurnAlsoBlocksMutation() async {
        let vm = AssistantVM()
        vm.debugSetActiveBackgroundConversation("background-conversation")
        XCTAssertTrue(vm.conversationMutationBlocked(for: "background-conversation"))
        let archived = await vm.archiveConversation("background-conversation")
        let deleted = await vm.deleteConversation("background-conversation")
        XCTAssertFalse(archived)
        XCTAssertFalse(deleted)
    }

    func testDirectStreamEOFWithoutTerminalRequiresDurableRecovery() {
        XCTAssertTrue(AssistantVM.directStreamEndRequiresRecovery(sawTerminalEvent: false))
        XCTAssertFalse(AssistantVM.directStreamEndRequiresRecovery(sawTerminalEvent: true))
    }

    func testPreTurnCleanEOFRetryIsBoundedAndBacksOff() {
        XCTAssertEqual(AssistantVM.preTurnEOFRetryDelay(for: 1), 1)
        XCTAssertEqual(AssistantVM.preTurnEOFRetryDelay(for: 2), 2)
        XCTAssertNil(AssistantVM.preTurnEOFRetryDelay(for: 3))
        XCTAssertNil(AssistantVM.preTurnEOFRetryDelay(for: 4))
    }

    func testAcceptanceUnknownTerminalStatusRequiresPositiveSendEvidence() {
        let sentAt = Date()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        XCTAssertFalse(AssistantVM.terminalStartedAtMatchesSend(startedAt: nil, sentAt: sentAt))
        XCTAssertTrue(AssistantVM.terminalStartedAtMatchesSend(
            startedAt: formatter.string(from: sentAt), sentAt: sentAt))
        XCTAssertFalse(AssistantVM.terminalStartedAtMatchesSend(
            startedAt: formatter.string(from: sentAt.addingTimeInterval(-60)), sentAt: sentAt))
    }

    func testActionContinuationKeepsOneIdAcrossRetryAndRelaunch() {
        let key = "test-action-\(UUID().uuidString)"
        let first = AssistantVM()
        let firstId = first.debugStableActionContinuationId(
            key: key, text: "PDF", askCardId: "ask-1")
        let relaunched = AssistantVM()
        let retryId = relaunched.debugStableActionContinuationId(
            key: key, text: "new retry payload before acceptance",
            askCardId: "ask-1")
        XCTAssertEqual(retryId, firstId)
        XCTAssertEqual(
            relaunched.debugActionContinuationText(key: key),
            "new retry payload before acceptance")
        relaunched.debugMarkActionContinuationAccepted(clientMessageId: retryId)
        let afterAcceptance = AssistantVM()
        XCTAssertTrue(afterAcceptance.debugActionContinuationIsAccepted(key: key))
        XCTAssertEqual(
            afterAcceptance.debugStableActionContinuationId(
                key: key, text: "must not create a new continuation", askCardId: "ask-1"),
            firstId)
        afterAcceptance.debugRemoveActionContinuation(key: key)
    }

    func testAskAndOpinionDraftsPersistAcrossRelaunch() {
        let cardId = "fixture-persisted-action"
        let first = AssistantVM()
        first.askChosenOption[cardId] = "PDF"
        first.askDraftText[cardId] = "নিজের উত্তর"
        first.askOtherActiveIds.insert(cardId)
        first.opinionDraftText[cardId] = "এই অংশটি আগে বদলান"
        first.opinionOpenIds.insert(cardId)

        let relaunched = AssistantVM()
        XCTAssertEqual(relaunched.askChosenOption[cardId], "PDF")
        XCTAssertEqual(relaunched.askDraftText[cardId], "নিজের উত্তর")
        XCTAssertTrue(relaunched.askOtherActiveIds.contains(cardId))
        XCTAssertEqual(relaunched.opinionDraftText[cardId], "এই অংশটি আগে বদলান")
        XCTAssertTrue(relaunched.opinionOpenIds.contains(cardId))

        relaunched.askChosenOption.removeValue(forKey: cardId)
        relaunched.askDraftText.removeValue(forKey: cardId)
        relaunched.askOtherActiveIds.remove(cardId)
        relaunched.opinionDraftText.removeValue(forKey: cardId)
        relaunched.opinionOpenIds.remove(cardId)
    }
}
