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

    func testGeneratedFileRefsSuppressDuplicateMarkdownImageGallery() {
        XCTAssertTrue(AgentMarkdownText.shouldRenderRemoteImages(suppressRemoteImages: false))
        XCTAssertFalse(AgentMarkdownText.shouldRenderRemoteImages(suppressRemoteImages: true))
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
}
