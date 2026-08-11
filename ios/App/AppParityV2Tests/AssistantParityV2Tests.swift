import XCTest
@testable import App

@MainActor
final class AssistantParityV2Tests: XCTestCase {
    func testLiveSkillPinUpdatesComposerAndStreamingTurnTogether() {
        let vm = AssistantVM()

        vm.debugApplyTurnEvents([.skillPinned(
            skill: "alma-image-generation", source: "router",
            reason: "image generation", isolated: true)])

        XCTAssertEqual(vm.pinnedSkillName, "alma-image-generation")
        XCTAssertEqual(vm.messages.last?.skill?.name, "alma-image-generation")
    }

    func testClearedServerPinWinsOverHistoricalSkillStamp() {
        let vm = AssistantVM()
        vm.debugApplyTurnEvents([.skillPinned(
            skill: "alma-image-generation", source: "router",
            reason: "historical image turn", isolated: true)])
        XCTAssertEqual(vm.pinnedSkillName, "alma-image-generation")

        vm.debugApplyConversationSettings(permissionMode: nil, pinnedSkill: nil)

        XCTAssertNil(vm.pinnedSkillName)
        XCTAssertEqual(vm.messages.last?.skill?.name, "alma-image-generation",
                       "history remains factual without becoming the current pin")
    }

    func testGeneratedFileRefsSuppressDuplicateMarkdownImageGallery() {
        XCTAssertTrue(AgentMarkdownText.shouldRenderRemoteImages(suppressRemoteImages: false))
        XCTAssertFalse(AgentMarkdownText.shouldRenderRemoteImages(suppressRemoteImages: true))
    }

    func testGeneratedImageActionRestoresUnsentComposerContextWhenCancelled() {
        let vm = AssistantVM()
        let originalRef = AgentFileRef(
            bucket: "agent-files", path: "draft-reference.png", mediaType: "image/png")
        let generatedRef = AgentFileRef(
            bucket: "agent-files", path: "generated.png", mediaType: "image/png")
        vm.composerDraft = "Owner's unrelated unsent draft"
        vm.referencedFileRefs = [originalRef]
        vm.composerSelectionReference = "selected draft quote"

        vm.referenceGeneratedImage(generatedRef, variation: false)

        XCTAssertEqual(vm.referencedFileRefs, [generatedRef])
        XCTAssertNil(vm.composerSelectionReference)
        XCTAssertEqual(vm.composerDraft, "এই ছবিটি edit করুন: ")

        vm.removeReferencedFile(generatedRef)

        XCTAssertEqual(vm.composerDraft, "Owner's unrelated unsent draft")
        XCTAssertEqual(vm.referencedFileRefs, [originalRef])
        XCTAssertEqual(vm.composerSelectionReference, "selected draft quote")
    }

    func testMermaidBranchParserPreservesActualEdges() {
        let edges = AgentMermaidDiagram.parseEdges("""
        graph TD
        A[Prompt]-->B[Tool]
        A-->C[Approval]
        """)

        XCTAssertEqual(edges, [
            .init(from: "Prompt", to: "Tool"),
            .init(from: "Prompt", to: "Approval"),
        ])
        XCTAssertFalse(edges?.contains(.init(from: "Tool", to: "Approval")) ?? true)
    }

    func testUnsupportedMermaidFallsBackInsteadOfInventingEdges() {
        XCTAssertNil(AgentMermaidDiagram.parseEdges("graph TD\nA -.-> B"))
    }

    func testAttachmentDeduplicationPreservesOwnerSelectionOrder() {
        let first = AgentFileRef(bucket: "agent", path: "first.png", mediaType: "image/png")
        let second = AgentFileRef(bucket: "agent", path: "second.png", mediaType: "image/png")

        XCTAssertEqual(almaOrderedUniqueFileRefs([first, second, first]), [first, second])
    }

    func testInteractiveFormResponseAppendsWithoutDestroyingDraft() {
        XCTAssertEqual(
            almaComposerDraftAppending("Budget: 500\nNote: Launch", to: "Keep this owner draft"),
            "Keep this owner draft\n\nBudget: 500\nNote: Launch")
        XCTAssertEqual(almaComposerDraftAppending("Budget: 500", to: ""), "Budget: 500")
    }

    func testSideConversationRefusalDoesNotModifyCurrentComposer() async {
        let vm = AssistantVM()
        vm.conversationId = "current-conversation"
        vm.composerDraft = "Owner's unsent draft"
        vm.isStreaming = true

        await vm.prepareSelectionQuestion("selected private text", inSideConversation: true)

        XCTAssertEqual(vm.conversationId, "current-conversation")
        XCTAssertEqual(vm.composerDraft, "Owner's unsent draft")
        XCTAssertNil(vm.composerSelectionReference)
    }

    func testRegenerateReplaysAcceptedRowWithoutConsumingComposerContext() async {
        let vm = AssistantVM()
        vm.conversationId = "regenerate-conversation"
        vm.composerDraft = "Unsent future request"
        vm.composerSelectionReference = "Draft-only selection"
        let draftRef = AgentFileRef(bucket: "agent", path: "draft.png", mediaType: "image/png")
        let originalRef = AgentFileRef(bucket: "agent", path: "original.png", mediaType: "image/png")
        vm.referencedFileRefs = [draftRef]
        var accepted = AgentChatMessage(id: "accepted", role: .user, text: "Original accepted prompt")
        accepted.fileRefs = [originalRef]

        await vm.regenerateAcceptedPrompt(accepted)

        XCTAssertEqual(vm.composerDraft, "Unsent future request")
        XCTAssertEqual(vm.composerSelectionReference, "Draft-only selection")
        XCTAssertEqual(vm.referencedFileRefs, [draftRef])
        let replay = vm.messages.first { $0.role == .user && $0.text == "Original accepted prompt" }
        XCTAssertEqual(replay?.fileRefs, [originalRef])
        XCTAssertFalse(replay?.text.contains("Draft-only selection") ?? true)
    }

    func testPenaltyApprovalDecisionFullHalfAndCustomResults() {
        let full = PenaltyApprovalDecision(
            originalPenalty: 1_000, requestedReduction: 1_000, amountText: "1000")
        XCTAssertTrue(full.isValid)
        XCTAssertEqual(full.walletCredit, 1_000)
        XCTAssertEqual(full.remainingPenalty, 0)
        XCTAssertFalse(full.isPartial)
        XCTAssertEqual(full.halfPenalty, 500)

        let half = PenaltyApprovalDecision(
            originalPenalty: 1_000, requestedReduction: 1_000, amountText: "500")
        XCTAssertTrue(half.isValid)
        XCTAssertEqual(half.walletCredit, 500)
        XCTAssertEqual(half.remainingPenalty, 500)
        XCTAssertTrue(half.isPartial)

        let custom = PenaltyApprovalDecision(
            originalPenalty: 1_000, requestedReduction: 800, amountText: "375")
        XCTAssertTrue(custom.isValid)
        XCTAssertEqual(custom.walletCredit, 375)
        XCTAssertEqual(custom.remainingPenalty, 625)
        XCTAssertTrue(custom.isPartial)
    }

    func testPenaltyApprovalDecisionRejectsInvalidBoundaries() {
        for invalid in ["", "abc", "0", "-1", "801"] {
            let decision = PenaltyApprovalDecision(
                originalPenalty: 1_000, requestedReduction: 800, amountText: invalid)
            XCTAssertFalse(decision.isValid, "\(invalid) must not be submittable")
            XCTAssertEqual(decision.walletCredit, 0)
            XCTAssertEqual(decision.remainingPenalty, 1_000)
        }

        let inconsistentServerAmounts = PenaltyApprovalDecision(
            originalPenalty: 600, requestedReduction: 800, amountText: "601")
        XCTAssertFalse(inconsistentServerAmounts.isValid,
                       "credit must never exceed the original penalty")
    }

    func testLiveBargeInCorrelationRecognizesRenderedEchoWithSmallDelay() {
        let rendered: [Float] = (0..<160).map {
            let x = Double($0)
            return Float(sin(x * 0.19) * 0.7 + sin(x * 0.047) * 0.3)
        }
        let delayed = Array(repeating: Float.zero, count: 11) + rendered.dropLast(11)

        XCTAssertGreaterThan(
            AlmaLiveBargeInEvidence.normalizedCorrelation(rendered, Array(delayed)),
            0.90,
            "a delayed copy of ALMA's own waveform must remain classified as echo")
    }

    func testLiveBargeInRejectsEchoMusicAndNoiseButAcceptsDoubleTalk() {
        XCTAssertFalse(AlmaLiveBargeInEvidence.isHumanSpeech(
            micRMS: 0.040, echoFloorRMS: 0.030,
            echoCorrelation: 0.76, calibratedEchoCorrelation: 0.78,
            speechConfidence: 0.82, musicConfidence: 0.03, noiseConfidence: 0.02),
            "ALMA's own speech has high reference correlation and must not stop playback")
        XCTAssertFalse(AlmaLiveBargeInEvidence.isHumanSpeech(
            micRMS: 0.052, echoFloorRMS: 0.030,
            echoCorrelation: 0.16, calibratedEchoCorrelation: 0.78,
            speechConfidence: 0.31, musicConfidence: 0.72, noiseConfidence: 0.04),
            "music may break correlation but must not count as owner speech")
        XCTAssertFalse(AlmaLiveBargeInEvidence.isHumanSpeech(
            micRMS: 0.052, echoFloorRMS: 0.030,
            echoCorrelation: 0.14, calibratedEchoCorrelation: 0.78,
            speechConfidence: 0.20, musicConfidence: 0.04, noiseConfidence: 0.61),
            "ambient noise may break correlation but must not count as owner speech")
        XCTAssertTrue(AlmaLiveBargeInEvidence.isHumanSpeech(
            micRMS: 0.052, echoFloorRMS: 0.030,
            echoCorrelation: 0.18, calibratedEchoCorrelation: 0.78,
            speechConfidence: 0.79, musicConfidence: 0.06, noiseConfidence: 0.03),
            "nearby speech that no longer matches ALMA's waveform must interrupt")
    }

    func testTopModelMenuPreservesAutoAndProviderGrouping() {
        let models = [
            AgentModelInfo(id: "claude", label: "Claude", provider: "anthropic", enabled: true,
                           isDefault: false, contextWindow: 200_000),
            AgentModelInfo(id: "gemini", label: "Gemini", provider: "google", enabled: true,
                           isDefault: true, contextWindow: 1_000_000),
        ]

        let elements = AssistantBarHooks.modelMenuElements(
            models: models, selectedId: nil, onSelect: { _ in })
        let menus = elements.compactMap { $0 as? UIMenu }
        let actions = menus.flatMap(\.children).compactMap { $0 as? UIAction }

        XCTAssertEqual(menus.count, 3)
        XCTAssertEqual(actions.map(\.title), ["Auto", "Claude", "Gemini"])
        XCTAssertEqual(actions.first?.state, .on)
    }

    func testNativeContextWindowDecodesProviderMeasuredUsage() throws {
        let json = Data(#"""
        {
          "checkedAt":"2026-08-09T12:00:00.000Z",
          "selectedModelId":"auto",
          "resolvedModelId":"claude-sonnet-4-6",
          "model":{"id":"auto","label":"Auto","resolvedLabel":"Claude Sonnet 4.6","contextWindow":200000,"auto":true},
          "context":{"usedTokens":24800,"percentage":12.4,"source":"provider_round","measuredAt":"2026-08-09T11:59:58.000Z","exact":true,"breakdown":[]}
        }
        """#.utf8)

        let snapshot = try JSONDecoder().decode(AgentUsageSnapshot.self, from: json)

        XCTAssertEqual(snapshot.usedPercentage, 12.4, accuracy: 0.001)
        XCTAssertEqual(snapshot.remainingPercentage, 88)
        XCTAssertEqual(snapshot.model.contextWindow, 200_000)
        XCTAssertEqual(AgentContextTokenFormat.compact(snapshot.context.usedTokens), "24.8K")
        XCTAssertEqual(AgentContextTokenFormat.compact(snapshot.model.contextWindow), "200K")
        XCTAssertTrue(snapshot.context.exact)
    }

    func testFreshAutoContextStartsAtZeroThenFollowsLiveRoutedModel() {
        let vm = AssistantVM()
        vm.modelId = nil
        vm.models = [
            AgentModelInfo(id: "claude-haiku-4-5", label: "Claude Haiku 4.5",
                           provider: "anthropic", enabled: true,
                           isDefault: false, contextWindow: 200_000),
            AgentModelInfo(id: "or-grok-4.20", label: "Grok 4.20 (OpenRouter)",
                           provider: "openrouter", enabled: true,
                           isDefault: false, contextWindow: 2_000_000),
        ]

        XCTAssertTrue(vm.contextRoutePending)
        XCTAssertEqual(vm.effectiveContextUsedTokens, 0)
        XCTAssertEqual(vm.effectiveContextPercentage, 0)
        XCTAssertNil(vm.effectiveContextWindow)

        vm.liveResolvedModelId = "or-grok-4.20"

        XCTAssertFalse(vm.contextRoutePending)
        XCTAssertEqual(vm.effectiveContextModel?.provider, "openrouter")
        XCTAssertEqual(vm.effectiveContextWindow, 2_000_000)
        XCTAssertEqual(vm.effectiveContextPercentage, 0)
    }

    func testModelInfoTransportKeepsCanonicalModelIdForAutoContext() throws {
        let data = Data(#"{"type":"model_info","modelId":"gemini-3.1-pro","label":"Gemini 3.1 Pro","displayName":"Gemini 3.1 Pro"}"#.utf8)
        let dto = try JSONDecoder().decode(AgentSSEEvent.self, from: data)

        guard case .modelInfo(let modelId, let label, let displayName) = AgentTurnEvent(dto: dto) else {
            return XCTFail("model_info must remain a typed native event")
        }
        XCTAssertEqual(modelId, "gemini-3.1-pro")
        XCTAssertEqual(label, "Gemini 3.1 Pro")
        XCTAssertEqual(displayName, "Gemini 3.1 Pro")
    }

    func testRecoveryIdentityIndexCoalescesDuplicateRowsWithoutCrashing() {
        let stale = AgentChatMessage(id: "local-recovery", role: .assistant, text: "stale")
        let settled = AgentChatMessage(id: "local-recovery", role: .assistant, text: "settled")

        let index = AssistantVM.identityIndex([stale, settled])

        XCTAssertEqual(index.count, 1)
        XCTAssertEqual(index["local-recovery"]?.text, "settled")
    }

    func testDeliveredSteerDoesNotBlockPairingPriorAnonymousOptimisticSend() throws {
        let vm = AssistantVM()
        vm.debugClearChronologyAnchors()
        let first = AgentChatMessage(
            id: "local-first", role: .user,
            clientMessageId: "client-first", outgoingState: .accepted,
            text: "FIRST")
        let steer = AgentChatMessage(
            id: "local-steer", role: .user,
            clientMessageId: "client-steer", outgoingState: .delivered,
            text: "SECOND")
        vm.messages = [first, steer]
        let wire = try JSONDecoder().decode([AgentMessageWire].self, from: Data(#"""
        [{"id":"server-first","clientMessageId":null,"role":"user","content":[{"type":"text","text":"FIRST"}]}]
        """#.utf8))

        vm.debugMergeServerMessages(wire)

        XCTAssertEqual(vm.messages.filter { $0.text == "FIRST" }.count, 1)
        XCTAssertEqual(vm.messages.first { $0.text == "FIRST" }?.id, "local-first",
                       "anonymous server truth should replace—not duplicate—the ordinary optimistic row")
        XCTAssertEqual(vm.messages.first { $0.text == "FIRST" }?.clientMessageId, "client-first")
        XCTAssertEqual(vm.messages.filter { $0.text == "SECOND" }.count, 1,
                       "the delivered steer remains a separate canonical owner row")
    }

    func testExactSteerAfterAnonymousInitialSendDoesNotMoveInitialBubbleToBottom() throws {
        let vm = AssistantVM()
        vm.debugClearChronologyAnchors()
        let initial = AgentChatMessage(
            id: "local-initial", role: .user,
            clientMessageId: "client-initial", outgoingState: .accepted,
            text: "এই draft-টি voice retry-এর পরও থাকবে")
        let steer = AgentChatMessage(
            id: "local-steer", role: .user,
            clientMessageId: "client-steer", outgoingState: .delivered,
            text: "Sales report")
        vm.messages = [initial, steer]
        let wire = try JSONDecoder().decode([AgentMessageWire].self, from: Data(#"""
        [
          {"id":"server-initial","clientMessageId":null,"role":"user","createdAt":"2026-08-05T02:20:00.000Z","content":[{"type":"text","text":"এই draft-টি voice retry-এর পরও থাকবে"}]},
          {"id":"server-answer","role":"assistant","createdAt":"2026-08-05T02:20:01.000Z","content":[{"type":"text","text":"উত্তর"}]},
          {"id":"server-steer","clientMessageId":"client-steer","role":"user","createdAt":"2026-08-05T02:20:02.000Z","content":[{"type":"text","text":"Sales report"}]}
        ]
        """#.utf8))

        vm.debugMergeServerMessages(wire)

        XCTAssertEqual(vm.messages.filter { $0.text.contains("draft-টি") }.count, 1,
                       "the anonymous server copy must replace—not duplicate—the initial local row")
        XCTAssertEqual(vm.messages.first?.id, "local-initial",
                       "the first owner bubble must retain its SwiftUI identity and original position")
        XCTAssertEqual(vm.messages.first?.serverId, "server-initial")
        XCTAssertEqual(vm.messages.map(\.text),
                       ["এই draft-টি voice retry-এর পরও থাকবে", "উত্তর", "Sales report"])
    }

    func testRunningTurnSendClearsComposerAndCreatesOneVisibleQueueEntry() {
        let vm = AssistantVM()
        vm.loadMergeReadinessQueueFixture()
        let instruction = "এই নির্দেশনাটি চলতি কাজে যোগ করো"
        vm.composerDraft = instruction

        vm.send(instruction)

        XCTAssertEqual(vm.composerDraft, "")
        XCTAssertEqual(vm.queuedOwnerMessages.count, 1)
        let clientMessageId = vm.queuedOwnerMessages[0].id
        XCTAssertEqual(vm.messages.filter { $0.clientMessageId == clientMessageId }.count, 1)
        XCTAssertEqual(
            vm.messages.first { $0.clientMessageId == clientMessageId }?.outgoingState,
            .queued)
        XCTAssertEqual(vm.messages.flatMap(\.blocks).filter {
            if case .ownerMessage(_, let id) = $0 { return id == clientMessageId }
            return false
        }.count, 1)
        XCTAssertFalse(vm.chronologicalMessages.contains {
            $0.role == .user && $0.clientMessageId == clientMessageId
        }, "anchored owner intent must not render again as a drifting top-level row")

        vm.debugReplaySteeringDelivery(clientMessageId)
        XCTAssertEqual(vm.messages.filter(\.isStreaming).count, 1,
                       "a queued canonical user row must not split the active assistant lane")
        XCTAssertEqual(vm.messages.flatMap(\.blocks).filter {
            if case .ownerMessage(_, let id) = $0 { return id == clientMessageId }
            return false
        }.count, 1, "delivery replay must keep one owner bubble globally")
        vm.cancelOutgoingMessage(vm.messages.first { $0.clientMessageId == clientMessageId }!)
    }

    func testMidTurnOwnerLaneStaysFixedThroughTwentyProgressEventsAndReload() {
        let clientMessageId = "chronology-\(UUID().uuidString)"
        let conversationId = "chronology-conversation"
        let assistantServerId = "chronology-assistant"
        let anchor = AssistantVM.TurnOwnerAnchor(
            clientMessageId: clientMessageId,
            conversationId: conversationId,
            turnId: "chronology-turn",
            assistantServerId: assistantServerId,
            beforeBlockCount: 1,
            createdAt: Date(timeIntervalSince1970: 1))

        var blocks: [AgentChatMessage.TurnBlock] = [
            .activity(.init(id: "before", kind: .progress,
                            label: "আগের ধাপ", live: false))
        ]
        blocks = AssistantVM.injectingOwnerAnchors([anchor], into: blocks)
        let fixedIndex = blocks.firstIndex {
            if case .ownerMessage(_, let id) = $0 { return id == clientMessageId }
            return false
        }
        for step in 1...20 {
            blocks = AgentChatMessage.appendProgressBlock(
                blocks, label: "ধাপ \(step)", messageId: assistantServerId)
        }
        XCTAssertEqual(blocks.firstIndex {
            if case .ownerMessage(_, let id) = $0 { return id == clientMessageId }
            return false
        }, fixedIndex)
        XCTAssertTrue(blocks.dropFirst((fixedIndex ?? -1) + 1).allSatisfy {
            if case .activity(let activity) = $0 { return activity.kind == .progress }
            return false
        })

        // Simulate a settled canonical fetch in a fresh VM: server rows contain
        // the durable owner message and one assistant row, while the local anchor
        // ledger re-injects the bubble into that assistant's event lane.
        var owner = AgentChatMessage(
            id: "server-owner", role: .user,
            clientMessageId: clientMessageId, outgoingState: .delivered,
            text: "এই নতুন নির্দেশটা এখনই ধরো")
        owner.serverId = "server-owner"
        var settled = AgentChatMessage(id: assistantServerId, role: .assistant, text: "শেষ")
        settled.serverId = assistantServerId
        settled.blocks = (0..<21).map { index in
            .activity(.init(id: "settled-\(index)", kind: .progress,
                            label: "ধাপ \(index)", live: false))
        }

        let relaunched = AssistantVM()
        relaunched.debugRestoreChronologyAnchors(
            [anchor], into: [owner, settled], conversationId: conversationId)
        XCTAssertFalse(relaunched.chronologicalMessages.contains {
            $0.role == .user && $0.clientMessageId == clientMessageId
        })
        let restoredAssistant = relaunched.chronologicalMessages.first { $0.role == .assistant }
        XCTAssertEqual(restoredAssistant?.blocks.firstIndex {
            if case .ownerMessage(_, let id) = $0 { return id == clientMessageId }
            return false
        }, 1)
        relaunched.debugClearChronologyAnchors()
    }

    func testOwnerAnchorUsesStableToolBoundaryWhenCanonicalBlockCountsShift() {
        let clientMessageId = "semantic-boundary-\(UUID().uuidString)"
        let toolId = "tool-before-steer"
        let liveTool = AgentChatMessage.ActivityBlock(
            id: "live-tool-row", kind: .tool, label: "Get Sales Summary",
            toolId: "live-\(toolId)", ok: true)
        let liveBlocks: [AgentChatMessage.TurnBlock] = [
            .prose(id: "live-preamble", text: "বস, রিপোর্ট দেখছি।"),
            .activity(liveTool),
        ]
        let anchor = AssistantVM.TurnOwnerAnchor(
            clientMessageId: clientMessageId,
            conversationId: "semantic-conversation",
            turnId: "semantic-turn",
            assistantServerId: "semantic-assistant",
            beforeBlockCount: 3,
            precedingBlockKeys: AssistantVM.ownerAnchorBoundaryKeys(in: liveBlocks),
            createdAt: Date(timeIntervalSince1970: 1))

        // Canonical projection dropped the live preamble and inserted a second
        // tool before final prose. Count-based restore would place the owner at
        // the bottom; the durable tool identity keeps the original read point.
        let canonical: [AgentChatMessage.TurnBlock] = [
            .activity(.init(id: "canonical-tool-one", kind: .tool,
                            label: "Get Sales Summary", toolId: toolId, ok: true)),
            .activity(.init(id: "canonical-tool-two", kind: .tool,
                            label: "Get Pending Approvals", toolId: "tool-after-steer", ok: true)),
            .prose(id: "canonical-final", text: "শেষ উত্তর"),
        ]

        let restored = AssistantVM.injectingOwnerAnchors([anchor], into: canonical)

        XCTAssertEqual(restored.firstIndex {
            if case .ownerMessage(_, let id) = $0 { return id == clientMessageId }
            return false
        }, 1)
        XCTAssertEqual(AssistantVM.ownerAnchorBoundaryKey(restored[0]), "tool:\(toolId)")
        XCTAssertEqual(AssistantVM.ownerAnchorBoundaryKey(restored[2]), "tool:tool-after-steer")
    }

    func testSemanticToolBoundaryKeepsFirstOccurrenceWhenLabelsRepeat() {
        let live: [AgentChatMessage.TurnBlock] = [
            .activity(.init(id: "live-one", kind: .tool, label: "Get Product",
                            toolId: "live-call-one", ok: true)),
        ]
        let anchor = AssistantVM.TurnOwnerAnchor(
            clientMessageId: "repeat-label-owner",
            conversationId: "repeat-label-conversation",
            turnId: "repeat-label-turn",
            assistantServerId: "repeat-label-assistant",
            beforeBlockCount: 1,
            precedingBlockKeys: AssistantVM.ownerAnchorBoundaryKeys(in: live),
            createdAt: Date(timeIntervalSince1970: 1))
        let canonical: [AgentChatMessage.TurnBlock] = [
            .activity(.init(id: "canonical-one", kind: .tool, label: "Get Product",
                            toolId: "canonical-call-one", ok: true)),
            .activity(.init(id: "canonical-two", kind: .tool, label: "Get Product",
                            toolId: "canonical-call-two", ok: true)),
        ]

        let restored = AssistantVM.injectingOwnerAnchors([anchor], into: canonical)

        XCTAssertEqual(restored.firstIndex {
            if case .ownerMessage(_, let id) = $0 { return id == anchor.clientMessageId }
            return false
        }, 1)
    }

    func testRepeatedSteeringDeliveryKeepsOneOwnerBubbleAtFirstReadPoint() {
        let clientMessageId = "steer-once-\(UUID().uuidString)"
        let anchor = AssistantVM.TurnOwnerAnchor(
            clientMessageId: clientMessageId,
            conversationId: "conversation",
            turnId: "turn",
            assistantServerId: nil,
            beforeBlockCount: 1,
            createdAt: Date(timeIntervalSince1970: 1))
        var first = AgentChatMessage(id: "stream-first", role: .assistant)
        first.isStreaming = true
        first.blocks = [
            .activity(.init(id: "first-step", kind: .search, label: "Find Tool"))
        ]
        var later = AgentChatMessage(id: "stream-later", role: .assistant)
        later.isStreaming = true
        later.blocks = [
            .activity(.init(id: "later-step", kind: .tool, label: "Get Audit Summary"))
        ]
        var rows = [first, later]

        AssistantVM.pinOwnerAnchorOnce(anchor, in: &rows, preferredAssistantIndex: 0)
        AssistantVM.pinOwnerAnchorOnce(anchor, in: &rows, preferredAssistantIndex: 1)

        let placements = rows.enumerated().flatMap { rowIndex, row in
            row.blocks.compactMap { block -> Int? in
                if case .ownerMessage(_, let id) = block, id == clientMessageId {
                    return rowIndex
                }
                return nil
            }
        }
        XCTAssertEqual(placements, [0])
        XCTAssertEqual(rows[0].blocks.firstIndex {
            if case .ownerMessage(_, let id) = $0 { return id == clientMessageId }
            return false
        }, 1)
    }

    func testProgressUpdateDecodesAsFactualProgressNotThinking() throws {
        let dto = try JSONDecoder().decode(
            AgentSSEEvent.self,
            from: Data(#"{"type":"progress_update","label":"Inventory যাচাই করছি"}"#.utf8))
        guard case .progressUpdate(let label) = AgentTurnEvent(dto: dto) else {
            return XCTFail("progress_update must have its own typed event")
        }
        XCTAssertEqual(label, "Inventory যাচাই করছি")
        let block = AgentChatMessage.appendProgressBlock(
            [], label: label, messageId: "progress-message").first
        guard case .activity(let activity)? = block else {
            return XCTFail("progress_update must render as an activity")
        }
        XCTAssertEqual(activity.kind, .progress)
        XCTAssertNotEqual(activity.kind, .thinking)
    }

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

    func testSelectionAndGeneratedImageReferenceRecoverWithDraft() {
        UserDefaults.standard.removeObject(forKey: "alma.assistant.selectedSessionIdentity.v2")
        UserDefaults.standard.removeObject(forKey: "alma.assistant.composerDrafts.v2")
        let reference = AgentFileRef(
            bucket: "agent-files", path: "generated/campaign.jpg", mediaType: "image/jpeg")

        let first = AssistantVM()
        first.composerDraft = "এই অংশ নিয়ে explain করো"
        first.composerSelectionReference = "selected source sentence"
        first.referencedFileRefs = [reference]

        let relaunched = AssistantVM()
        relaunched.debugRestoreComposerDraft()
        XCTAssertEqual(relaunched.composerDraft, first.composerDraft)
        XCTAssertEqual(relaunched.composerSelectionReference, "selected source sentence")
        XCTAssertEqual(relaunched.referencedFileRefs, [reference])
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

    func testStaleDurableDictationDoesNotClutterComposerForever() {
        let vm = AssistantVM()
        vm.loadDictationRecoveryFixture()
        vm.debugSetDurableDictationModifiedAt(Date(timeIntervalSinceNow: -(25 * 60 * 60)))
        vm.debugRestoreDurableDictationRecovery()
        XCTAssertFalse(vm.canRetryDictation)
        XCTAssertNil(vm.dictationFailure)
    }

    func testLunaIdentitySurvivesCompactModelLabel() {
        XCTAssertEqual(AgentModelShortName.display("GPT-5.6 Luna"), "GPT 5.6 Luna")
        XCTAssertEqual(AgentModelShortName.display("GPT-5.5"), "GPT 5.5")
    }

    func testBackgroundTaskLabelDoesNotCallApprovalsRunningTasks() {
        XCTAssertEqual(AgentBackgroundTaskLabel.make(running: 1, attention: 1), "1 Running · 1 Approval")
        XCTAssertEqual(AgentBackgroundTaskLabel.make(running: 0, attention: 1), "1 Approval Waiting")
        XCTAssertEqual(AgentBackgroundTaskLabel.make(running: 2, attention: 0), "2 Running Tasks")
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
        XCTAssertEqual(message.blocks.map(\.id), ["m1:b1", "m1:b2"])
        XCTAssertTrue(message.supersededBlockIds.isEmpty)
        XCTAssertEqual(message.blocks.compactMap { block -> String? in
            if case .prose(_, let text) = block { return text }
            return nil
        }, ["final"])
        XCTAssertEqual(message.tools.first?.id, "m1:b1")
        XCTAssertEqual(message.tokensIn, 10)
        XCTAssertEqual(message.apiRounds, 2)
        XCTAssertTrue(message.selfCorrected)
    }

    func testClaudeChatFixtureCarriesConversationFirstAgentSequence() {
        let vm = AssistantVM()
        vm.loadClaudeChatFixture()

        XCTAssertEqual(vm.conversationId, "fixture-claude-chat")
        XCTAssertEqual(vm.permissionMode, .standard)
        XCTAssertEqual(vm.messages.count, 2)
        guard let answer = vm.messages.last else {
            return XCTFail("fixture must include an assistant answer")
        }
        XCTAssertEqual(answer.thinkingMs, 12_400)
        XCTAssertEqual(answer.tools.count, 6)
        XCTAssertEqual(answer.blocks.compactMap { block -> String? in
            if case .prose(_, let text) = block { return text }
            return nil
        }.count, 3)
        XCTAssertEqual(answer.blocks.compactMap { block -> String? in
            if case .activity(let activity) = block, activity.kind == .thinking {
                return activity.id
            }
            return nil
        }, ["claude-thought-1", "claude-thought-2"])
        guard case .file(_, let artifactId, let name) = answer.blocks.last else {
            return XCTFail("fixture must finish with the action-plan file")
        }
        XCTAssertEqual(artifactId, "claude-action-plan")
        XCTAssertEqual(name, "৩০ দিনের Sales Recovery Plan.md")
        XCTAssertEqual(AgentCompactActivityRow.friendlyLabel("get_sales_overview"),
                       "বিক্রির সারাংশ")
    }

    #if DEBUG
    func testInteractiveClaudePreviewUsesRealCatalogAndChronologicalSSEContract() {
        let models = AlmaMergeReadinessURLProtocol.interactivePreviewModels
        let ids = Set(models.map(\.id))
        XCTAssertEqual(models.count, 17)
        XCTAssertTrue(ids.contains("claude-sonnet-4-6"))
        XCTAssertTrue(ids.contains("gemini-3.1-pro"))
        XCTAssertTrue(ids.contains("gpt-5.6-luna"))
        XCTAssertTrue(ids.contains("or-qwen3-max"))
        XCTAssertTrue(ids.contains("or-deepseek-v4-flash"))
        XCTAssertTrue(ids.contains("xai-grok-4.20"))
        XCTAssertFalse(ids.contains("or-glm-4-32b"), "worker-only models must stay out of the picker")
        XCTAssertEqual(AgentModelShortName.display("Qwen 3.7 Max (OpenRouter)"), "Qwen 3.7")
        XCTAssertEqual(AgentModelShortName.display("Qwen3.5 Coder (OpenRouter)"), "Qwen3.5")

        let frames = AlmaMergeReadinessURLProtocol.interactivePreviewFrames(
            modelId: "claude-sonnet-4-6", prompt: "show me a recovery plan", turn: 7)
        let types = frames.map(\.type)
        XCTAssertEqual(Array(types.prefix(3)), ["conversation_id", "turn_id", "model_info"])
        XCTAssertEqual(types.last, "done")
        XCTAssertTrue(types.contains("thinking_delta"))
        XCTAssertTrue(types.contains("text_delta"))
        XCTAssertGreaterThanOrEqual(types.filter { $0 == "tool_start" }.count, 4)
        XCTAssertEqual(types.filter { $0 == "tool_start" }.count,
                       types.filter { $0 == "tool_end" }.count)
        XCTAssertTrue(types.contains("artifact_saved"))
        XCTAssertEqual(frames.map(\.delayMilliseconds), frames.map(\.delayMilliseconds).sorted())

        let modelInfo = frames.first(where: { $0.type == "model_info" })?.event
        XCTAssertEqual(modelInfo?["displayName"] as? String, "Claude Sonnet 4.6")
        let renderedText = frames.filter { $0.type == "text_delta" }
            .compactMap { $0.event["delta"] as? String }.joined()
        XCTAssertTrue(renderedText.contains("show me a recovery plan"))
        XCTAssertTrue(renderedText.contains("local deterministic response"))
    }
    #endif

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

    func testCancelAndEditRetirePersistedActionContinuations() {
        let cancelKey = "ask:test-cancel-\(UUID().uuidString)"
        let cancelVM = AssistantVM()
        let cancelId = cancelVM.debugStableActionContinuationId(
            key: cancelKey, text: "cancel me", askCardId: "ask-cancel")
        let cancelMessage = AgentChatMessage(
            id: "local-\(cancelId)", role: .user, clientMessageId: cancelId,
            outgoingState: .failed, text: "cancel me")
        cancelVM.cancelOutgoingMessage(cancelMessage)
        XCTAssertFalse(AssistantVM().debugHasActionContinuation(key: cancelKey))

        let editKey = "opinion:test-edit-\(UUID().uuidString)"
        let editVM = AssistantVM()
        let editId = editVM.debugStableActionContinuationId(
            key: editKey, text: "edit me", askCardId: nil)
        let editMessage = AgentChatMessage(
            id: "local-\(editId)", role: .user, clientMessageId: editId,
            outgoingState: .failed, text: "edit me")
        editVM.editOutgoingMessage(editMessage)
        XCTAssertFalse(AssistantVM().debugHasActionContinuation(key: editKey))
    }

    func testMarkdownTableParserRemovesDelimiterAndKeepsSemanticCells() {
        let source = """
        | API | Cost | Best for |
        | :--- | ---: | --- |
        | **Deepgram** | ~$0.005/min | STT |
        | Google | ~$0.000004/char | TTS |
        """
        let table = AgentMarkdownText.parseTable(source)
        XCTAssertEqual(table?.header, ["API", "Cost", "Best for"])
        XCTAssertEqual(table?.rows.count, 2)
        XCTAssertEqual(table?.rows.first, ["**Deepgram**", "~$0.005/min", "STT"])
        XCTAssertFalse(table?.rows.flatMap { $0 }.contains("---") ?? true)
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

    func testLiveAudioGateWaitsWhenSocketWinsCallKitRace() {
        var gate = AlmaLiveAudioReadiness(callKitManaged: true)
        gate.socketSetupComplete = true
        gate.audioConfigured = true

        XCTAssertTrue(gate.waitingForCallKit)
        XCTAssertFalse(gate.canPublishLive,
                       "a configured graph is not audible proof before CallKit activates it")

        gate.callKitAudioActive = true
        XCTAssertFalse(gate.waitingForCallKit)
        XCTAssertTrue(gate.canPublishLive)
    }

    func testLiveAudioGateHandlesCallKitActivationBeforeSocketSetup() {
        var gate = AlmaLiveAudioReadiness(callKitManaged: true)
        gate.callKitAudioActive = true
        XCTAssertFalse(gate.canPublishLive)

        gate.socketSetupComplete = true
        XCTAssertFalse(gate.canPublishLive)

        gate.audioConfigured = true
        XCTAssertTrue(gate.canPublishLive)
        gate.setupPublished = true
        XCTAssertFalse(gate.canPublishLive, "one socket generation publishes LIVE exactly once")
    }

    func testLiveAudioGateDeactivationAndReconnectRequireFreshSignals() {
        var gate = AlmaLiveAudioReadiness(
            socketSetupComplete: true,
            callKitManaged: true,
            callKitAudioActive: true,
            audioConfigured: true)
        XCTAssertTrue(gate.canPublishLive)

        gate.setupPublished = true
        gate.callKitAudioActive = false
        XCTAssertTrue(gate.waitingForCallKit)
        XCTAssertFalse(gate.canPublishLive)

        gate.callKitAudioActive = true
        gate.beginSocketAttempt()
        XCTAssertFalse(gate.canPublishLive)
        gate.socketSetupComplete = true
        XCTAssertTrue(gate.canPublishLive,
                      "a resumed socket may publish only after its own setupComplete")
    }

    func testLiveAudioGateRejectsLateSetupAndCallKitWorkFromReplacedSocket() {
        let oldSocket = NSObject()
        let newSocket = NSObject()
        let oldAttempt = AlmaLiveVoiceSocketAttempt(
            ordinal: 1,
            socketIdentity: ObjectIdentifier(oldSocket),
            evidenceGeneration: 0)
        let newAttempt = AlmaLiveVoiceSocketAttempt(
            ordinal: 2,
            socketIdentity: ObjectIdentifier(newSocket),
            evidenceGeneration: 0)
        var gate = AlmaLiveAudioReadiness(
            callKitManaged: true,
            callKitAudioActive: false,
            audioConfigured: true)

        gate.bindSocketAttempt(oldAttempt)
        XCTAssertEqual(gate.setupAcceptance(for: oldAttempt), false)
        XCTAssertTrue(gate.acceptSocketSetup(oldAttempt))
        XCTAssertEqual(gate.setupAcceptance(for: oldAttempt), true)
        XCTAssertTrue(gate.deferSetupForCallKit(oldAttempt))
        XCTAssertEqual(gate.pendingCallKitAttempt, oldAttempt)
        gate.callKitAudioActive = true
        XCTAssertTrue(gate.canPublishLive)
        gate.callKitAudioActive = false
        XCTAssertFalse(gate.claimPublish(oldAttempt),
                       "CallKit deactivation between preflight and publish must win")

        gate.bindSocketAttempt(newAttempt)
        XCTAssertNil(gate.setupAcceptance(for: oldAttempt),
                     "an invalidated setup frame is stale, not a current failed setup")
        XCTAssertEqual(gate.setupAcceptance(for: newAttempt), false)
        XCTAssertNil(gate.pendingCallKitAttempt)
        XCTAssertFalse(gate.acceptSocketSetup(oldAttempt))
        XCTAssertFalse(gate.deferSetupForCallKit(oldAttempt))
        XCTAssertFalse(gate.claimPublish(oldAttempt))

        gate.callKitAudioActive = true
        XCTAssertTrue(gate.acceptSocketSetup(newAttempt))
        XCTAssertEqual(gate.setupAcceptance(for: newAttempt), true)
        XCTAssertTrue(gate.claimPublish(newAttempt))
        XCTAssertFalse(gate.claimPublish(newAttempt),
                       "one exact physical socket attempt may publish only once")
    }

    func testLiveVoiceEvidenceRolloutGateHasDeterministicRollbackPrecedence() throws {
        let suite = "alma-live-voice-evidence-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertTrue(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .evidenceV1, environment: [:], defaults: defaults))
        AlmaLiveVoiceRecoveryFeatures.set(false, for: .evidenceV1, defaults: defaults)
        XCTAssertFalse(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .evidenceV1, environment: [:], defaults: defaults))
        XCTAssertTrue(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .evidenceV1,
            environment: ["ALMA_LIVE_VOICE_EVIDENCE_V1": "1"],
            defaults: defaults))
        XCTAssertFalse(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .evidenceV1,
            environment: ["ALMA_LIVE_VOICE_EVIDENCE_V1": "off"],
            defaults: defaults))
    }

    func testLiveVoiceEvidenceInputStagesSeparateRawConversionPolicyAndSessionFence() {
        var state = AlmaLiveVoiceEvidenceInputStageState()
        state.reset(localSessionID: "voice-test-0001", transportGeneration: 7)
        let firstWindow = state.snapshot().windowID

        XCTAssertFalse(state.claimRaw(windowID: firstWindow, hasEnergy: false))
        XCTAssertFalse(state.claimConversionSucceeded(
            windowID: firstWindow,
            hasEnergy: true,
            byteCount: 640), "conversion cannot precede raw energy")
        XCTAssertFalse(state.claimConversionFailure(windowID: firstWindow),
                       "conversion failure cannot claim a silent/raw-unobserved window")
        XCTAssertFalse(state.chainReady(firstWindow))

        XCTAssertTrue(state.claimRaw(windowID: firstWindow, hasEnergy: true))
        XCTAssertFalse(state.claimPolicyWithheld(
            .listenCalibration,
            windowID: firstWindow), "policy requires successful conversion")
        XCTAssertTrue(state.claimConversionFailure(windowID: firstWindow))
        XCTAssertTrue(state.claimConversionSucceeded(
            windowID: firstWindow,
            hasEnergy: true,
            byteCount: 640), "a failure must not block a later valid conversion")
        XCTAssertTrue(state.chainReady(firstWindow))
        XCTAssertTrue(state.claimPolicyWithheld(.listenCalibration, windowID: firstWindow))
        XCTAssertFalse(state.claimPolicyWithheld(.listenCalibration, windowID: firstWindow))
        XCTAssertTrue(state.claimPolicyWithheld(.listenGateClosed, windowID: firstWindow))
        XCTAssertFalse(state.claimRaw(windowID: firstWindow, hasEnergy: true))

        state.markIntakeComplete(firstWindow)
        XCTAssertTrue(state.intakeComplete)
        state.markIntakeNeedsRetry(firstWindow)
        XCTAssertFalse(state.intakeComplete)
        XCTAssertFalse(state.claimPolicyWithheld(.listenGateClosed, windowID: firstWindow),
                       "retry does not duplicate completed source/policy stages")

        XCTAssertFalse(state.rearm(transportGeneration: 6))
        XCTAssertTrue(state.chainReady(firstWindow),
                      "a stale model boundary cannot rearm the current transport")
        XCTAssertTrue(state.rearm(transportGeneration: 7))
        let secondWindow = state.snapshot().windowID
        XCTAssertNotEqual(secondWindow, firstWindow)
        XCTAssertFalse(state.chainReady(secondWindow))
        XCTAssertFalse(state.claimRaw(windowID: firstWindow, hasEnergy: true))
        XCTAssertFalse(state.claimRaw(
            windowID: .init(
                localSessionID: "voice-debug-no-network",
                transportGeneration: 7,
                windowOrdinal: secondWindow.windowOrdinal),
            hasEnergy: true), "session identity is part of every capture claim")
        XCTAssertFalse(state.claimConversionFailure(windowID: secondWindow))
        XCTAssertTrue(state.claimRaw(windowID: secondWindow, hasEnergy: true))
        XCTAssertTrue(state.claimConversionFailure(windowID: secondWindow))
        XCTAssertFalse(state.claimConversionFailure(windowID: secondWindow))
        XCTAssertTrue(state.claimConversionSucceeded(
            windowID: secondWindow,
            hasEnergy: true,
            byteCount: 640))
        state.deactivate()
        XCTAssertFalse(state.claimPolicyWithheld(.listenGateClosed, windowID: secondWindow))
    }

    func testLiveVoiceStartAttemptRejectsDeferredWorkAcrossStopAndReplacement() {
        var state = AlmaLiveVoiceStartAttemptState()
        let first = state.reserve()

        state.invalidate()
        XCTAssertFalse(state.activate(first),
                       "a queued start cannot activate after terminal stop")
        XCTAssertNil(state.activeToken)

        let second = state.reserve()
        XCTAssertNotEqual(second, first)
        XCTAssertTrue(state.activate(second))
        XCTAssertTrue(state.acceptsActive(second))
        XCTAssertFalse(state.acceptsActive(first))
        XCTAssertFalse(state.activate(second),
                       "one reserved attempt may activate only once")

        state.invalidate()
        XCTAssertFalse(state.acceptsActive(second),
                       "a published attempt is rejected immediately at stop")
        let third = state.reserve()
        XCTAssertNotEqual(third, second)
        XCTAssertFalse(state.acceptsActive(third),
                       "reservation alone cannot publish a socket")
        XCTAssertTrue(state.activate(third))
    }

    func testLiveVoiceEvidenceDistinguishesPolicyNotQueuedAndRealSendFailure() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)
        let generation = recorder.beginTransportAttempt(resuming: false)
        let firstWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: recorder.sessionID,
            transportGeneration: generation,
            windowOrdinal: 1)
        XCTAssertTrue(recorder.activateInputWindow(firstWindow, generation: generation))

        recorder.recordInputWithheldByPolicy(
            .listenCalibration,
            generation: generation,
            inputWindowID: firstWindow)
        recorder.recordRawEnergy(
            rms: 0.006,
            generation: generation,
            inputWindowID: firstWindow,
            observedUptime: ProcessInfo.processInfo.systemUptime + 0.01)
        recorder.recordConversionSucceeded(
            byteCount: 640,
            generation: generation,
            inputWindowID: firstWindow,
            observedUptime: ProcessInfo.processInfo.systemUptime + 0.02)
        recorder.recordInputWithheldByPolicy(
            .listenCalibration,
            generation: generation,
            inputWindowID: firstWindow)
        recorder.recordInputWithheldByPolicy(
            .listenCalibration,
            generation: generation,
            inputWindowID: firstWindow)
        recorder.recordInputWithheldByPolicy(
            .listenGateClosed,
            generation: generation,
            inputWindowID: firstWindow)
        recorder.recordInputWithheldByPolicy(
            .playbackTailSuppression,
            generation: generation,
            inputWindowID: firstWindow)
        recorder.recordAudioNotQueued(
            .socketNotReady,
            byteCount: 0,
            generation: generation,
            inputWindowID: firstWindow)
        recorder.recordAudioNotQueued(
            .socketUnavailable,
            byteCount: 640,
            generation: generation,
            inputWindowID: firstWindow)
        let successful = try XCTUnwrap(recorder.recordAudioQueued(
            byteCount: 640,
            generation: generation,
            inputWindowID: firstWindow))
        recorder.recordAudioSendCompletion(
            successful,
            succeeded: true,
            currentGeneration: generation,
            isCurrentReadySocket: true)
        recorder.recordAudioSendCompletion(
            successful,
            succeeded: false,
            currentGeneration: generation,
            isCurrentReadySocket: true)

        let secondWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: recorder.sessionID,
            transportGeneration: generation,
            windowOrdinal: 2)
        let skippedWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: recorder.sessionID,
            transportGeneration: generation,
            windowOrdinal: 3)
        recorder.recordProviderModelAudioObserved(
            generation: generation,
            playbackGeneration: 1,
            nextInputWindowID: skippedWindow)
        recorder.recordProviderModelAudioObserved(
            generation: generation,
            playbackGeneration: 1,
            nextInputWindowID: secondWindow)
        recorder.recordRawEnergy(
            rms: 0.01,
            generation: generation,
            inputWindowID: secondWindow)
        recorder.recordConversionFailed(
            .conversionError,
            generation: generation,
            inputWindowID: secondWindow)
        recorder.recordConversionFailed(
            .conversionError,
            generation: generation,
            inputWindowID: secondWindow)
        recorder.recordConversionSucceeded(
            byteCount: 640,
            generation: generation,
            inputWindowID: secondWindow)
        recorder.recordInputWithheldByPolicy(
            .noAECEchoGuard,
            generation: generation,
            inputWindowID: secondWindow)
        let failed = try XCTUnwrap(recorder.recordAudioQueued(
            byteCount: 640,
            generation: generation,
            inputWindowID: secondWindow))
        recorder.recordAudioSendCompletion(
            failed,
            succeeded: false,
            currentGeneration: generation,
            isCurrentReadySocket: true)
        recorder.recordAudioSendCompletion(
            failed,
            succeeded: true,
            currentGeneration: generation,
            isCurrentReadySocket: true)

        let events = recorder.report().events
        XCTAssertEqual(events.filter { $0.name == .audioWithheldByPolicy }.map(\.reason),
                       [.listenCalibration, .listenGateClosed, .playbackTailSuppression,
                        .noAECEchoGuard])
        XCTAssertEqual(events.filter { $0.name == .audioWithheldByPolicy }.map(\.retention),
                       [.boundedPreRoll, .boundedPreRoll, .discarded, .boundedPreRoll])
        XCTAssertEqual(events.filter { $0.name == .audioNotQueued }.count, 1)
        XCTAssertEqual(events.filter { $0.name == .audioSendFailed }.count, 1)
        XCTAssertEqual(events.filter { $0.name == .conversionFailed }.count, 1,
                       "conversion failures dedupe per input window, not generation")
        XCTAssertEqual(
            Set(events.filter { $0.inputWindowOrdinal == 1 }.compactMap(\.turnOrdinal)),
            Set([1]))
        XCTAssertEqual(
            Set(events.filter { $0.inputWindowOrdinal == 2 }.compactMap(\.turnOrdinal)),
            Set([2]))
        let failedIndex = try XCTUnwrap(events.firstIndex { $0.name == .audioSendFailed })
        let queuedIndex = try XCTUnwrap(events.firstIndex {
            $0.name == .audioFirstQueued && $0.inputWindowOrdinal == 2
        })
        XCTAssertLessThan(queuedIndex, failedIndex,
                          "a real send failure must follow its exact queued claim")
        XCTAssertEqual(recorder.report().schemaVersion, 2)
    }

    func testLiveVoiceEvidenceInputWindowRejectsOldFutureAndReusedSessionClaims() {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)
        let firstGeneration = recorder.beginTransportAttempt(resuming: false)
        let oldWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: recorder.sessionID,
            transportGeneration: firstGeneration,
            windowOrdinal: 1)
        XCTAssertTrue(recorder.activateInputWindow(oldWindow, generation: firstGeneration))
        recorder.recordRawEnergy(
            rms: 0.01,
            generation: firstGeneration,
            inputWindowID: oldWindow)
        recorder.endSession(.ownerEnded)

        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)
        let currentGeneration = recorder.beginTransportAttempt(resuming: false)
        XCTAssertGreaterThan(currentGeneration, firstGeneration)
        let currentWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: recorder.sessionID,
            transportGeneration: currentGeneration,
            windowOrdinal: 1)
        let futureWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: recorder.sessionID,
            transportGeneration: currentGeneration,
            windowOrdinal: 2)
        XCTAssertTrue(recorder.activateInputWindow(currentWindow, generation: currentGeneration))
        XCTAssertFalse(recorder.activateInputWindow(currentWindow, generation: currentGeneration),
                       "only the recorder's initial activation path may install window 1")
        XCTAssertFalse(recorder.activateInputWindow(futureWindow, generation: currentGeneration),
                       "callers cannot advance the recorder window directly")

        recorder.recordRawEnergy(
            rms: 0.02,
            generation: firstGeneration,
            inputWindowID: oldWindow)
        recorder.recordRawEnergy(
            rms: 0.03,
            generation: currentGeneration,
            inputWindowID: futureWindow)
        recorder.recordRawEnergy(
            rms: 0.04,
            generation: currentGeneration,
            inputWindowID: currentWindow)

        let raw = recorder.report().events.filter { $0.name == .rawFirstEnergy }
        XCTAssertEqual(raw.count, 1)
        XCTAssertEqual(raw.first?.inputWindowOrdinal, currentWindow.windowOrdinal)
        XCTAssertNil(raw.first?.turnOrdinal,
                     "raw energy is a prospective local window, not proof of owner speech")
    }

    func testLiveVoiceEvidenceAcceptsOutstandingPriorWindowCompletionAfterRearm() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)
        let generation = recorder.beginTransportAttempt(resuming: false)
        let firstWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: recorder.sessionID,
            transportGeneration: generation,
            windowOrdinal: 1)
        XCTAssertTrue(recorder.activateInputWindow(firstWindow, generation: generation))
        recorder.recordRawEnergy(
            rms: 0.01,
            generation: generation,
            inputWindowID: firstWindow)
        recorder.recordConversionSucceeded(
            byteCount: 640,
            generation: generation,
            inputWindowID: firstWindow)
        let outstanding = try XCTUnwrap(recorder.recordAudioQueued(
            byteCount: 640,
            generation: generation,
            inputWindowID: firstWindow))

        let secondWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: recorder.sessionID,
            transportGeneration: generation,
            windowOrdinal: 2)
        recorder.recordProviderModelAudioObserved(
            generation: generation,
            playbackGeneration: 1,
            nextInputWindowID: secondWindow)
        recorder.recordAudioSendCompletion(
            outstanding,
            succeeded: true,
            currentGeneration: generation,
            isCurrentReadySocket: true)
        recorder.recordAudioSendCompletion(
            outstanding,
            succeeded: false,
            currentGeneration: generation,
            isCurrentReadySocket: true)

        let completions = recorder.report().events.filter {
            $0.name == .audioFirstSendSucceeded || $0.name == .audioSendFailed
        }
        XCTAssertEqual(completions.count, 1)
        XCTAssertEqual(completions.first?.name, .audioFirstSendSucceeded)
        XCTAssertEqual(completions.first?.inputWindowOrdinal, 1)
    }

    func testLiveVoiceCapturedInputPCMKeepsDeliveryTokenOnItsExactBytes() {
        let firstWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: "voice-test-0001",
            transportGeneration: 9,
            windowOrdinal: 1)
        let secondWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: "voice-test-0001",
            transportGeneration: 9,
            windowOrdinal: 2)
        let chunks = [
            AlmaLiveVoiceCapturedInputPCM(data: Data([0x00]), deliveryToken: nil),
            AlmaLiveVoiceCapturedInputPCM(
                data: Data([0x11]),
                deliveryToken: .init(windowID: firstWindow)),
            AlmaLiveVoiceCapturedInputPCM(
                data: Data([0x22]),
                deliveryToken: .init(windowID: secondWindow)),
        ]

        XCTAssertNil(chunks[0].deliveryToken)
        XCTAssertEqual(chunks[1].data, Data([0x11]))
        XCTAssertEqual(chunks[1].deliveryToken?.windowID, firstWindow)
        XCTAssertEqual(chunks[2].data, Data([0x22]))
        XCTAssertEqual(chunks[2].deliveryToken?.windowID, secondWindow)
        XCTAssertNotEqual(chunks[1].deliveryToken, chunks[2].deliveryToken)

        let sameWindowPreRoll = [
            AlmaLiveVoiceCapturedInputPCM(data: Data([0x00]), deliveryToken: nil),
            AlmaLiveVoiceCapturedInputPCM(
                data: Data([0x31]),
                deliveryToken: .init(windowID: firstWindow)),
            AlmaLiveVoiceCapturedInputPCM(
                data: Data([0x32]),
                deliveryToken: .init(windowID: firstWindow)),
        ]
        let tracked = AlmaLiveVoiceCapturedInputPCM.trackedEvidenceIndex(in: sameWindowPreRoll)
        XCTAssertEqual(tracked, 2,
                       "only the latest exact energy-bearing pre-roll chunk is tracked")
        XCTAssertEqual(sameWindowPreRoll[tracked!].data, Data([0x32]))
        XCTAssertEqual(sameWindowPreRoll.indices.filter {
            $0 == tracked && sameWindowPreRoll[$0].deliveryToken != nil
        }.count, 1)

        let preparedTokens = sameWindowPreRoll.enumerated().map { index, chunk in
            AlmaLiveVoiceCapturedInputPCM.deliveryTokenForSending(
                chunk,
                at: index,
                trackedIndex: tracked)
        }
        XCTAssertEqual(sameWindowPreRoll.map(\.data), [Data([0x00]), Data([0x31]), Data([0x32])],
                       "pre-roll PCM bytes and FIFO order must not change")
        XCTAssertEqual(preparedTokens, [nil, nil, sameWindowPreRoll[2].deliveryToken],
                       "only the selected exact chunk may carry evidence into the send path")
    }

    func testLiveVoiceAudioSendValidationSeparatesReadinessFromAttemptMismatch() {
        let currentSocket = NSObject()
        let staleSocket = NSObject()
        let current = AlmaLiveVoiceSocketAttempt(
            ordinal: 1,
            socketIdentity: ObjectIdentifier(currentSocket),
            evidenceGeneration: 7)
        let stale = AlmaLiveVoiceSocketAttempt(
            ordinal: 0,
            socketIdentity: ObjectIdentifier(staleSocket),
            evidenceGeneration: 6)

        XCTAssertEqual(AlmaLiveVoiceAudioSendValidation.notQueuedReason(
            socketIdentity: ObjectIdentifier(currentSocket),
            currentAttempt: current,
            socketReady: false,
            requireReady: true,
            sourceAttempt: current), .socketNotReady)
        XCTAssertEqual(AlmaLiveVoiceAudioSendValidation.notQueuedReason(
            socketIdentity: ObjectIdentifier(currentSocket),
            currentAttempt: current,
            socketReady: true,
            requireReady: true,
            sourceAttempt: stale), .sourceAttemptMismatch)
        XCTAssertEqual(AlmaLiveVoiceAudioSendValidation.notQueuedReason(
            socketIdentity: ObjectIdentifier(staleSocket),
            currentAttempt: current,
            socketReady: true,
            requireReady: true,
            sourceAttempt: stale), .sourceAttemptMismatch)
        XCTAssertNil(AlmaLiveVoiceAudioSendValidation.notQueuedReason(
            socketIdentity: ObjectIdentifier(currentSocket),
            currentAttempt: current,
            socketReady: false,
            requireReady: false,
            sourceAttempt: current))
    }

    func testLiveVoiceEvidenceRecordsTypedLifecycleAndTransportRecoveryEvents() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .callKit,
            fixture: .unitTest)

        let observedUptime = ProcessInfo.processInfo.systemUptime
        recorder.recordLifecycleEvent(
            .appBackgrounded,
            observedUptime: observedUptime + 1.0)
        recorder.recordLifecycleEvent(
            .appWillEnterForeground,
            observedUptime: observedUptime + 1.25)
        recorder.recordLifecycleEvent(.appBecameActive)
        recorder.recordLifecycleEvent(.audioInterruptionBegan)
        recorder.recordLifecycleEvent(.audioInterruptionEnded)
        recorder.recordLifecycleEvent(.mediaServicesReset)
        recorder.recordLifecycleEvent(.callKitAudioActivated)
        recorder.recordLifecycleEvent(.callKitAudioDeactivated)
        recorder.recordLifecycleEvent(.fullRestartScheduled)

        let firstGeneration = recorder.beginTransportAttempt(resuming: false)
        recorder.recordTransportEvent(.socketReceiveFailed, generation: firstGeneration)
        recorder.recordTransportEvent(.socketReceiveFailed, generation: firstGeneration)
        recorder.recordTransportEvent(.socketPingFailed, generation: firstGeneration)
        recorder.recordTransportEvent(.providerErrorObserved, generation: firstGeneration)
        recorder.recordTransportEvent(.goAwayObserved, generation: firstGeneration)
        recorder.recordTransportEvent(
            .resumptionHandleObserved,
            generation: firstGeneration)
        recorder.recordTransportEvent(.reconnectScheduled, generation: firstGeneration)
        recorder.recordTransportEvent(.socketClosed, generation: firstGeneration)

        let resumedGeneration = recorder.beginTransportAttempt(resuming: true)
        recorder.recordTransportEvent(.resumptionAccepted, generation: firstGeneration)
        recorder.recordTransportEvent(.resumptionAccepted, generation: resumedGeneration)
        recorder.recordTransportEvent(.resumptionUnavailable, generation: resumedGeneration)
        recorder.endSession(.ownerEnded)

        let report = recorder.report()
        XCTAssertEqual(report.events.map(\.name), [
            .sessionStarted,
            .appBackgrounded,
            .appWillEnterForeground,
            .appBecameActive,
            .audioInterruptionBegan,
            .audioInterruptionEnded,
            .mediaServicesReset,
            .callKitAudioActivated,
            .callKitAudioDeactivated,
            .fullRestartScheduled,
            .transportStarted,
            .socketError,
            .socketError,
            .providerErrorObserved,
            .goAwayObserved,
            .resumptionHandleObserved,
            .reconnectScheduled,
            .socketClosed,
            .transportStarted,
            .resumptionAccepted,
            .resumptionUnavailable,
            .sessionEnded,
        ])
        XCTAssertEqual(
            report.events.filter { $0.name == .socketError }.count,
            2,
            "distinct receive and ping failures remain separately attributable")
        XCTAssertEqual(
            report.events.filter { $0.name == .socketError }.map(\.reason),
            [.socketReceiveFailed, .socketPingFailed])
        XCTAssertEqual(
            report.events.first(where: { $0.name == .resumptionAccepted })?
                .transportGeneration,
            resumedGeneration,
            "a stale transport cannot append lifecycle evidence to its replacement")
        XCTAssertEqual(
            report.events.first(where: { $0.name == .transportStarted
                && $0.transportGeneration == resumedGeneration })?.resumedTransport,
            true)
        let background = try XCTUnwrap(
            report.events.first(where: { $0.name == .appBackgrounded }))
        let entering = try XCTUnwrap(
            report.events.first(where: { $0.name == .appWillEnterForeground }))
        XCTAssertEqual(
            entering.elapsedMilliseconds - background.elapsedMilliseconds,
            250,
            accuracy: 1,
            "async evidence recording must retain callback-observation time")
    }

    func testLiveVoiceProviderControlEvidenceClassifiesFactualBoundaries() {
        XCTAssertEqual(
            AlmaLiveVoiceProviderControlEvidence.providerErrorEvents(
                recoveryAttempt: false,
                resumptionRequested: false,
                setupAccepted: false),
            [.providerErrorObserved])
        XCTAssertEqual(
            AlmaLiveVoiceProviderControlEvidence.providerErrorEvents(
                recoveryAttempt: true,
                resumptionRequested: false,
                setupAccepted: false),
            [.providerErrorObserved, .reconnectSetupFailed],
            "a fresh reconnect failure must not claim a resumption failure")
        XCTAssertEqual(
            AlmaLiveVoiceProviderControlEvidence.providerErrorEvents(
                recoveryAttempt: true,
                resumptionRequested: true,
                setupAccepted: false),
            [.providerErrorObserved, .reconnectSetupFailed, .resumptionAttemptFailed])
        XCTAssertEqual(
            AlmaLiveVoiceProviderControlEvidence.providerErrorEvents(
                recoveryAttempt: true,
                resumptionRequested: true,
                setupAccepted: true),
            [.providerErrorObserved],
            "an error after accepted setup must not retroactively claim setup/resumption failure")
        XCTAssertEqual(
            AlmaLiveVoiceProviderControlEvidence.setupCompleteEvents(
                resumptionRequested: false),
            [])
        XCTAssertEqual(
            AlmaLiveVoiceProviderControlEvidence.setupCompleteEvents(
                resumptionRequested: true),
            [.resumptionAccepted])
        XCTAssertEqual(
            AlmaLiveVoiceProviderControlEvidence.resumptionUpdateEvents(
                resumable: false,
                hasUsableHandle: false),
            [.resumptionUnavailable])
        XCTAssertEqual(
            AlmaLiveVoiceProviderControlEvidence.resumptionUpdateEvents(
                resumable: true,
                hasUsableHandle: false),
            [])
        XCTAssertEqual(
            AlmaLiveVoiceProviderControlEvidence.resumptionUpdateEvents(
                resumable: true,
                hasUsableHandle: true),
            [.resumptionHandleObserved])
    }

    func testLiveVoiceLifecycleEvidenceRejectsDelayedPriorSessionCallback() {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        let priorSessionID = recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)
        recorder.endSession(.ownerEnded)

        let currentSessionID = recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini31,
            voiceID: "Kore",
            callMode: .callKit,
            fixture: .noNetwork)
        recorder.recordLifecycleEvent(
            .appBackgrounded,
            expectedLocalSessionID: priorSessionID)
        recorder.recordLifecycleEvent(
            .appBecameActive,
            expectedLocalSessionID: currentSessionID)

        XCTAssertEqual(
            recorder.report().events.map(\.name),
            [.sessionStarted, .appBecameActive],
            "a delayed notification from the ended call cannot enter the next report")
    }

    func testLiveVoiceLifecycleRelayRetainsSourceSessionAcrossActorDelay() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        let live = AlmaGeminiLiveSession(evidenceRecorder: recorder)
        let relay = AlmaLiveVoiceLifecycleEvidenceRelay()

        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .callKit,
            fixture: .unitTest)
        live.beginEvidenceSession()
        let priorToken = relay.bind(live)
        let priorObservation = try XCTUnwrap(
            relay.record(.callKitAudioActivated, observedUptime: 10))
        XCTAssertEqual(priorObservation.sourceToken, priorToken)
        XCTAssertTrue(priorObservation.evidenceSubmittedAtSource)
        live.flushEvidence()
        recorder.endSession(.ownerEnded)
        live.finishEvidenceSession()

        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini31,
            voiceID: "Kore",
            callMode: .callKit,
            fixture: .noNetwork)
        live.beginEvidenceSession()
        let staleObservation = try XCTUnwrap(
            relay.record(.callKitAudioDeactivated, observedUptime: 20))
        XCTAssertEqual(staleObservation.sourceToken, priorToken)
        live.flushEvidence()
        XCTAssertEqual(
            recorder.report().events.map(\.name),
            [.sessionStarted],
            "a CallKit callback captured for the prior call cannot enter a reused session")

        let currentToken = relay.bind(live)
        XCTAssertNotEqual(currentToken, priorToken)
        let currentObservation = try XCTUnwrap(
            relay.record(.callKitAudioActivated, observedUptime: 30))
        XCTAssertEqual(currentObservation.sourceToken, currentToken)
        live.flushEvidence()
        XCTAssertEqual(
            recorder.report().events.map(\.name),
            [.sessionStarted, .callKitAudioActivated])
        relay.clear(live)
        XCTAssertNil(relay.record(.callKitAudioDeactivated, observedUptime: 40))
        live.finishEvidenceSession()
        recorder.endSession(.ownerEnded)
    }

    func testLiveVoiceLifecycleRelayFinalizesAfterPhysicalCallKitDeactivation() throws {
        let priorRecorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        let priorLive = AlmaGeminiLiveSession(evidenceRecorder: priorRecorder)
        let currentRecorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        let currentLive = AlmaGeminiLiveSession(evidenceRecorder: currentRecorder)
        let relay = AlmaLiveVoiceLifecycleEvidenceRelay()

        priorRecorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .callKit,
            fixture: .unitTest)
        priorLive.beginEvidenceSession()
        let priorToken = relay.bind(priorLive)
        let priorFinalizer = AlmaLiveVoiceTerminalEvidenceFinalizer(
            live: priorLive,
            recorder: priorRecorder,
            expectedLocalSessionID: priorRecorder.sessionID,
            outcome: .ownerEnded)
        XCTAssertTrue(relay.deferFinalization(
            priorLive,
            token: priorToken,
            finalizer: priorFinalizer,
            fallbackAfter: 60))
        XCTAssertNil(
            relay.record(.callKitAudioActivated, observedUptime: 43),
            "the stopped agent tail must not steal a new Office call's activation")

        // A replacement binding must not steal the old physical deactivation.
        currentRecorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini31,
            voiceID: "Kore",
            callMode: .callKit,
            fixture: .noNetwork)
        currentLive.beginEvidenceSession()
        let currentToken = relay.bind(currentLive)

        let terminalObservation = try XCTUnwrap(
            relay.record(.callKitAudioDeactivated, observedUptime: 44))
        XCTAssertEqual(terminalObservation.sourceToken, priorToken)
        XCTAssertTrue(terminalObservation.evidenceSubmittedAtSource)
        XCTAssertEqual(
            priorRecorder.report().events.map(\.name),
            [.sessionStarted, .callKitAudioDeactivated, .sessionEnded])
        XCTAssertEqual(currentRecorder.report().events.map(\.name), [.sessionStarted])
        XCTAssertFalse(relay.finishDeferredFinalization(for: priorToken))
        XCTAssertFalse(priorFinalizer.finish(), "terminal evidence finalization is exact-once")

        let currentObservation = try XCTUnwrap(
            relay.record(.callKitAudioActivated, observedUptime: 45))
        XCTAssertEqual(currentObservation.sourceToken, currentToken)
        currentLive.flushEvidence()
        XCTAssertEqual(
            currentRecorder.report().events.map(\.name),
            [.sessionStarted, .callKitAudioActivated])
        relay.clear(currentLive)
        currentLive.finishEvidenceSession()
        currentRecorder.endSession(.ownerEnded)
    }

    func testLiveVoiceLifecycleBehaviorFenceRejectsReplacementSessionTasks() {
        XCTAssertTrue(AlmaLiveVoiceLifecycleSessionFence.acceptsBehaviorEpoch(
            7,
            currentEpoch: 7,
            isClosed: false))
        XCTAssertFalse(AlmaLiveVoiceLifecycleSessionFence.acceptsBehaviorEpoch(
            7,
            currentEpoch: 8,
            isClosed: false),
            "a notification actor-hop from call A cannot restart or pause call B")
        XCTAssertFalse(AlmaLiveVoiceLifecycleSessionFence.acceptsBehaviorEpoch(
            8,
            currentEpoch: 8,
            isClosed: true))

        let prior = AlmaLiveVoiceLifecycleSourceToken(
            bindingOrdinal: 11,
            localSessionID: "voice-test-0001")
        let current = AlmaLiveVoiceLifecycleSourceToken(
            bindingOrdinal: 12,
            localSessionID: "voice-test-0001")
        XCTAssertTrue(AlmaLiveVoiceLifecycleSessionFence.acceptsSourceToken(
            current,
            currentToken: current,
            isClosed: false))
        XCTAssertFalse(AlmaLiveVoiceLifecycleSessionFence.acceptsSourceToken(
            prior,
            currentToken: current,
            isClosed: false),
            "CallKit deactivation from call A cannot pause replacement call B")
    }

    func testLiveVoiceEvidencePreservesTypedDeliveryChainAcrossReconnect() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        XCTAssertEqual(recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest), "voice-test-0001")
        XCTAssertEqual(recorder.report().session.requestedModelID, AlmaLiveVoicePreferences.gemini25)
        XCTAssertEqual(recorder.report().session.requestedVoiceID, "Aoede")
        XCTAssertEqual(recorder.report().session.activeModelID, "unknown")
        XCTAssertEqual(recorder.report().session.activeVoiceID, "unknown")

        let firstGeneration = recorder.beginTransportAttempt(resuming: false)
        recorder.recordSocketOpened(generation: firstGeneration)
        recorder.activateProfile(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            generation: firstGeneration)
        recorder.recordAudioGraphReady(generation: firstGeneration, route: .builtInSpeaker)
        recorder.recordAudioRouteChanged(
            generation: firstGeneration,
            route: .builtInReceiver,
            reason: .systemNotification)
        recorder.recordRawEnergy(rms: 0.0031, generation: firstGeneration)
        recorder.recordConversionSucceeded(byteCount: 640, generation: firstGeneration)
        let firstChunk = try XCTUnwrap(
            recorder.recordAudioQueued(byteCount: 640, generation: firstGeneration))
        let secondChunk = try XCTUnwrap(
            recorder.recordAudioQueued(byteCount: 640, generation: firstGeneration))
        recorder.recordAudioSendCompletion(
            firstChunk, succeeded: true,
            currentGeneration: firstGeneration, isCurrentReadySocket: true)
        recorder.recordProviderInputTranscriptionObserved(generation: firstGeneration)
        recorder.recordProviderModelAudioObserved(
            generation: firstGeneration,
            playbackGeneration: 1)
        XCTAssertEqual(
            recorder.recordToolCallObserved(.quickLookup, generation: firstGeneration), 1)

        let secondGeneration = recorder.beginTransportAttempt(resuming: true)
        recorder.recordAudioSendCompletion(
            secondChunk, succeeded: true,
            currentGeneration: secondGeneration, isCurrentReadySocket: false)
        recorder.recordRawEnergy(rms: 0.004, generation: secondGeneration)
        recorder.recordConversionSucceeded(byteCount: 640, generation: secondGeneration)
        let resumedChunk = try XCTUnwrap(
            recorder.recordAudioQueued(byteCount: 640, generation: secondGeneration))
        recorder.recordAudioSendCompletion(
            resumedChunk, succeeded: true,
            currentGeneration: secondGeneration, isCurrentReadySocket: true)
        recorder.recordProviderInputTranscriptionObserved(generation: secondGeneration)
        recorder.recordProviderModelAudioObserved(
            generation: secondGeneration,
            playbackGeneration: 2)
        recorder.activateProfile(
            modelID: AlmaLiveVoicePreferences.gemini31,
            voiceID: "Charon",
            generation: secondGeneration)
        recorder.recordModelTurnCompleted(generation: secondGeneration)
        recorder.endSession(.ownerEnded)

        let report = recorder.report()
        XCTAssertEqual(firstGeneration, 1)
        XCTAssertEqual(secondGeneration, 2)
        XCTAssertEqual(report.session.id, "voice-test-0001")
        XCTAssertEqual(report.session.activeModelID, AlmaLiveVoicePreferences.gemini31)
        XCTAssertEqual(report.session.activeVoiceID, "Charon")
        XCTAssertEqual(report.session.outcome, .ownerEnded)
        XCTAssertEqual(report.events.map(\.name), [
            .sessionStarted, .transportStarted, .socketOpened, .profileActivated,
            .audioGraphReady, .audioRouteChanged,
            .rawFirstEnergy, .conversionFirstSucceeded, .audioFirstQueued,
            .audioFirstSendSucceeded, .providerInputTranscriptionObserved,
            .providerModelAudioObserved, .toolCallObserved, .transportStarted,
            .staleSendCompletionIgnored, .rawFirstEnergy, .conversionFirstSucceeded,
            .audioFirstQueued, .audioFirstSendSucceeded,
            .providerInputTranscriptionObserved, .providerModelAudioObserved,
            .profileActivated, .sessionEnded,
        ])
        XCTAssertEqual(
            report.events.first(where: { $0.name == .rawFirstEnergy })?.turnOrdinal, 1)
        XCTAssertEqual(
            report.events.first(where: { $0.name == .toolCallObserved })?.toolOrdinal, 1)
        XCTAssertEqual(
            report.events.first(where: { $0.name == .staleSendCompletionIgnored })?
                .transportGeneration,
            2,
            "a completion from generation 1 must be classified under the current ledger state, not accepted")
        XCTAssertEqual(
            report.events.first(where: { $0.name == .staleSendCompletionIgnored })?
                .sourceTransportGeneration,
            1)
        XCTAssertFalse(
            report.events.contains(where: { $0.name == .audioFirstSendSucceeded
                && $0.audioChunkOrdinal == secondChunk.audioChunkOrdinal }),
            "a stale socket callback must never become delivery success")
        XCTAssertTrue(zip(report.events, report.events.dropFirst()).allSatisfy { pair in
            pair.0.elapsedMilliseconds <= pair.1.elapsedMilliseconds
        })
        XCTAssertEqual(
            report.events.first(where: { $0.name == .audioRouteChanged })?.routeReason,
            .systemNotification)
    }

    func testLiveVoiceEvidenceRejectsContentBearingIdentityInputsAndCanBeDisabled() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(
            enabled: true,
            buildProvenance: AlmaBuildProvenanceLoader.load(data: Data()))
        let localID = recorder.beginSession(
            modelID: "https://private.example/model?token=secret-token",
            voiceID: "owner-spoken-secret-token",
            callMode: .standalone)
        recorder.endSession(.failed)
        let report = recorder.report()
        let encoded = try recorder.encodedReport()
        let json = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        let jsonObject = try JSONSerialization.jsonObject(with: encoded)
        let allowedJSONKeys: Set<String> = [
            "schemaVersion", "generatedAt", "privacyContract", "featureEnabled",
            "app", "session", "events", "version", "build", "commit",
            "revisionStatus", "id", "startedAt", "endedAt", "callMode",
            "requestedModelID", "requestedVoiceID", "activeModelID", "activeVoiceID",
            "outcome", "sequence", "elapsedMilliseconds", "name", "localSessionID",
            "transportGeneration", "sourceTransportGeneration", "inputWindowOrdinal",
            "turnOrdinal", "toolOrdinal", "audioChunkOrdinal", "byteCount", "rmsMilli",
            "route", "routeReason", "reason", "retention", "tool", "resumedTransport",
        ]
        func assertAllowlistedJSON(_ value: Any, file: StaticString = #filePath, line: UInt = #line) {
            if let dictionary = value as? [String: Any] {
                for (key, nested) in dictionary {
                    XCTAssertTrue(allowedJSONKeys.contains(key),
                                  "unexpected evidence JSON key: \(key)",
                                  file: file, line: line)
                    assertAllowlistedJSON(nested, file: file, line: line)
                }
            } else if let array = value as? [Any] {
                array.forEach { assertAllowlistedJSON($0, file: file, line: line) }
            } else {
                XCTAssertTrue(value is String || value is NSNumber || value is NSNull,
                              "unexpected evidence JSON value type: \(type(of: value))",
                              file: file, line: line)
            }
        }
        assertAllowlistedJSON(jsonObject)

        XCTAssertTrue(localID.hasPrefix("voice-"))
        XCTAssertNotEqual(localID, "voice-secret-token")
        XCTAssertEqual(report.session.requestedModelID, "unknown")
        XCTAssertEqual(report.session.requestedVoiceID, "unknown")
        XCTAssertEqual(report.session.activeModelID, "unknown")
        XCTAssertEqual(report.session.activeVoiceID, "unknown")
        XCTAssertEqual(report.app.commit, "unknown")
        XCTAssertEqual(report.app.revisionStatus, .unavailableInvalidBundleProvenance)
        XCTAssertFalse(json.contains("private.example"))
        XCTAssertFalse(json.contains("secret-token"))
        XCTAssertEqual(report.privacyContract, [
            "no-pcm-or-audio-payload",
            "no-transcript-prompt-or-user-content",
            "no-tool-arguments-results-or-provider-call-id",
            "no-url-token-cookie-credential-or-user-content-hash",
            "typed-allowlisted-fields-only",
            "raw-energy-is-not-proof-of-owner-speech",
            "queue-is-not-send-and-local-send-is-not-provider-receipt",
            "policy-is-a-local-app-decision-at-that-observation",
        ])
        XCTAssertEqual(report.schemaVersion, 2)

        let disabled = AlmaLiveVoiceEvidenceRecorder(enabled: false)
        XCTAssertEqual(disabled.beginSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone), "evidence-disabled")
        XCTAssertFalse(disabled.report().featureEnabled)
        XCTAssertTrue(disabled.report().events.isEmpty)
        XCTAssertThrowsError(try disabled.encodedReport())
    }

    func testBuildProvenanceAcceptsOnlyExactVerifiedCommitContract() throws {
        func plist(_ dictionary: [String: Any]) throws -> Data {
            try PropertyListSerialization.data(
                fromPropertyList: dictionary,
                format: .binary,
                options: 0)
        }
        func verified(_ commit: Any, extra: [String: Any] = [:]) throws -> AlmaBuildProvenance {
            var dictionary: [String: Any] = [
                "schemaVersion": 1,
                "revisionStatus": "verified-clean-source-and-bundled-inputs",
                "commit": commit,
            ]
            extra.forEach { dictionary[$0.key] = $0.value }
            return AlmaBuildProvenanceLoader.load(data: try plist(dictionary))
        }

        let sha1 = String(repeating: "a", count: 40)
        let sha256 = String(repeating: "9", count: 64)
        XCTAssertEqual(try verified(sha1).trustedCommit, sha1)
        XCTAssertEqual(try verified(sha256).trustedCommit, sha256)
        XCTAssertEqual(
            try verified(sha1).revisionStatus,
            .verifiedCleanSourceAndBundledInputs)

        for untrustedCommit in [
            "98c70adc77",
            String(repeating: "A", count: 40),
            String(repeating: "a", count: 39),
            String(repeating: "a", count: 41),
            String(repeating: "g", count: 40),
            "\(String(repeating: "a", count: 40))\n",
        ] {
            let result = try verified(untrustedCommit)
            XCTAssertNil(result.trustedCommit, "must reject forged commit: \(untrustedCommit)")
            XCTAssertEqual(result.revisionStatus, .unavailableInvalidBundleProvenance)
        }

        XCTAssertEqual(
            try verified(NSNumber(value: 1)).revisionStatus,
            .unavailableInvalidBundleProvenance)
        XCTAssertEqual(
            try verified(sha1, extra: ["ALMAGitCommit": sha1]).revisionStatus,
            .unavailableInvalidBundleProvenance,
            "legacy or unexpected fields must not extend the trust envelope")
    }

    func testBuildProvenanceUnavailableAndMalformedInputsFailClosed() throws {
        func plist(_ object: Any) throws -> Data {
            try PropertyListSerialization.data(
                fromPropertyList: object,
                format: .binary,
                options: 0)
        }
        func load(_ dictionary: [String: Any]) throws -> AlmaBuildProvenance {
            AlmaBuildProvenanceLoader.load(data: try plist(dictionary))
        }

        let unavailable = AlmaBuildProvenanceStatus.allCases.filter {
            $0 != .verifiedCleanSourceAndBundledInputs
        }
        for status in unavailable {
            let result = try load([
                "schemaVersion": 1,
                "revisionStatus": status.rawValue,
            ])
            XCTAssertEqual(result.revisionStatus, status)
            XCTAssertNil(result.trustedCommit)
            XCTAssertEqual(result.evidenceCommit, "unknown")
        }

        let maliciousSha = String(repeating: "b", count: 40)
        let invalidDictionaries: [[String: Any]] = [
            [:],
            ["schemaVersion": 2, "revisionStatus": "unavailable-repository"],
            ["schemaVersion": true, "revisionStatus": "unavailable-repository"],
            ["schemaVersion": 1.0, "revisionStatus": "unavailable-repository"],
            ["schemaVersion": "1", "revisionStatus": "unavailable-repository"],
            ["schemaVersion": 1, "revisionStatus": "VERIFIED-clean-source-and-bundled-inputs"],
            ["schemaVersion": 1, "revisionStatus": "unknown-status"],
            ["schemaVersion": 1, "revisionStatus": "verified-clean-source-and-bundled-inputs"],
            [
                "schemaVersion": 1,
                "revisionStatus": "unavailable-dirty-worktree",
                "commit": maliciousSha,
            ],
            [
                "schemaVersion": 1,
                "revisionStatus": "unavailable-repository",
                "unexpected": "owner-content",
            ],
        ]
        for dictionary in invalidDictionaries {
            let result = try load(dictionary)
            XCTAssertEqual(result.revisionStatus, .unavailableInvalidBundleProvenance)
            XCTAssertNil(result.trustedCommit)
        }

        let nonDictionary = AlmaBuildProvenanceLoader.load(
            data: try plist(["untrusted", maliciousSha]))
        XCTAssertEqual(nonDictionary.revisionStatus, .unavailableInvalidBundleProvenance)
        XCTAssertNil(nonDictionary.trustedCommit)
        XCTAssertEqual(
            AlmaBuildProvenanceLoader.load(data: Data("not a plist".utf8)).revisionStatus,
            .unavailableInvalidBundleProvenance)
    }

    func testLiveVoiceEvidenceUsesOnlyInjectedTrustedBuildProvenance() throws {
        let sha = String(repeating: "c", count: 40)
        let data = try PropertyListSerialization.data(
            fromPropertyList: [
                "schemaVersion": 1,
                "revisionStatus": "verified-clean-source-and-bundled-inputs",
                "commit": sha,
            ],
            format: .binary,
            options: 0)
        let provenance = AlmaBuildProvenanceLoader.load(data: data)
        let recorder = AlmaLiveVoiceEvidenceRecorder(
            enabled: true,
            buildProvenance: provenance)

        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)
        recorder.endSession(.ownerEnded)

        XCTAssertEqual(recorder.report().app.commit, sha)
        XCTAssertEqual(
            recorder.report().app.revisionStatus,
            .verifiedCleanSourceAndBundledInputs)
    }

    func testLiveVoiceEvidenceSchemaV2Phase0CEventContract() throws {
        let canary = "owner-phase0c-secret@example.com"
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: canary,
            voiceID: canary,
            callMode: .standalone,
            fixture: .unitTest)
        let generation = recorder.beginTransportAttempt(resuming: false)
        let firstWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: recorder.sessionID,
            transportGeneration: generation,
            windowOrdinal: 1)
        XCTAssertTrue(recorder.activateInputWindow(firstWindow, generation: generation))
        recorder.recordRawEnergy(
            rms: 0.012,
            generation: generation,
            inputWindowID: firstWindow)
        recorder.recordConversionFailed(
            .converterUnavailable,
            generation: generation,
            inputWindowID: firstWindow)
        recorder.recordConversionSucceeded(
            byteCount: 640,
            generation: generation,
            inputWindowID: firstWindow)
        for policy in [
            AlmaLiveVoiceEvidenceInputPolicy.playbackTailSuppression,
            .listenCalibration,
            .listenGateClosed,
            .noAECEchoGuard,
        ] {
            recorder.recordInputWithheldByPolicy(
                policy,
                generation: generation,
                inputWindowID: firstWindow)
        }
        recorder.recordAudioNotQueued(
            .socketNotReady,
            byteCount: 640,
            generation: generation,
            inputWindowID: firstWindow)
        let failed = try XCTUnwrap(recorder.recordAudioQueued(
            byteCount: 640,
            generation: generation,
            inputWindowID: firstWindow))
        recorder.recordAudioSendCompletion(
            failed,
            succeeded: false,
            currentGeneration: generation,
            isCurrentReadySocket: true)

        let secondWindow = AlmaLiveVoiceEvidenceInputWindowID(
            localSessionID: recorder.sessionID,
            transportGeneration: generation,
            windowOrdinal: 2)
        recorder.recordProviderModelAudioObserved(
            generation: generation,
            playbackGeneration: 1,
            nextInputWindowID: secondWindow)
        recorder.recordRawEnergy(
            rms: 0.02,
            generation: generation,
            inputWindowID: secondWindow)
        recorder.recordConversionSucceeded(
            byteCount: 640,
            generation: generation,
            inputWindowID: secondWindow)
        recorder.recordAudioSendTrackingUnavailable(
            byteCount: 640,
            generation: generation,
            inputWindowID: secondWindow)
        let successful = try XCTUnwrap(recorder.recordAudioQueued(
            byteCount: 640,
            generation: generation,
            inputWindowID: secondWindow))
        recorder.recordAudioSendCompletion(
            successful,
            succeeded: true,
            currentGeneration: generation,
            isCurrentReadySocket: true)
        _ = recorder.recordToolCallObserved(
            AlmaLiveVoiceEvidenceTool(providerName: canary),
            generation: generation)
        recorder.endSession(.ownerEnded)

        let encoded = try recorder.encodedReport()
        let plaintext = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        XCTAssertFalse(plaintext.contains(canary))
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(Set(root.keys), [
            "schemaVersion", "generatedAt", "privacyContract", "featureEnabled",
            "app", "session", "events",
        ])
        XCTAssertEqual(root["schemaVersion"] as? Int, 2)
        XCTAssertEqual(root["featureEnabled"] as? Bool, true)
        XCTAssertEqual(root["privacyContract"] as? [String], [
            "no-pcm-or-audio-payload",
            "no-transcript-prompt-or-user-content",
            "no-tool-arguments-results-or-provider-call-id",
            "no-url-token-cookie-credential-or-user-content-hash",
            "typed-allowlisted-fields-only",
            "raw-energy-is-not-proof-of-owner-speech",
            "queue-is-not-send-and-local-send-is-not-provider-receipt",
            "policy-is-a-local-app-decision-at-that-observation",
        ])

        let app = try XCTUnwrap(root["app"] as? [String: Any])
        XCTAssertEqual(Set(app.keys), ["version", "build", "commit", "revisionStatus"])
        XCTAssertTrue(app.values.allSatisfy { $0 is String })
        let session = try XCTUnwrap(root["session"] as? [String: Any])
        XCTAssertEqual(Set(session.keys), [
            "id", "startedAt", "endedAt", "callMode", "requestedModelID",
            "requestedVoiceID", "activeModelID", "activeVoiceID", "outcome",
        ])
        XCTAssertTrue(session.values.allSatisfy { $0 is String })

        let events = try XCTUnwrap(root["events"] as? [[String: Any]])
        let baseKeys: Set<String> = [
            "sequence", "elapsedMilliseconds", "name", "localSessionID",
            "transportGeneration",
        ]
        let exactKeys: [String: Set<String>] = [
            "input.raw-first-energy": baseKeys.union(["inputWindowOrdinal", "rmsMilli"]),
            "input.conversion-failed": baseKeys.union(["inputWindowOrdinal", "reason"]),
            "input.conversion-first-succeeded": baseKeys.union(["inputWindowOrdinal", "byteCount"]),
            "input.audio-withheld-by-policy": baseKeys.union([
                "inputWindowOrdinal", "reason", "retention",
            ]),
            "input.audio-not-queued": baseKeys.union([
                "inputWindowOrdinal", "turnOrdinal", "byteCount", "reason",
            ]),
            "input.audio-first-queued": baseKeys.union([
                "inputWindowOrdinal", "turnOrdinal", "audioChunkOrdinal", "byteCount",
            ]),
            "input.audio-send-failed": baseKeys.union([
                "inputWindowOrdinal", "turnOrdinal", "audioChunkOrdinal", "byteCount", "reason",
            ]),
            "input.audio-send-tracking-unavailable": baseKeys.union([
                "inputWindowOrdinal", "turnOrdinal", "byteCount", "reason",
            ]),
            "input.audio-first-send-succeeded": baseKeys.union([
                "inputWindowOrdinal", "turnOrdinal", "audioChunkOrdinal", "byteCount",
            ]),
        ]
        var observedPhase0CNames = Set<String>()
        for event in events {
            guard let name = event["name"] as? String,
                  let expected = exactKeys[name] else { continue }
            observedPhase0CNames.insert(name)
            XCTAssertEqual(Set(event.keys), expected, "schema mismatch for \(name)")
            for key in expected.intersection([
                "sequence", "elapsedMilliseconds", "transportGeneration",
                "inputWindowOrdinal", "turnOrdinal", "audioChunkOrdinal",
                "byteCount", "rmsMilli",
            ]) {
                XCTAssertNotNil(event[key] as? Int, "\(name).\(key) must be an integer")
            }
            XCTAssertNotNil(event["localSessionID"] as? String)
        }
        XCTAssertEqual(observedPhase0CNames, Set(exactKeys.keys))

        let policyEvents = events.filter {
            $0["name"] as? String == "input.audio-withheld-by-policy"
        }
        XCTAssertEqual(Set(policyEvents.compactMap { $0["reason"] as? String }), [
            "playback-tail-suppression", "listen-calibration", "listen-gate-closed",
            "no-aec-echo-guard",
        ])
        XCTAssertEqual(Set(policyEvents.compactMap { $0["retention"] as? String }), [
            "bounded-pre-roll", "discarded",
        ])
        XCTAssertEqual(Set(policyEvents.compactMap { event -> String? in
            guard let reason = event["reason"] as? String,
                  let retention = event["retention"] as? String else { return nil }
            return "\(reason)|\(retention)"
        }), [
            "playback-tail-suppression|discarded",
            "listen-calibration|bounded-pre-roll",
            "listen-gate-closed|bounded-pre-roll",
            "no-aec-echo-guard|bounded-pre-roll",
        ])
        XCTAssertEqual(events.first {
            $0["name"] as? String == "input.audio-not-queued"
        }?["reason"] as? String, "socket-not-ready")
        XCTAssertEqual(events.first {
            $0["name"] as? String == "input.audio-send-failed"
        }?["reason"] as? String, "socket-send-failed")
        XCTAssertEqual(events.first {
            $0["name"] as? String == "input.audio-send-tracking-unavailable"
        }?["reason"] as? String, "evidence-binding-unavailable")

        func encodedConversionReason(
            _ failure: AlmaLiveVoiceEvidenceConversionFailure
        ) throws -> String? {
            let isolated = AlmaLiveVoiceEvidenceRecorder(enabled: true)
            isolated.beginFixtureSession(
                modelID: AlmaLiveVoicePreferences.gemini25,
                voiceID: "Aoede",
                callMode: .standalone,
                fixture: .unitTest)
            let generation = isolated.beginTransportAttempt(resuming: false)
            let window = AlmaLiveVoiceEvidenceInputWindowID(
                localSessionID: isolated.sessionID,
                transportGeneration: generation,
                windowOrdinal: 1)
            XCTAssertTrue(isolated.activateInputWindow(window, generation: generation))
            isolated.recordRawEnergy(rms: 0.01, generation: generation, inputWindowID: window)
            isolated.recordConversionFailed(
                failure,
                generation: generation,
                inputWindowID: window)
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: isolated.encodedReport())
                    as? [String: Any])
            let events = try XCTUnwrap(object["events"] as? [[String: Any]])
            return events.first {
                $0["name"] as? String == "input.conversion-failed"
            }?["reason"] as? String
        }

        func encodedNotQueuedReason(
            _ reason: AlmaLiveVoiceEvidenceNotQueuedReason
        ) throws -> String? {
            let isolated = AlmaLiveVoiceEvidenceRecorder(enabled: true)
            isolated.beginFixtureSession(
                modelID: AlmaLiveVoicePreferences.gemini25,
                voiceID: "Aoede",
                callMode: .standalone,
                fixture: .unitTest)
            let generation = isolated.beginTransportAttempt(resuming: false)
            let window = AlmaLiveVoiceEvidenceInputWindowID(
                localSessionID: isolated.sessionID,
                transportGeneration: generation,
                windowOrdinal: 1)
            XCTAssertTrue(isolated.activateInputWindow(window, generation: generation))
            isolated.recordRawEnergy(rms: 0.01, generation: generation, inputWindowID: window)
            isolated.recordConversionSucceeded(
                byteCount: 640,
                generation: generation,
                inputWindowID: window)
            isolated.recordAudioNotQueued(
                reason,
                byteCount: 0,
                generation: generation,
                inputWindowID: window)
            isolated.recordAudioNotQueued(
                reason,
                byteCount: 640,
                generation: generation,
                inputWindowID: window)
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: isolated.encodedReport())
                    as? [String: Any])
            let events = try XCTUnwrap(object["events"] as? [[String: Any]])
            let notQueued = events.filter {
                $0["name"] as? String == "input.audio-not-queued"
            }
            XCTAssertEqual(notQueued.count, 1, "zero-byte observations must be rejected")
            return notQueued.first?["reason"] as? String
        }

        for (failure, expected) in [
            (AlmaLiveVoiceEvidenceConversionFailure.converterUnavailable,
             "converter-unavailable"),
            (.outputBufferUnavailable, "output-buffer-unavailable"),
            (.conversionError, "conversion-error"),
            (.emptyOutput, "empty-converted-audio"),
        ] {
            XCTAssertEqual(try encodedConversionReason(failure), expected)
        }
        for (reason, expected) in [
            (AlmaLiveVoiceEvidenceNotQueuedReason.serializationFailed,
             "serialization-failed"),
            (.socketUnavailable, "socket-unavailable"),
            (.socketNotReady, "socket-not-ready"),
            (.sourceAttemptMismatch, "source-attempt-mismatch"),
        ] {
            XCTAssertEqual(try encodedNotQueuedReason(reason), expected)
        }
    }

    func testLiveVoiceEvidenceBindingDivergenceIsNotReportedAsDeliveryFailure() {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)
        let generation = recorder.beginTransportAttempt(resuming: false)
        recorder.recordRawEnergy(rms: 0.01, generation: generation)
        recorder.recordConversionSucceeded(byteCount: 640, generation: generation)
        recorder.recordAudioSendTrackingUnavailable(
            byteCount: 640,
            generation: generation)

        let report = recorder.report()
        let divergence = report.events.first(where: {
            $0.name == .audioSendTrackingUnavailable
        })
        XCTAssertEqual(divergence?.reason, .evidenceBindingUnavailable)
        XCTAssertFalse(report.events.contains { $0.name == .audioSendFailed })
        XCTAssertFalse(report.events.contains { $0.name == .audioFirstSendSucceeded })
    }

    func testLiveVoiceEvidenceModelEpochArmsOneStableBargeInInputWindow() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)
        let generation = recorder.beginTransportAttempt(resuming: false)

        recorder.recordRawEnergy(rms: 0.01, generation: generation)
        recorder.recordConversionSucceeded(byteCount: 640, generation: generation)
        recorder.recordProviderModelAudioObserved(
            generation: generation,
            playbackGeneration: 10)
        recorder.recordProviderModelAudioObserved(
            generation: generation,
            playbackGeneration: 10)
        recorder.recordProviderInputTranscriptionObserved(generation: generation)
        recorder.recordConfirmedBargeInInputBoundary(
            rms: 0.02,
            convertedByteCount: 640,
            generation: generation)
        recorder.recordProviderInputTranscriptionObserved(generation: generation)
        recorder.recordModelTurnCompleted(generation: generation)
        let overlapped = try XCTUnwrap(
            recorder.recordAudioQueued(byteCount: 640, generation: generation))
        recorder.recordModelTurnCompleted(generation: generation)
        let afterLateTurnComplete = try XCTUnwrap(
            recorder.recordAudioQueued(byteCount: 640, generation: generation))

        let report = recorder.report()
        let modelEvents = report.events.filter { $0.name == .providerModelAudioObserved }
        XCTAssertEqual(modelEvents.count, 1, "repeated PCM in one playback epoch rotates once")
        XCTAssertEqual(modelEvents.first?.turnOrdinal, 1)
        XCTAssertEqual(overlapped.turnOrdinal, 2)
        XCTAssertEqual(afterLateTurnComplete.turnOrdinal, 2,
                       "provider turnComplete cannot erase a newer overlap/manual input window")
        XCTAssertEqual(
            report.events.filter { $0.name == .rawFirstEnergy }.compactMap(\.turnOrdinal),
            [1, 2])
        XCTAssertEqual(
            report.events.filter { $0.name == .providerInputTranscriptionObserved }
                .map(\.turnOrdinal),
            [nil, 2],
            "late/cross-stream transcription cannot invent a turn before local input evidence")
    }

    func testLiveVoiceEvidenceRejectsLateCompletionAfterEndAndAcrossNewSession() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)
        let oldGeneration = recorder.beginTransportAttempt(resuming: false)
        recorder.recordRawEnergy(rms: 0.01, generation: oldGeneration)
        let oldContext = try XCTUnwrap(
            recorder.recordAudioQueued(byteCount: 640, generation: oldGeneration))
        recorder.endSession(.ownerEnded)
        let endedEvents = recorder.report().events

        recorder.recordAudioSendCompletion(
            oldContext, succeeded: true,
            currentGeneration: oldGeneration, isCurrentReadySocket: true)
        recorder.recordProviderInputTranscriptionObserved(generation: oldGeneration)
        XCTAssertEqual(recorder.report().events, endedEvents,
                       "sessionEnded must freeze the finalized ledger")

        let newSessionID = recorder.beginSession(
            modelID: AlmaLiveVoicePreferences.gemini31,
            voiceID: "Charon",
            callMode: .callKit)
        let beforeTransport = recorder.report().events
        recorder.recordRawEnergy(rms: 0.02, generation: 0)
        recorder.recordConversionSucceeded(byteCount: 640, generation: 0)
        recorder.recordProviderInputTranscriptionObserved(generation: 0)
        recorder.recordProviderModelAudioObserved(
            generation: 0,
            playbackGeneration: 98)
        XCTAssertNil(recorder.recordToolCallObserved(.quickLookup, generation: 0))
        XCTAssertEqual(recorder.report().events, beforeTransport,
                       "generation zero is an inactive pre-transport sentinel")
        let newGeneration = recorder.beginTransportAttempt(resuming: false)
        let beforeLateCallback = recorder.report().events
        recorder.recordAudioSendCompletion(
            oldContext, succeeded: true,
            currentGeneration: newGeneration, isCurrentReadySocket: true)
        recorder.recordConversionFailed(
            .conversionError,
            generation: oldGeneration)
        recorder.recordRawEnergy(rms: 0.02, generation: oldGeneration)
        recorder.recordConversionSucceeded(byteCount: 640, generation: oldGeneration)
        recorder.recordProviderInputTranscriptionObserved(generation: oldGeneration)
        recorder.recordProviderModelAudioObserved(
            generation: oldGeneration,
            playbackGeneration: 99)
        XCTAssertNil(recorder.recordToolCallObserved(
            .quickLookup,
            generation: oldGeneration))
        XCTAssertNotEqual(newSessionID, oldContext.localSessionID)
        XCTAssertNotEqual(newGeneration, oldGeneration,
                          "transport identities must never be reused across logical sessions")
        XCTAssertEqual(recorder.report().events, beforeLateCallback,
                       "no delayed evidence source may contaminate a reused engine")
    }

    func testLiveVoiceTransportBindingRequiresOneAtomicReadyIdentity() {
        let oldSocket = NSObject()
        let newSocket = NSObject()
        var binding = AlmaLiveVoiceEvidenceTransportBinding()

        binding.begin(generation: 1)
        binding.bind(socketIdentity: ObjectIdentifier(oldSocket), generation: 1)
        XCTAssertFalse(binding.completion(
            socketIdentity: ObjectIdentifier(oldSocket),
            sourceGeneration: 1).isCurrentReadySocket)
        XCTAssertTrue(binding.markReady(
            socketIdentity: ObjectIdentifier(oldSocket),
            generation: 1))
        XCTAssertTrue(binding.completion(
            socketIdentity: ObjectIdentifier(oldSocket),
            sourceGeneration: 1).isCurrentReadySocket)

        binding.markNotReady()
        XCTAssertFalse(binding.completion(
            socketIdentity: ObjectIdentifier(oldSocket),
            sourceGeneration: 1).isCurrentReadySocket,
            "a completion after reconnect begins is not current-ready success")
        binding.begin(generation: 2)
        binding.bind(socketIdentity: ObjectIdentifier(newSocket), generation: 2)
        XCTAssertFalse(binding.markReady(
            socketIdentity: ObjectIdentifier(newSocket),
            generation: 1))
        XCTAssertTrue(binding.markReady(
            socketIdentity: ObjectIdentifier(newSocket),
            generation: 2))
        XCTAssertFalse(binding.completion(
            socketIdentity: ObjectIdentifier(oldSocket),
            sourceGeneration: 1).isCurrentReadySocket)
        XCTAssertTrue(binding.completion(
            socketIdentity: ObjectIdentifier(newSocket),
            sourceGeneration: 2).isCurrentReadySocket)
    }

    func testProductionActivityNoiseCollapsesToClaudeStyleEpisodes() {
        let blocks: [AgentChatMessage.TurnBlock] = [
            .activity(.init(id: "think-1", kind: .thinking,
                            label: "প্রশ্ন বুঝেছে", thinkFull: "scope")),
            .prose(id: "understanding", text: "Boss, বুঝেছি—data দেখছি।"),
            .activity(.init(id: "verify-1", kind: .progress,
                            label: "নিজের উত্তর যাচাই করছে")),
            .activity(.init(id: "think-2", kind: .thinking,
                            label: "The business snapshot says", thinkFull: "snapshot")),
            .activity(.init(id: "verify-2", kind: .progress,
                            label: "source নিশ্চিত করছে")),
            .activity(.init(id: "think-3", kind: .thinking,
                            label: "The dashboard snapshot confirms", thinkFull: "confirmed")),
            .activity(.init(id: "search", kind: .search,
                            label: "Searched available tools")),
            .activity(.init(id: "dashboard", kind: .tool,
                            label: "get_dashboard_snapshot", toolId: "dashboard", ok: true)),
            .prose(id: "final", text: "## ফলাফল\nসব data মিলেছে।"),
        ]

        let items = AgentTurnBlocksView.makeRenderItems(from: blocks)
        XCTAssertEqual(items.count, 5,
                       "raw provider chatter must render as thought → prose → thought → tools → prose")
        guard items.indices.contains(3),
              case .activityCluster(_, let activities) = items[3] else {
            return XCTFail("the operational episode must be one expandable cluster")
        }
        XCTAssertEqual(activities.filter { $0.kind == .tool }.count, 1)
        XCTAssertEqual(activities.filter { $0.kind == .search }.count, 1)
        if case .block(.activity(let thought)) = items[2] {
            XCTAssertEqual(thought.label, "findings যাচাই করেছে")
            XCTAssertTrue(thought.thinkFull.contains("snapshot"))
            XCTAssertTrue(thought.thinkFull.contains("confirmed"))
        } else {
            XCTFail("the repeated verification bursts must become one thought summary")
        }
    }

    func testProgressOnlyProviderDoesNotInventEmptyThoughtDetail() {
        let blocks: [AgentChatMessage.TurnBlock] = [
            .activity(.init(id: "round", kind: .progress,
                            label: "প্রথম data round শুরু করেছে", live: true)),
            .activity(.init(id: "verify", kind: .progress,
                            label: "result যাচাই করছে", live: true)),
            .activity(.init(id: "tool", kind: .tool,
                            label: "get_dashboard_snapshot", toolId: "tool", live: true)),
        ]

        let items = AgentTurnBlocksView.makeRenderItems(from: blocks)
        guard case .block(.activity(let lifecycle)) = items.first else {
            return XCTFail("progress-only providers need one factual lifecycle row")
        }
        XCTAssertEqual(lifecycle.kind, .progress)
        XCTAssertEqual(lifecycle.label, "result যাচাই করছে")
        XCTAssertTrue(lifecycle.thinkFull.contains("প্রথম data round"))
        XCTAssertTrue(lifecycle.thinkFull.contains("result যাচাই"))
    }

    func testCumulativeProviderSnapshotBecomesOnlyNewSuffix() {
        XCTAssertEqual(
            AgentChatMessage.incrementalStreamSuffix(
                existing: "Boss, dashboard দেখছি।",
                incoming: "Boss, dashboard দেখছি। এখন sales মিলাচ্ছি।"),
            " এখন sales মিলাচ্ছি।")
    }

    func testRepeatedProviderParagraphIsNotRenderedTwice() {
        let paragraph = "Boss, dashboard, sales এবং inventory মিলিয়ে risk report তৈরি করছি।"
        XCTAssertEqual(
            AgentChatMessage.incrementalStreamSuffix(
                existing: "আগের ভূমিকা।\n\n" + paragraph,
                incoming: paragraph),
            "")
        XCTAssertEqual(
            AgentChatMessage.incrementalStreamSuffix(existing: "ha", incoming: "ha"),
            "ha", "short intentional repetition must remain possible")
    }

    func testStructuredCitationExtractionDeduplicatesAndMarksInternalLinks() {
        let citations = AgentMarkdownText.extractCitations("""
        [OpenAI research](https://openai.com/research?publishedAt=2026-08-09) and [duplicate](https://openai.com/research?publishedAt=2026-08-09).
        [ALMA costs](/agent/costs) ![ignored image](https://example.com/image.png)
        """)
        XCTAssertEqual(citations.count, 2)
        XCTAssertEqual(citations[0].title, "OpenAI research")
        XCTAssertEqual(citations[0].domain, "openai.com")
        XCTAssertEqual(citations[0].dateLabel, "2026-08-09")
        XCTAssertFalse(citations[0].isALMAInternal)
        XCTAssertTrue(citations[1].isALMAInternal)
        XCTAssertEqual(citations[1].url.path, "/agent/costs")
    }

    func testSourcesExcludeActionsMediaAndFencedCodeExamples() {
        let citations = AgentMarkdownText.extractCitations("""
        Evidence: [OpenAI research](https://openai.com/research).
        [Download report](/api/reports/launch.pdf)
        [Watch demo](https://example.com/demo.mp4)
        ```markdown
        [Literal example](https://example.com/not-a-source)
        ```
        """)

        XCTAssertEqual(citations.map(\.title), ["OpenAI research"])
    }

    func testCitationDestinationPreservesBalancedParentheses() {
        let citations = AgentMarkdownText.extractCitations(
            "[Wikipedia](https://en.wikipedia.org/wiki/Function_(mathematics))")

        XCTAssertEqual(citations.count, 1)
        XCTAssertEqual(citations[0].url.absoluteString,
                       "https://en.wikipedia.org/wiki/Function_(mathematics)")
    }

    func testRichOutputFileRefsSurviveCanonicalColdLoad() throws {
        let data = #"{"id":"rich","role":"assistant","content":[{"type":"text","text":"ready"},{"type":"file_ref","bucket":"agent-files","path":"one.jpg","mediaType":"image/jpeg"},{"type":"file_ref","bucket":"agent-files","path":"two.jpg","mediaType":"image/jpeg"}],"tokensIn":10,"tokensOut":5,"costUsd":0.04}"#.data(using: .utf8)!
        let message = AgentChatMessage.from(try JSONDecoder().decode(AgentMessageWire.self, from: data))
        XCTAssertEqual(message.fileRefs.count, 2)
        XCTAssertEqual(message.imagePaths, ["one.jpg", "two.jpg"])
        XCTAssertEqual(message.costUsd, "0.0400")
    }

    func testSyntaxHighlighterPreservesSourceText() {
        let source = "let amount = 5000 // whole taka"
        XCTAssertEqual(String(AgentSyntaxHighlighter.highlight(source, language: "swift").characters), source)
    }

    func testAgoraJoinEpochFenceKeepsExactSameJoinIdempotent() throws {
        let registry = AlmaCallAudioAdmission()
        let engine = NSObject()
        let token = try XCTUnwrap(registry.claimNormal(
            .assistant(engine: ObjectIdentifier(engine)),
            stop: {}))
        defer { registry.release(token) }
        var fence = AlmaAgoraJoinEpochFence()

        let first = fence.activate(
            engineIdentity: ObjectIdentifier(engine),
            channel: "itc_same",
            admissionToken: token,
            operationGeneration: 7)
        let duplicate = fence.activate(
            engineIdentity: ObjectIdentifier(engine),
            channel: "itc_same",
            admissionToken: token,
            operationGeneration: 7)

        XCTAssertEqual(duplicate, first)
        XCTAssertEqual(fence.active, first)
    }

    func testAgoraJoinEpochFenceChangedOperationRequiresRetire() throws {
        let registry = AlmaCallAudioAdmission()
        let engine = NSObject()
        let token = try XCTUnwrap(registry.claimNormal(
            .assistant(engine: ObjectIdentifier(engine)),
            stop: {}))
        defer { registry.release(token) }
        var fence = AlmaAgoraJoinEpochFence()
        let original = fence.activate(
            engineIdentity: ObjectIdentifier(engine),
            channel: "itc_call",
            admissionToken: token,
            operationGeneration: 20)

        XCTAssertTrue(fence.requiresSerializedLeave(
            engineIdentity: ObjectIdentifier(engine),
            channel: "itc_call",
            admissionToken: token,
            operationGeneration: 21))
        XCTAssertEqual(fence.active, original)
        XCTAssertTrue(fence.retire(original))
        let replacement = fence.activate(
            engineIdentity: ObjectIdentifier(engine),
            channel: "itc_call",
            admissionToken: token,
            operationGeneration: 21)
        XCTAssertNotEqual(replacement.epoch, original.epoch)
    }

    func testAgoraJoinEpochFenceRejectsRetiredIdentityAfterReplacement() throws {
        let registry = AlmaCallAudioAdmission()
        let engine = NSObject()
        let token = try XCTUnwrap(registry.claimNormal(
            .assistant(engine: ObjectIdentifier(engine)),
            stop: {}))
        defer { registry.release(token) }
        var fence = AlmaAgoraJoinEpochFence()
        let stale = fence.activate(
            engineIdentity: ObjectIdentifier(engine),
            channel: "itc_old",
            admissionToken: token,
            operationGeneration: 1)
        XCTAssertTrue(fence.retire(stale))
        let current = fence.activate(
            engineIdentity: ObjectIdentifier(engine),
            channel: "itc_new",
            admissionToken: token,
            operationGeneration: 2)

        XCTAssertFalse(fence.accepts(
            stale,
            engineIdentity: ObjectIdentifier(engine),
            reportedChannel: "itc_old"))
        XCTAssertTrue(fence.accepts(
            current,
            engineIdentity: ObjectIdentifier(engine),
            reportedChannel: "itc_new"))
    }

    func testAgoraJoinEpochFenceRejectsWrongEngineAndReportedChannel() throws {
        let registry = AlmaCallAudioAdmission()
        let engine = NSObject()
        let wrongEngine = NSObject()
        let token = try XCTUnwrap(registry.claimNormal(
            .assistant(engine: ObjectIdentifier(engine)),
            stop: {}))
        defer { registry.release(token) }
        var fence = AlmaAgoraJoinEpochFence()
        let identity = fence.activate(
            engineIdentity: ObjectIdentifier(engine),
            channel: "itc_bound",
            admissionToken: token,
            operationGeneration: 3)

        XCTAssertFalse(fence.accepts(
            identity,
            engineIdentity: ObjectIdentifier(wrongEngine),
            reportedChannel: "itc_bound"))
        XCTAssertFalse(fence.accepts(
            identity,
            engineIdentity: ObjectIdentifier(engine),
            reportedChannel: "itc_other"))
        XCTAssertTrue(fence.accepts(
            identity,
            engineIdentity: ObjectIdentifier(engine),
            reportedChannel: "itc_bound"))
    }

    func testAgoraFailedSubmissionRetiresIdentityAndAllowsCleanRetry() throws {
        let registry = AlmaCallAudioAdmission()
        let engine = NSObject()
        let token = try XCTUnwrap(registry.claimNormal(
            .assistant(engine: ObjectIdentifier(engine)),
            stop: {}))
        defer { registry.release(token) }
        var fence = AlmaAgoraJoinEpochFence()
        let failed = fence.activate(
            engineIdentity: ObjectIdentifier(engine),
            channel: "itc_retry",
            admissionToken: token,
            operationGeneration: 40)

        XCTAssertEqual(
            AlmaAgoraJoinSubmissionTransition.apply(
                result: -17,
                identity: failed,
                fence: &fence),
            .failedRetired)
        XCTAssertNil(fence.active)
        XCTAssertFalse(fence.requiresSerializedLeave(
            engineIdentity: ObjectIdentifier(engine),
            channel: "itc_retry",
            admissionToken: token,
            operationGeneration: 40))

        let retry = fence.activate(
            engineIdentity: ObjectIdentifier(engine),
            channel: "itc_retry",
            admissionToken: token,
            operationGeneration: 40)
        XCTAssertNotEqual(retry.epoch, failed.epoch)
        XCTAssertTrue(fence.accepts(
            retry,
            engineIdentity: ObjectIdentifier(engine),
            reportedChannel: "itc_retry"))
    }

    func testAgoraChannelSwitchPlanMutesBeforeRetireAndLeave() {
        var operations: [AlmaAgoraChannelSwitchOperation] = []

        AlmaAgoraChannelSwitchOperationPlan.performPrivacyBoundary {
            operations.append($0)
        }

        XCTAssertEqual(operations, [
            .mutePublication,
            .retireAuthority,
            .leaveChannel,
        ])
    }
}
