import XCTest
@testable import App

@MainActor
final class AssistantParityV2Tests: XCTestCase {
    func testArchivedConversationPagePreservesRestoreMetadataAndCursor() throws {
        let data = Data(#"""
        {
          "conversations": [{
            "id": "archived-chat",
            "title": "Launch archive",
            "projectId": null,
            "modelId": "auto",
            "source": "web",
            "archived": true,
            "pinned": false,
            "updatedAt": "2026-08-11T10:00:00.000Z"
          }],
          "nextCursor": "0_2026-08-11T10:00:00.000Z_archived-chat",
          "hasMore": true
        }
        """#.utf8)

        let page = try JSONDecoder().decode(AgentConversationsPage.self, from: data)

        XCTAssertEqual(page.conversations.map(\.id), ["archived-chat"])
        XCTAssertEqual(page.conversations.first?.archived, true)
        XCTAssertNotNil(page.nextCursor)
    }

    func testSkillApprovalViewDecodesOwnerLedgerContract() throws {
        let data = Data(#"""
        {
          "gateOn": true,
          "engineEnabled": true,
          "rows": [{
            "name": "alma-image-generation",
            "version": "1.0.0",
            "status": "active",
            "hashShort": "abc12345",
            "state": "unapproved",
            "effectiveState": "unapproved",
            "wouldRun": false,
            "blockedBy": "approval",
            "blockedByName": "alma-image-generation",
            "approval": null
          }],
          "summary": {"total": 2, "live": 1, "needsApproval": 1, "revoked": 0}
        }
        """#.utf8)

        let view = try JSONDecoder().decode(SMSkillApprovalView.self, from: data)

        XCTAssertTrue(view.gateOn)
        XCTAssertEqual(view.summary.needsApproval, 1)
        XCTAssertEqual(view.rows.first?.name, "alma-image-generation")
        XCTAssertEqual(view.rows.first?.blockedBy, "approval")
    }

    func testLiveSkillPinUpdatesComposerAndStreamingTurnTogether() {
        let vm = AssistantVM()

        vm.debugApplyTurnEvents([.skillPinned(
            skill: "alma-image-generation", source: "router",
            reason: "image generation", isolated: true)])

        XCTAssertEqual(vm.pinnedSkillName, "alma-image-generation")
        XCTAssertEqual(vm.messages.last?.skill?.name, "alma-image-generation")
    }

    func testSkillHeldBackTransportPreservesServerContractFields() throws {
        let reason = "Skill বদলেছে — আবার অনুমোদন না দেওয়া পর্যন্ত চালানো হয়নি।"
        let data = Data(#"""
        {
          "type": "skill_held_back",
          "skill": "seo-fixing-own-site",
          "state": "changed",
          "reason": "Skill বদলেছে — আবার অনুমোদন না দেওয়া পর্যন্ত চালানো হয়নি।"
        }
        """#.utf8)
        let dto = try JSONDecoder().decode(AgentSSEEvent.self, from: data)

        guard case .skillHeldBack(let skill, let state, let decodedReason) =
                AgentTurnEvent(dto: dto) else {
            return XCTFail("skill_held_back must remain a typed native event")
        }
        XCTAssertEqual(skill, "seo-fixing-own-site")
        XCTAssertEqual(state, "changed")
        XCTAssertEqual(decodedReason, reason)
    }

    func testLiveSkillHeldBackClearsRunningPinAndStampsTurnReason() {
        let vm = AssistantVM()
        vm.debugApplyTurnEvents([.skillPinned(
            skill: "seo-fixing-own-site", source: "owner",
            reason: "owner pin", isolated: true)])

        let reason = "Skill approval বাতিল আছে — তাই এই turn-এ চালানো হয়নি।"
        vm.debugApplyTurnEvents([.skillHeldBack(
            skill: "seo-fixing-own-site", state: "revoked", reason: reason)])

        XCTAssertNil(vm.pinnedSkillName)
        XCTAssertNil(vm.messages.last?.skill,
                     "a held-back skill must never remain presented as running")
        XCTAssertEqual(vm.messages.last?.skillHeldBack?.name, "seo-fixing-own-site")
        XCTAssertEqual(vm.messages.last?.skillHeldBack?.state, "revoked")
        XCTAssertEqual(vm.messages.last?.skillHeldBack?.reason, reason)
        XCTAssertEqual(vm.messages.last?.skillHeldBack?.ownerFacingText, reason)
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

    func testGeneratedImageTileKeepsStableFourByFiveReservation() {
        XCTAssertEqual(
            AgentGeneratedImageSizing.stableContainerAspectRatio,
            4.0 / 5.0,
            accuracy: 0.0001)
    }

    func testGeneratedImageCompletionRequiresEveryRequestedVariant() {
        let requested = ["generated/one.jpg", "generated/two.jpg", "generated/three.jpg"]

        XCTAssertFalse(AgentGeneratedImageReadiness.isComplete(
            requestedPaths: requested,
            readyPaths: ["generated/one.jpg"],
            failedPaths: []))
        XCTAssertFalse(AgentGeneratedImageReadiness.isComplete(
            requestedPaths: requested,
            readyPaths: Set(requested),
            failedPaths: ["generated/two.jpg"]))
        XCTAssertTrue(AgentGeneratedImageReadiness.isComplete(
            requestedPaths: requested,
            readyPaths: Set(requested),
            failedPaths: []))
    }

    func testImageGenerationVisualProgressStartsAtOneAndNeverFakesOneHundred() {
        let start = Date(timeIntervalSince1970: 1_000)
        let samples = [0.0, 1, 8, 20, 45, 90, 240, 3_600].map {
            AgentRenderProgressModel.percent(
                startedAt: start, now: start.addingTimeInterval($0))
        }

        XCTAssertEqual(samples.first, 1)
        XCTAssertEqual(samples, samples.sorted(), "estimated progress must be monotonic")
        XCTAssertTrue(samples.allSatisfy { (1...99).contains($0) })
        XCTAssertEqual(
            AgentRenderProgressModel.percent(
                startedAt: start, now: start.addingTimeInterval(-20)),
            1)
        XCTAssertEqual(
            AgentRenderProgressModel.percent(
                startedAt: start, now: start, artifactReady: true),
            100, "only a real decoded artifact may project completion")
    }

    func testExistingActionHistoryDecodesPerImageQCByExactStoragePath() throws {
        let page = try JSONDecoder().decode(AgentImageActionsPage.self, from: Data(#"""
        {
          "actions": [
            {"id":"other","type":"browser_task","status":"executed",
             "conversationId":"chat-qc","result":{"images":{"unexpected":true}}},
            {"id":"image-action","type":"image_gen","status":"executed",
             "conversationId":"chat-qc","result":{"images":[
               {"storagePath":"generated/one.jpg","qc":{"pass":true,"overall":5,"attempts":1}},
               {"storagePath":"generated/two.jpg","qc":{"pass":false,"overall":3,"flagged":"text mismatch"}}
             ],"storagePaths":["generated/one.jpg","generated/two.jpg"],
             "variationQc":[{"pass":true,"overall":5},{"pass":false,"overall":3}],
             "costUsd":0.404,"provider":"gemini","model":"gemini-3.1-flash-image"}}
          ],
          "nextCursor":"older-action"
        }
        """#.utf8))

        let action = try XCTUnwrap(page.actions.first { $0.id == "image-action" })
        let rows = try XCTUnwrap(action.result).deliveredRows()

        XCTAssertEqual(rows.map { $0.path }, ["generated/one.jpg", "generated/two.jpg"])
        XCTAssertEqual(rows.map { $0.qc?.badgeText }, ["QC pass · 5/5", "QC fail · 3/5"])
        let receipt = try XCTUnwrap(action.result?.renderReceipt(actionId: action.id))
        XCTAssertEqual(receipt.formattedCost, "~$0.4040")
        XCTAssertEqual(receipt.provider, "gemini")
        XCTAssertEqual(receipt.model, "gemini-3.1-flash-image")
        XCTAssertEqual(page.nextCursor, "older-action")
        XCTAssertNil(page.actions.first { $0.id == "other" }?.result,
                     "heterogeneous action results must not poison the image page decoder")
    }

    func testImageApprovalNeverRelabelsLegacyBdtEstimateAsUsd() {
        XCTAssertNil(AgentConfirmCardCostPresentation.monetaryText(
            actionType: "image_gen", costEstimate: 4.40))
        XCTAssertTrue(AgentConfirmCardCostPresentation.showsPendingImageQuoteUnavailable(
            actionType: "image_gen", status: "pending"))
        XCTAssertFalse(AgentConfirmCardCostPresentation.showsPendingImageQuoteUnavailable(
            actionType: "image_gen", status: "executed"))
        XCTAssertEqual(AgentConfirmCardCostPresentation.monetaryText(
            actionType: "email_send", costEstimate: 0.25), "~$0.25")
    }

    func testLiveImageApprovalDecodesAuthoritativeModelSelectionAndDisabledReason() throws {
        let data = Data(#"""
        {"type":"confirm_card","pendingActionId":"image-live","summary":"Render four",
         "actionType":"image_gen","costEstimate":4.40,
         "imageModelSelection":{
           "selectedModel":"gemini-3-pro-image",
           "options":[
             {"id":"gemini-3-pro-image","label":"Nano Banana Pro","provider":"gemini",
              "enabled":true,"quote":{"version":1,"currency":"USD","kind":"provider_render_estimate",
                "model":"gemini-3-pro-image","provider":"gemini","quality":"standard","imageSize":"4K",
                "requestedImages":4,"unitPriceUsd":0.134,"minCostUsd":0.536,"maxCostUsd":1.608,
                "maxPaidGenerationsPerImage":3,"pricingBasis":"internal_list_estimate",
                "pricingLastVerifiedAt":"2026-08-11","excludes":["qc_vision","taxes","provider_credits"]}},
             {"id":"seedream-5.0-pro","label":"Seedream 5 Pro","provider":"fal","enabled":false,
              "unavailableReason":"এই aspect ratio-তে unavailable"}
           ],
           "quote":{"version":1,"currency":"USD","kind":"provider_render_estimate",
             "model":"gemini-3-pro-image","provider":"gemini","quality":"standard","imageSize":"4K",
             "requestedImages":4,"unitPriceUsd":0.134,"minCostUsd":0.536,"maxCostUsd":1.608,
             "maxPaidGenerationsPerImage":3,"pricingBasis":"internal_list_estimate",
             "pricingLastVerifiedAt":"2026-08-11","excludes":["qc_vision","taxes","provider_credits"]}
         }}
        """#.utf8)

        let dto = try JSONDecoder().decode(AgentSSEEvent.self, from: data)
        guard case .confirmCard(let id, _, let type, _, let selection) = AgentTurnEvent(dto: dto) else {
            return XCTFail("image approval must remain a typed confirm-card event")
        }
        XCTAssertEqual(id, "image-live")
        XCTAssertEqual(type, "image_gen")
        XCTAssertEqual(selection?.selectedModel, "gemini-3-pro-image")
        XCTAssertEqual(selection?.options.last?.unavailableReason,
                       "এই aspect ratio-তে unavailable")
        XCTAssertNil(selection?.options.last?.quote)
    }

    func testColdImageApprovalMatchesLiveModelSelectionContract() throws {
        let data = Data(#"""
        {"id":"image-cold","role":"assistant","content":[{
          "type":"confirm_card","pendingActionId":"image-action","summary":"Render four","status":"failed",
          "actionType":"image_gen","imageModelSelection":{
            "selectedModel":"gpt-image-2",
            "options":[{"id":"gpt-image-2","label":"GPT Image 2","provider":"openai","enabled":true,
              "quote":{"version":1,"currency":"USD","kind":"provider_render_estimate","model":"gpt-image-2",
                "provider":"openai","quality":"standard","imageSize":"2K","requestedImages":4,
                "unitPriceUsd":0.2,"minCostUsd":0.8,"maxCostUsd":2.4,"maxPaidGenerationsPerImage":3,
                "pricingBasis":"internal_list_estimate","pricingLastVerifiedAt":"2026-08-11",
                "excludes":["qc_vision","taxes"]}}],
            "quote":{"version":1,"currency":"USD","kind":"provider_render_estimate","model":"gpt-image-2",
              "provider":"openai","quality":"standard","imageSize":"2K","requestedImages":4,
              "unitPriceUsd":0.2,"minCostUsd":0.8,"maxCostUsd":2.4,"maxPaidGenerationsPerImage":3,
              "pricingBasis":"internal_list_estimate","pricingLastVerifiedAt":"2026-08-11",
              "excludes":["qc_vision","taxes"]}
          }}]}
        """#.utf8)

        let wire = try JSONDecoder().decode(AgentMessageWire.self, from: data)
        let card = try XCTUnwrap(AgentChatMessage.from(wire).confirmCards.first)
        XCTAssertEqual(card.status, "failed")
        XCTAssertEqual(card.imageModelSelection?.selectedModel, "gpt-image-2")
        XCTAssertEqual(card.imageModelSelection?.quote.maxCostUsd, 2.4)
    }

    func testMalformedAdditiveImageMetadataDropsPickerWithoutDroppingLiveOrColdCard() throws {
        let malformed = #"""
        "imageModelSelection":{"selectedModel":"gpt-image-2","options":[
          {"id":"gpt-image-2","label":"GPT Image 2","provider":"openai","enabled":true}
        ]}
        """#
        let liveData = Data("""
        {"type":"confirm_card","pendingActionId":"live-safe","summary":"Keep live card",
         "actionType":"image_gen",\(malformed)}
        """.utf8)
        let dto = try JSONDecoder().decode(AgentSSEEvent.self, from: liveData)
        guard case .confirmCard(let liveId, let summary, _, _, let selection) =
                AgentTurnEvent(dto: dto) else {
            return XCTFail("malformed additive metadata must not drop the live card")
        }
        XCTAssertEqual(liveId, "live-safe")
        XCTAssertEqual(summary, "Keep live card")
        XCTAssertNil(selection)

        let coldData = Data("""
        {"id":"cold-safe","role":"assistant","content":[{
          "type":"confirm_card","pendingActionId":"cold-action","summary":"Keep cold card",
          "status":"pending","actionType":"image_gen",\(malformed)}]}
        """.utf8)
        let cold = AgentChatMessage.from(
            try JSONDecoder().decode(AgentMessageWire.self, from: coldData))
        XCTAssertEqual(cold.confirmCards.first?.id, "cold-action")
        XCTAssertNil(cold.confirmCards.first?.imageModelSelection)
    }

    func testImagePickerRejectsEnabledMissingOrMismatchedOptionQuotes() {
        func quote(model: String, provider: String, maximum: Double = 0.60)
            -> AgentImageModelQuoteWire {
            .init(
                version: 1, currency: "USD", kind: "provider_render_estimate",
                model: model, provider: provider, quality: "standard", imageSize: "2K",
                requestedImages: 1, unitPriceUsd: 0.20, minCostUsd: 0.20,
                maxCostUsd: maximum, maxPaidGenerationsPerImage: 3,
                pricingBasis: "internal_list_estimate",
                pricingLastVerifiedAt: "2026-08-11",
                excludes: ["qc_vision"])
        }
        let top = quote(model: "gpt-image-2", provider: "openai")
        let missing = AgentImageModelSelectionWire(
            selectedModel: "gpt-image-2",
            options: [.init(id: "gpt-image-2", label: "GPT Image 2", provider: "openai",
                            enabled: true, unavailableReason: nil, quote: nil)],
            quote: top)
        XCTAssertNil(missing.trustedValue)

        let wrongModel = AgentImageModelSelectionWire(
            selectedModel: "gpt-image-2",
            options: [.init(id: "gpt-image-2", label: "GPT Image 2", provider: "openai",
                            enabled: true, unavailableReason: nil,
                            quote: quote(model: "gemini-3-pro-image", provider: "gemini"))],
            quote: top)
        XCTAssertNil(wrongModel.trustedValue)

        let differentSelectedQuote = AgentImageModelSelectionWire(
            selectedModel: "gpt-image-2",
            options: [.init(id: "gpt-image-2", label: "GPT Image 2", provider: "openai",
                            enabled: true, unavailableReason: nil,
                            quote: quote(model: "gpt-image-2", provider: "openai", maximum: 0.80))],
            quote: top)
        XCTAssertNil(differentSelectedQuote.trustedValue)
    }

    func testImageQuoteShowsBaseMaximumAndExplicitExclusions() throws {
        let quote = try JSONDecoder().decode(AgentImageModelQuoteWire.self, from: Data(#"""
        {"version":1,"currency":"USD","kind":"provider_render_estimate","model":"gemini-3-pro-image",
         "provider":"gemini","quality":"standard","imageSize":"4K","requestedImages":4,
         "unitPriceUsd":0.134,"minCostUsd":0.536,"maxCostUsd":1.608,"maxPaidGenerationsPerImage":3,
         "pricingBasis":"internal_list_estimate","pricingLastVerifiedAt":"2026-08-11",
         "excludes":["qc_vision","taxes","provider_credits"]}
        """#.utf8))

        let display = try XCTUnwrap(AgentImageModelQuotePresentation.resolve(quote))
        XCTAssertEqual(display.primaryText, "Base $0.536 · সর্বোচ্চ $1.608")
        XCTAssertEqual(display.detailText, "4 images · 4K · standard · প্রতি image সর্বোচ্চ 3 paid render")
        XCTAssertEqual(display.exclusionsText, "বাদ: QC vision, tax, provider credits")
    }

    func testImageModelServerEchoUpdatesCardWithoutRequestedStateGuess() throws {
        let vm = AssistantVM()
        var message = AgentChatMessage(id: "model-echo", role: .assistant)
        message.confirmCards = [.init(
            id: "model-action", summary: "old summary", status: "pending",
            actionType: "image_gen", costEstimate: nil)]
        vm.messages = [message]
        let detail = try JSONDecoder().decode(AgentImageActionDetailWire.self, from: Data(#"""
        {"id":"model-action","type":"image_gen","status":"pending","summary":"server summary",
         "imageModelSelection":{"selectedModel":"gpt-image-2","options":[
           {"id":"gpt-image-2","label":"GPT Image 2","provider":"openai","enabled":true,
            "quote":{"version":1,"currency":"USD","kind":"provider_render_estimate","model":"gpt-image-2",
             "provider":"openai","quality":"standard","imageSize":"2K","requestedImages":1,
             "unitPriceUsd":0.2,"minCostUsd":0.2,"maxCostUsd":0.6,"maxPaidGenerationsPerImage":3,
             "pricingBasis":"internal_list_estimate","pricingLastVerifiedAt":"2026-08-11","excludes":[]}}
         ],"quote":{"version":1,"currency":"USD","kind":"provider_render_estimate","model":"gpt-image-2",
          "provider":"openai","quality":"standard","imageSize":"2K","requestedImages":1,
          "unitPriceUsd":0.2,"minCostUsd":0.2,"maxCostUsd":0.6,"maxPaidGenerationsPerImage":3,
          "pricingBasis":"internal_list_estimate","pricingLastVerifiedAt":"2026-08-11","excludes":[]}}}
        """#.utf8))

        XCTAssertNil(vm.imageModelSelection(for: "model-action"))
        vm.applyImageActionDetail(detail)
        XCTAssertEqual(vm.imageModelSelection(for: "model-action")?.selectedModel, "gpt-image-2")
        XCTAssertEqual(vm.messages[0].confirmCards[0].summary, "server summary")
        XCTAssertEqual(
            AssistantVM.imageModelMutationOutcome(requestedModel: "gpt-image-2", detail: detail),
            .applied)
    }

    func testImageModelReconciliationDistinguishesResolvedAndNotApplied() throws {
        let pending = try JSONDecoder().decode(AgentImageActionDetailWire.self, from: Data(#"""
        {"id":"a","type":"image_gen","status":"pending","summary":"s","imageModelSelection":null}
        """#.utf8))
        let resolved = try JSONDecoder().decode(AgentImageActionDetailWire.self, from: Data(#"""
        {"id":"a","type":"image_gen","status":"failed","summary":"s","imageModelSelection":null}
        """#.utf8))

        XCTAssertEqual(AssistantVM.imageModelMutationOutcome(
            requestedModel: "gpt-image-2", detail: pending), .notApplied)
        XCTAssertEqual(AssistantVM.imageModelMutationOutcome(
            requestedModel: "gpt-image-2", detail: resolved), .resolved)
        XCTAssertEqual(AssistantVM.imageModelMutationOutcome(
            requestedModel: "gpt-image-2", detail: nil), .notApplied)
    }

    func testApprovalIsBlockedWhileImageModelMutationIsUnresolved() async {
        let vm = AssistantVM()
        vm.imageModelMutationTargetByCard["blocked-action"] = "gpt-image-2"

        let result = await vm.approveAction("blocked-action", approve: true)
        XCTAssertFalse(result)
        XCTAssertNil(vm.confirmApprovedAt["blocked-action"])
        XCTAssertTrue(vm.errorToast?.contains("মডেল নির্বাচন") == true)
    }

    func testApprovalIsBlockedWhenPinnedImageModelBecameUnavailable() async throws {
        let selection = try JSONDecoder().decode(AgentImageModelSelectionWire.self, from: Data(#"""
        {"selectedModel":"gpt-image-2","options":[
          {"id":"gpt-image-2","label":"GPT Image 2","provider":"openai","enabled":false,
           "unavailableReason":"credentials changed"}],
         "quote":{"version":1,"currency":"USD","kind":"provider_render_estimate","model":"gpt-image-2",
          "provider":"openai","quality":"standard","imageSize":"2K","requestedImages":1,
          "unitPriceUsd":0.2,"minCostUsd":0.2,"maxCostUsd":0.6,"maxPaidGenerationsPerImage":3,
          "pricingBasis":"internal_list_estimate","pricingLastVerifiedAt":"2026-08-11","excludes":[]}}
        """#.utf8))
        let vm = AssistantVM()
        var message = AgentChatMessage(id: "unavailable-model", role: .assistant)
        message.confirmCards = [.init(
            id: "unavailable-action", summary: "render", status: "pending",
            actionType: "image_gen", costEstimate: nil,
            imageModelSelection: selection)]
        vm.messages = [message]

        let result = await vm.approveAction("unavailable-action", approve: true)
        XCTAssertFalse(result)
        XCTAssertNil(vm.confirmApprovedAt["unavailable-action"])
        XCTAssertTrue(vm.errorToast?.contains("available model") == true)
    }

    func testGeneratedGalleryShowsOneSpendOnlyForOneExactAction() {
        let refs = (1...2).map {
            AgentFileRef(bucket: "agent-files", path: "generated/\($0).jpg", mediaType: "image/jpeg")
        }
        let receipt = AgentGeneratedImageRenderReceipt(
            actionId: "image-action", costUsd: 0.404,
            provider: "gemini", model: "gemini-3.1-flash-image")
        let shared = refs.map { AgentGeneratedImageItem(ref: $0, qc: nil, renderReceipt: receipt) }

        XCTAssertEqual(
            AgentGeneratedImageReceiptResolver.oneSharedReceipt(for: shared), receipt)
        XCTAssertNil(AgentGeneratedImageReceiptResolver.oneSharedReceipt(for: [
            shared[0], AgentGeneratedImageItem(ref: refs[1], qc: nil),
        ]), "a legacy/unmatched tile makes the aggregate association ambiguous")
        XCTAssertNil(AgentGeneratedImageReceiptResolver.oneSharedReceipt(for: [
            shared[0],
            AgentGeneratedImageItem(
                ref: refs[1], qc: nil,
                renderReceipt: .init(
                    actionId: "another-action", costUsd: 0.101,
                    provider: "gemini", model: "gemini-3.1-flash-image")),
        ]), "mixed action paths must never borrow one action's aggregate spend")
    }

    func testGeneratedImageQCDoesNotCallUncheckedOrMissingDataPassed() {
        XCTAssertEqual(
            AgentGeneratedImageQC(pass: true, overall: nil, skipped: "qc_unavailable").badgeText,
            "QC unchecked")
        XCTAssertEqual(
            AgentGeneratedImageQC(pass: true, overall: 5, bypassed: true).badgeText,
            "QC bypassed · 5/5")
        XCTAssertEqual(
            AgentGeneratedImageQC(pass: false, overall: 3, pipelineMode: "preview").badgeText,
            "Preview QC fail · 3/5")
        XCTAssertNil(AgentGeneratedImageQC().badgeText)
    }

    func testGeneratedImagePreviewKeepsReadyVariantsOpenWhenSiblingFails() throws {
        let refs = (1...3).map {
            AgentFileRef(bucket: "agent-files", path: "generated/\($0).jpg", mediaType: "image/jpeg")
        }
        let one = try XCTUnwrap(URL(string: "https://example.com/one.jpg"))
        let three = try XCTUnwrap(URL(string: "https://example.com/three.jpg"))

        let preview = try XCTUnwrap(AgentGeneratedImagePreviewBuilder.build(
            refs: refs,
            resolvedURLs: [refs[0].path: one, refs[2].path: three],
            selectedIndex: 2))

        XCTAssertEqual(preview.urls, [one, three])
        XCTAssertEqual(preview.refs.compactMap { $0?.path }, [refs[0].path, refs[2].path])
        XCTAssertEqual(preview.initialIndex, 1)
        XCTAssertNil(AgentGeneratedImagePreviewBuilder.build(
            refs: refs, resolvedURLs: [refs[0].path: one], selectedIndex: 1))
    }

    func testFullscreenGeneratedImageRetryTargetsExactVisibleReferenceAndURLSlot() throws {
        let refs: [AgentFileRef?] = (1...3).map {
            AgentFileRef(
                bucket: "agent-files", path: "generated/\($0).jpg", mediaType: "image/jpeg")
        }
        let urls = try (1...3).map { index in
            try XCTUnwrap(URL(string: "https://files.example/old-\(index)"))
        }
        let refreshed = try XCTUnwrap(URL(string: "https://files.example/new-2"))

        XCTAssertEqual(
            AgentGeneratedImageViewerRecovery.reference(at: 1, in: refs)?.path,
            "generated/2.jpg")
        XCTAssertNil(AgentGeneratedImageViewerRecovery.reference(at: -1, in: refs))
        XCTAssertNil(AgentGeneratedImageViewerRecovery.reference(at: 3, in: refs))

        let updated = AgentGeneratedImageViewerRecovery.replacingURL(
            urls, at: 1, with: refreshed)
        XCTAssertEqual(updated[0], urls[0])
        XCTAssertEqual(updated[1], refreshed)
        XCTAssertEqual(updated[2], urls[2])
        XCTAssertEqual(urls[1].absoluteString, "https://files.example/old-2",
                       "the immutable preview remains the viewer's stable page/action identity")
        XCTAssertEqual(
            AgentGeneratedImageViewerRecovery.replacingURL(urls, at: 3, with: refreshed),
            urls)
    }

    func testColdImageCardPreservesServerCostAndFailureReason() throws {
        let wire = try JSONDecoder().decode(AgentMessageWire.self, from: Data(#"""
        {
          "id":"cold-image-card",
          "role":"assistant",
          "content":[{
            "type":"confirm_card",
            "pendingActionId":"image-action",
            "summary":"Image generation request",
            "status":"failed",
            "actionType":"image_gen",
            "costEstimate":1.1,
            "failReason":"Provider timed out"
          }]
        }
        """#.utf8))

        let card = try XCTUnwrap(AgentChatMessage.from(wire).confirmCards.first)
        XCTAssertEqual(card.costEstimate, 1.1)
        XCTAssertEqual(card.failReason, "Provider timed out")
    }

    func testSettledApprovalContinuationForcesImmediateHistoryRefresh() {
        XCTAssertFalse(AssistantVM.approvalContinuationNeedsHistoryRefresh(status: nil))
        XCTAssertFalse(AssistantVM.approvalContinuationNeedsHistoryRefresh(status: "running"))
        XCTAssertTrue(AssistantVM.approvalContinuationNeedsHistoryRefresh(status: "done"))
        XCTAssertTrue(AssistantVM.approvalContinuationNeedsHistoryRefresh(status: "idle"))
        XCTAssertTrue(AssistantVM.approvalContinuationNeedsHistoryRefresh(status: "failed"))
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

        XCTAssertTrue(vm.referenceGeneratedImage(generatedRef, variation: false))

        XCTAssertEqual(vm.referencedFileRefs, [generatedRef])
        XCTAssertNil(vm.composerSelectionReference)
        XCTAssertTrue(vm.composerDraft.contains("নতুন edited image তৈরি করুন"))
        XCTAssertTrue(vm.composerDraft.contains("generate_image referenceImageId"))
        XCTAssertTrue(vm.composerDraft.contains("count 1"))
        XCTAssertTrue(vm.composerDraft.contains("approval-এর আগে render করবেন না"))

        vm.removeReferencedFile(generatedRef)

        XCTAssertEqual(vm.composerDraft, "Owner's unrelated unsent draft")
        XCTAssertEqual(vm.referencedFileRefs, [originalRef])
        XCTAssertEqual(vm.composerSelectionReference, "selected draft quote")
    }

    func testGeneratedImageEditAndVariationAreRouteableAndKeepExactSourceRef() {
        let vm = AssistantVM()
        let source = AgentFileRef(
            bucket: "agent-files", path: "generated/source.jpg", mediaType: "image/jpeg")

        XCTAssertTrue(vm.referenceGeneratedImage(source, variation: false))
        XCTAssertEqual(vm.referencedFileRefs, [source])
        XCTAssertTrue(vm.composerDraft.contains("ছবিটিকে reference image"))
        XCTAssertTrue(vm.composerDraft.contains("edited image তৈরি"))
        XCTAssertTrue(vm.composerDraft.contains("referenceImageId"))

        vm.removeReferencedFile(source)
        XCTAssertTrue(vm.referenceGeneratedImage(source, variation: true))
        XCTAssertEqual(vm.referencedFileRefs, [source])
        XCTAssertTrue(vm.composerDraft.contains("visual variation তৈরি"))
        XCTAssertTrue(vm.composerDraft.contains("referenceImageId"))
        XCTAssertTrue(vm.composerDraft.contains("count 4"))
        XCTAssertTrue(vm.composerDraft.contains("চারটি distinct variation"))
        XCTAssertTrue(vm.composerDraft.contains("একটিমাত্র image-generation approval card"))
    }

    func testGeneratedImageEditQueuesSourceAndRestoresOwnerComposer() {
        let vm = AssistantVM()
        let unrelated = AgentFileRef(
            bucket: "agent-files", path: "draft/unrelated.png", mediaType: "image/png")
        let source = AgentFileRef(
            bucket: "agent-files", path: "generated/source.png", mediaType: "image/png")
        vm.composerDraft = "Owner's protected draft"
        vm.referencedFileRefs = [unrelated]
        vm.composerSelectionReference = "protected quote"
        vm.isStreaming = true

        XCTAssertTrue(vm.referenceGeneratedImage(source, variation: false))
        let editText = vm.composerDraft
        vm.send(editText)

        XCTAssertEqual(vm.queuedOwnerMessages.last?.files, [source])
        XCTAssertEqual(
            vm.queuedOwnerMessages.last?.text,
            editText.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        XCTAssertEqual(vm.composerDraft, "Owner's protected draft")
        XCTAssertEqual(vm.referencedFileRefs, [unrelated])
        XCTAssertEqual(vm.composerSelectionReference, "protected quote")

        if let queued = vm.queuedOwnerMessages.last,
           let row = vm.messages.first(where: { $0.clientMessageId == queued.id }) {
            vm.cancelOutgoingMessage(row)
        }
        vm.isStreaming = false
    }

    func testFailedImageWorkerRetryDecodesOneAuthoritativePendingCard() throws {
        let vm = AssistantVM()
        let initialQueueIds = vm.queuedOwnerMessages.map(\.id)
        let originalRef = AgentFileRef(
            bucket: "agent-files", path: "unrelated-draft.png", mediaType: "image/png")
        vm.composerDraft = "Owner's unrelated unsent draft"
        vm.composerSelectionReference = "selected quote"
        vm.referencedFileRefs = [originalRef]
        let response = try JSONDecoder().decode(AgentImageRetryResponseWire.self, from: Data(#"""
        {"success":true,"pendingActionId":"fresh-card","sourceActionId":"failed-card","idempotent":false,
         "action":{"id":"fresh-card","type":"image_gen","status":"pending","summary":"Pinned retry",
          "costEstimate":0.2,"conversationId":"retry-chat","businessId":"owner-business",
          "createdAt":"2026-08-11T10:00:00.000Z","imageModelSelection":{
           "selectedModel":"gpt-image-2","options":[
             {"id":"gpt-image-2","label":"GPT Image 2","provider":"openai","enabled":true,
              "quote":{"version":1,"currency":"USD","kind":"provider_render_estimate","model":"gpt-image-2",
               "provider":"openai","quality":"standard","imageSize":"2K","requestedImages":4,
               "unitPriceUsd":0.05,"minCostUsd":0.2,"maxCostUsd":0.6,"maxPaidGenerationsPerImage":3,
               "pricingBasis":"internal_list_estimate","pricingLastVerifiedAt":"2026-07-12",
               "excludes":["qc_vision","taxes","provider_credits"]}}],
           "quote":{"version":1,"currency":"USD","kind":"provider_render_estimate","model":"gpt-image-2",
            "provider":"openai","quality":"standard","imageSize":"2K","requestedImages":4,
            "unitPriceUsd":0.05,"minCostUsd":0.2,"maxCostUsd":0.6,"maxPaidGenerationsPerImage":3,
            "pricingBasis":"internal_list_estimate","pricingLastVerifiedAt":"2026-07-12",
            "excludes":["qc_vision","taxes","provider_credits"]}}}}
        """#.utf8))

        let action = try XCTUnwrap(response.authoritativeAction(for: "failed-card"))
        XCTAssertEqual(action.id, "fresh-card")
        XCTAssertEqual(action.status, "pending")
        XCTAssertEqual(action.imageModelSelection?.selectedModel, "gpt-image-2")
        XCTAssertNil(response.authoritativeAction(for: "another-source"))
        XCTAssertNotNil(vm.applyFailedImageRetryServerEcho(response, sourceId: "failed-card"))
        XCTAssertTrue(vm.hasRequestedFailedImageRetry("failed-card"))
        XCTAssertEqual(vm.queuedOwnerMessages.map(\.id), initialQueueIds,
                       "direct retry must never manufacture a composer message")
        XCTAssertEqual(vm.composerDraft, "Owner's unrelated unsent draft")
        XCTAssertEqual(vm.composerSelectionReference, "selected quote")
        XCTAssertEqual(vm.referencedFileRefs, [originalRef])
    }

    func testFailedImageWorkerRetryRejectsNonTerminalOrNonImageActions() async {
        let vm = AssistantVM()
        let initialQueueIds = vm.queuedOwnerMessages.map(\.id)
        vm.composerDraft = "Keep this draft"

        let approved = await vm.retryFailedImageGeneration(.init(
            id: "approved-image", summary: "Image", status: "approved",
            actionType: "image_gen", costEstimate: nil))
        let wrongType = await vm.retryFailedImageGeneration(.init(
            id: "failed-email", summary: "Email", status: "failed",
            actionType: "email_send", costEstimate: nil))

        XCTAssertFalse(approved)
        XCTAssertFalse(wrongType)
        XCTAssertEqual(vm.queuedOwnerMessages.map(\.id), initialQueueIds)
        XCTAssertEqual(vm.composerDraft, "Keep this draft")
    }

    func testFailedImageRetryRepeatsOnlyAmbiguousOutcomes() {
        let transport = AlmaAPIError.transport(URLError(.networkConnectionLost))
        let server = AlmaAPIError.http(status: 503, body: "{}")
        let conflict = AlmaAPIError.http(
            status: 409, body: "{\"error\":\"open_card_exists\"}")
        let invalid = AlmaAPIError.http(
            status: 422, body: "{\"error\":\"not_image_action\"}")

        XCTAssertTrue(AssistantVM.shouldRepeatImageRetry(
            after: transport, completedAttempts: 1))
        XCTAssertTrue(AssistantVM.shouldRepeatImageRetry(
            after: server, completedAttempts: 1))
        XCTAssertFalse(AssistantVM.shouldRepeatImageRetry(
            after: transport, completedAttempts: 2),
            "an ambiguous retry may repeat the idempotent POST exactly once")
        XCTAssertFalse(AssistantVM.shouldRepeatImageRetry(
            after: conflict, completedAttempts: 1))
        XCTAssertFalse(AssistantVM.shouldRepeatImageRetry(
            after: invalid, completedAttempts: 1))
    }

    func testServerFailedApprovalRecoveryIsTerminalButUncertainMutationFailureIsNot() {
        XCTAssertFalse(AssistantVM.ActionLifecycleState.failed.isTerminal,
                       "an uncertain decision request must remain checkable")
        XCTAssertNil(AssistantVM.confirmCardStatus(for: .failed))

        let terminal = AssistantVM.lifecycleState(forServerConfirmStatus: "failed")
        XCTAssertEqual(terminal, .serverFailed)
        XCTAssertTrue(terminal?.isTerminal == true)
        XCTAssertEqual(AssistantVM.confirmCardStatus(for: .serverFailed), "failed",
                       "a stale pending wire card must project the durable worker failure")
        XCTAssertEqual(AssistantVM.lifecycleState(forServerConfirmStatus: "executing"), .executing)
        XCTAssertNil(AssistantVM.lifecycleState(forServerConfirmStatus: "invented-status"))
    }

    func testImageApprovalCardPresentationTracksEveryWorkerStateTruthfully() {
        let pending = AgentConfirmCardPresentation.resolve(
            status: "pending", actionType: "image_gen")
        XCTAssertEqual(pending.title, "এই ছবিটি তৈরি করব?")
        XCTAssertTrue(pending.showsDecisionControls)
        XCTAssertFalse(pending.showsRenderProgress)

        let approved = AgentConfirmCardPresentation.resolve(
            status: "approved", actionType: "image_gen")
        XCTAssertEqual(approved.title, "ছবি তৈরির অনুমোদন হয়েছে")
        XCTAssertFalse(approved.showsDecisionControls)
        XCTAssertTrue(approved.showsRenderProgress)

        for status in ["preview_approved", "generating", "executing"] {
            let active = AgentConfirmCardPresentation.resolve(
                status: status, actionType: "image_gen")
            XCTAssertEqual(active.title, "ছবি তৈরি হচ্ছে")
            XCTAssertTrue(active.showsRenderProgress)
            XCTAssertFalse(active.showsDecisionControls)
        }
        XCTAssertEqual(
            AssistantVM.lifecycleState(forServerConfirmStatus: "preview_approved"),
            .approved)

        let failed = AgentConfirmCardPresentation.resolve(
            status: "failed", actionType: "image_gen")
        XCTAssertEqual(failed.title, "ছবি তৈরি ব্যর্থ হয়েছে")
        XCTAssertTrue(failed.showsFailedImageRetry)
        XCTAssertFalse(failed.showsDecisionControls)

        let rejected = AgentConfirmCardPresentation.resolve(
            status: "rejected", actionType: "image_gen")
        XCTAssertEqual(rejected.title, "ছবি তৈরি বাতিল হয়েছে")
        XCTAssertFalse(rejected.showsDecisionControls)

        let executed = AgentConfirmCardPresentation.resolve(
            status: "executed", actionType: "image_gen")
        XCTAssertEqual(executed.title, "ছবি প্রস্তুত")
        XCTAssertEqual(executed.tone, .teal)
        XCTAssertFalse(executed.showsRenderProgress)
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

    func testRegenerateReplaysAcceptedRowWithoutConsumingComposerContext() {
        let vm = AssistantVM()
        vm.conversationId = "regenerate-conversation"
        vm.composerDraft = "Unsent future request"
        vm.composerSelectionReference = "Draft-only selection"
        let draftRef = AgentFileRef(bucket: "agent", path: "draft.png", mediaType: "image/png")
        let originalRef = AgentFileRef(bucket: "agent", path: "original.png", mediaType: "image/png")
        vm.referencedFileRefs = [draftRef]
        var accepted = AgentChatMessage(id: "accepted", role: .user, text: "Original accepted prompt")
        accepted.fileRefs = [originalRef]

        let replay = AssistantVM.acceptedPromptReplay(for: accepted)

        XCTAssertEqual(vm.composerDraft, "Unsent future request")
        XCTAssertEqual(vm.composerSelectionReference, "Draft-only selection")
        XCTAssertEqual(vm.referencedFileRefs, [draftRef])
        XCTAssertEqual(replay?.text, "Original accepted prompt")
        XCTAssertEqual(replay?.files, [originalRef])
        XCTAssertFalse(replay?.text.contains("Draft-only selection") ?? true)
    }

    func testEditAndResendSuspendsAndRestoresTheOwnersExistingDraft() {
        let vm = AssistantVM()
        vm.composerDraft = "Keep this unsent draft"
        vm.composerSelectionReference = "Keep this selection"
        let draftRef = AgentFileRef(bucket: "agent", path: "draft.png", mediaType: "image/png")
        let replayRef = AgentFileRef(bucket: "agent", path: "accepted.png", mediaType: "image/png")
        vm.referencedFileRefs = [draftRef]
        var accepted = AgentChatMessage(id: "accepted-edit", role: .user, text: "Accepted prompt")
        accepted.fileRefs = [replayRef]

        vm.editAcceptedPrompt(accepted)

        XCTAssertTrue(vm.hasSuspendedComposerContext)
        XCTAssertEqual(vm.composerDraft, "Accepted prompt")
        XCTAssertNil(vm.composerSelectionReference)
        XCTAssertEqual(vm.referencedFileRefs, [replayRef])

        vm.cancelPreparedComposerReplay()

        XCTAssertFalse(vm.hasSuspendedComposerContext)
        XCTAssertEqual(vm.composerDraft, "Keep this unsent draft")
        XCTAssertEqual(vm.composerSelectionReference, "Keep this selection")
        XCTAssertEqual(vm.referencedFileRefs, [draftRef])
    }

    func testOwnerMessageActionsNeverPresentSettledSendAsRetry() {
        XCTAssertTrue(AgentChatMessage.showsAcceptedPromptActions(for: nil),
                      "legacy/cold settled owner rows remain editable")
        XCTAssertTrue(AgentChatMessage.showsAcceptedPromptActions(for: .accepted))

        let settledOrInFlight: [AgentChatMessage.OutgoingState?] = [
            nil, .accepted, .awaitingAgent, .delivered, .submitting, .checking, .cancelled,
        ]
        XCTAssertTrue(settledOrInFlight.allSatisfy {
            !AgentChatMessage.showsOutgoingRecoveryActions(for: $0)
        }, "accepted, delivered, or still-verifying sends must never show retry")

        let unsent: [AgentChatMessage.OutgoingState] = [
            .waitingForAttachments, .queued, .failed,
        ]
        XCTAssertTrue(unsent.allSatisfy {
            AgentChatMessage.showsOutgoingRecoveryActions(for: $0)
        }, "only durable unsent/failed recovery states expose retry")
        XCTAssertTrue(unsent.allSatisfy {
            !AgentChatMessage.showsAcceptedPromptActions(for: $0)
        })
    }

    func testAcceptedReplayWithIdenticalTextCannotClearTheRestoredOwnerDraft() {
        let vm = AssistantVM()
        let identicalText = "Keep this exact owner draft"
        vm.composerDraft = identicalText
        let accepted = AgentChatMessage(
            id: "accepted-identical", role: .user, text: identicalText)

        // Edit & resend temporarily mounts the accepted prompt. A successful
        // replay claims only that staged composer, then the protected owner draft
        // is restored — even when its bytes are identical to the replay.
        vm.editAcceptedPrompt(accepted)
        let replayClientMessageId = "replay-\(UUID().uuidString)"
        vm.debugClaimComposerDraftOwnership(clientMessageId: replayClientMessageId)
        vm.cancelPreparedComposerReplay()
        XCTAssertNil(vm.debugComposerDraftOwnerClientMessageId)

        vm.messages.append(AgentChatMessage(
            id: "local-\(replayClientMessageId)", role: .user,
            clientMessageId: replayClientMessageId, outgoingState: .submitting,
            text: identicalText))
        vm.debugMarkActionContinuationAccepted(clientMessageId: replayClientMessageId)

        XCTAssertEqual(vm.composerDraft, identicalText)
    }

    func testAcceptedComposerOwnedSendClearsOnlyItsClaimedDraft() {
        let vm = AssistantVM()
        let clientMessageId = "composer-\(UUID().uuidString)"
        vm.composerDraft = "This draft belongs to this send"
        vm.debugClaimComposerDraftOwnership(clientMessageId: clientMessageId)
        vm.messages.append(AgentChatMessage(
            id: "local-\(clientMessageId)", role: .user,
            clientMessageId: clientMessageId, outgoingState: .submitting,
            text: vm.composerDraft))
        let oldClearEpoch = vm.composerClearEpoch

        vm.debugMarkActionContinuationAccepted(clientMessageId: clientMessageId)

        XCTAssertEqual(vm.composerDraft, "")
        XCTAssertEqual(vm.composerClearEpoch, oldClearEpoch + 1)
        XCTAssertNil(vm.debugComposerDraftOwnerClientMessageId)
    }

    func testModelReplayAndPromptForkTruthfullyStartANewChat() {
        XCTAssertEqual(
            AssistantVM.acceptedPromptReplayTarget(withModel: nil, fork: false),
            .sameChatAppend)
        XCTAssertEqual(
            AssistantVM.acceptedPromptReplayTarget(withModel: "gpt-5.6-luna", fork: false),
            .newChat)
        XCTAssertEqual(
            AssistantVM.acceptedPromptReplayTarget(withModel: nil, fork: true),
            .newChat)
    }

    func testProjectInstructionsPatchUsesOnlyTheExistingScopedField() throws {
        let patch = AgentProjectInstructionsPatch(systemInstructions: "Keep replies concise")
        let data = try JSONEncoder().encode(patch)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(Set(json.keys), ["systemInstructions"])
        XCTAssertEqual(json["systemInstructions"] as? String, "Keep replies concise")

        let clearData = try JSONEncoder().encode(
            AgentProjectInstructionsPatch(systemInstructions: ""))
        let clearJSON = try XCTUnwrap(
            JSONSerialization.jsonObject(with: clearData) as? [String: Any])
        XCTAssertEqual(clearJSON["systemInstructions"] as? String, "")
    }

    func testNewChatProjectPickerKeepsSelectionLocalForTheFirstChatRequest() async throws {
        let vm = AssistantVM()
        let projectId = "first-turn-project-\(UUID().uuidString)"
        XCTAssertNil(vm.conversationId)

        // With no server conversation row, this must complete locally instead of
        // attempting the existing-conversation PATCH endpoint.
        let selectedLocally = await vm.assignConversationProject(projectId)
        XCTAssertTrue(selectedLocally)
        XCTAssertEqual(vm.currentProjectId, projectId)

        let body = AssistantVM.ChatBody(
            conversationId: nil, message: "Start in this project", files: [],
            modelId: "auto", projectId: vm.currentProjectId)
        let data = try JSONEncoder().encode(body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["projectId"] as? String, projectId,
                       "the existing /chat first-turn contract must carry the local selection")

        let clearedLocally = await vm.assignConversationProject(nil)
        XCTAssertTrue(clearedLocally)
        XCTAssertNil(vm.currentProjectId)
    }

    func testReservedPersonalProjectCannotExposeInstructionsEditor() {
        let marker = AgentProject(
            id: "personal-marker", name: "My space", description: nil,
            systemInstructions: "__PERSONAL_MODE__", businessId: nil)
        let english = AgentProject(
            id: "personal-name", name: "Personal", description: nil,
            systemInstructions: nil, businessId: nil)
        let bangla = AgentProject(
            id: "personal-bn", name: "ব্যক্তিগত", description: nil,
            systemInstructions: nil, businessId: nil)
        let ordinary = AgentProject(
            id: "project", name: "Launch", description: nil,
            systemInstructions: "Use launch context", businessId: nil)

        XCTAssertFalse(marker.canEditProjectInstructions)
        XCTAssertFalse(english.canEditProjectInstructions)
        XCTAssertFalse(bangla.canEditProjectInstructions)
        XCTAssertTrue(ordinary.canEditProjectInstructions)
    }

    func testArtifactPresentationUsesTypeAwarePreviewMimeAndFilename() {
        let markdown = AgentArtifactPresentation.resolve(type: "markdown", content: "# Ready")
        let code = AgentArtifactPresentation.resolve(type: "code", content: "let ready = true")
        let html = AgentArtifactPresentation.resolve(type: "html", content: "<html></html>")
        let svg = AgentArtifactPresentation.resolve(type: "svg", content: "<svg></svg>")

        XCTAssertEqual(markdown.mode, .markdown)
        XCTAssertEqual(markdown.mediaType, "text/markdown")
        XCTAssertEqual(markdown.filename(title: "Launch.txt"), "Launch.md")
        XCTAssertEqual(code.mode, .code)
        XCTAssertEqual(code.filename(title: "Example.md"), "Example.txt")
        XCTAssertEqual(html.mode, .quickLook)
        XCTAssertEqual(html.mediaType, "text/html")
        XCTAssertEqual(html.filename(title: "Dashboard"), "Dashboard.html")
        XCTAssertEqual(svg.mode, .quickLook)
        XCTAssertEqual(svg.mediaType, "image/svg+xml")
        XCTAssertEqual(svg.filename(title: "Flow.txt"), "Flow.svg")
    }

    func testArtifactPresentationSniffsOnlyLegacyHTMLAndSVGFallbacks() {
        XCTAssertEqual(
            AgentArtifactPresentation.resolve(type: nil, content: "<!doctype html><html></html>").mode,
            .quickLook)
        XCTAssertEqual(
            AgentArtifactPresentation.resolve(type: "", content: "<svg viewBox='0 0 1 1'></svg>")
                .fileExtension,
            "svg")
        let unknown = AgentArtifactPresentation.resolve(type: "future-type", content: "raw")
        XCTAssertEqual(unknown.mode, .rawText)
        XCTAssertEqual(unknown.mediaType, "text/plain")
        XCTAssertEqual(unknown.fileExtension, "txt")
    }

    func testArtifactStringContentIsNotPretendedToBeImageOrPDFBinary() {
        let image = AgentArtifactPresentation.resolve(
            type: "image", content: "https://example.com/generated.jpg")
        let pdf = AgentArtifactPresentation.resolve(
            type: "pdf", content: "This is report source, not PDF bytes")

        XCTAssertEqual(image.mode, .rawText)
        XCTAssertEqual(image.mediaType, "text/plain")
        XCTAssertEqual(image.fileExtension, "txt")
        XCTAssertEqual(pdf.mode, .rawText)
        XCTAssertEqual(pdf.mediaType, "text/plain")
        XCTAssertEqual(pdf.fileExtension, "txt")
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

    func testPlanDrivePanelUsesAuthoritativeServerStateInsteadOfArrayMembership() throws {
        let data = Data(#"""
        {
          "enabled": true,
          "runningCount": 1,
          "waitingApprovalCount": 1,
          "activeCount": 2,
          "needsDecisionCount": 1,
          "dailyCapTaka": 250,
          "perPlanCapTaka": 50,
          "drives": [
            {
              "planId": "running",
              "goal": "Courier reconcile",
              "phase": "driving",
              "isRunning": true,
              "statusLabel": "চলছে",
              "runningStep": "Ledger যাচাই",
              "idleMs": 0
            },
            {
              "planId": "parked",
              "goal": "Ads report",
              "autodriveState": "escalated",
              "phase": "driving",
              "isRunning": false,
              "statusLabel": "আপনার সিদ্ধান্ত দরকার",
              "idleMs": 120000
            }
          ],
          "runningJobs": [
            {
              "actionId": "job-seo-1",
              "type": "seo_audit",
              "summary": "SEO audit: almatraders.com",
              "startedAt": "2026-08-11T10:00:00.000Z",
              "runningMs": 480000,
              "conversationId": "conversation-1"
            }
          ]
        }
        """#.utf8)

        let panel = try JSONDecoder().decode(AgentPlanDrivePanel.self, from: data)
        XCTAssertEqual(panel.honestPlanRunningCount, 1)
        XCTAssertEqual(panel.honestRunningCount, 2)
        XCTAssertEqual(panel.honestPlanActiveCount, 2)
        XCTAssertEqual(panel.honestActiveCount, 3)
        XCTAssertEqual(panel.ownerAttentionCount(mergedApprovalCount: 1), 2)

        let job = try XCTUnwrap(panel.runningJobs?.first)
        XCTAssertEqual(job.actionId, "job-seo-1")
        XCTAssertEqual(job.type, "seo_audit")
        XCTAssertEqual(job.summary, "SEO audit: almatraders.com")
        XCTAssertEqual(job.startedAt, "2026-08-11T10:00:00.000Z")
        XCTAssertEqual(job.runningMs, 480_000)
        XCTAssertEqual(job.conversationId, "conversation-1")

        let parked = try XCTUnwrap(panel.drives?.first { $0.planId == "parked" })
        XCTAssertFalse(parked.truthfullyRunning)
        XCTAssertTrue(parked.needsRecoveryDecision)
        XCTAssertEqual(parked.ownerStatusLabel, "আপনার সিদ্ধান্ত দরকার")
        XCTAssertEqual(parked.idleMs, 120_000)
    }

    func testMasterAgentControlDecodesPausedFromExistingFullContract() throws {
        let data = Data(#"""
        {
          "paused": true,
          "autonomy": "ask",
          "capabilities": { "web": true, "app": true, "telegram": true }
        }
        """#.utf8)

        let controls = try JSONDecoder().decode(AgentMasterControlState.self, from: data)
        XCTAssertTrue(controls.paused)
    }

    func testMasterAgentControlReadGateRejectsPrePatchAndBusyReads() {
        var gate = AgentMasterControlReadGate()
        let prePatchRead = gate.generation

        gate.invalidateInFlightReads()
        XCTAssertFalse(gate.shouldApply(
            readGeneration: prePatchRead, mutationBusy: false),
            "a GET started before PATCH must not replace the PATCH echo")

        let currentRead = gate.generation
        XCTAssertFalse(gate.shouldApply(
            readGeneration: currentRead, mutationBusy: true),
            "even a current GET must wait while PATCH owns the state")
        XCTAssertTrue(gate.shouldApply(
            readGeneration: currentRead, mutationBusy: false))
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

    func testSignedFileRetryInvalidatesOnlyTheTransientURLCacheEntry() {
        let vm = AssistantVM()
        var answer = AgentChatMessage(id: "answer", role: .assistant, text: "Your files")
        answer.fileRefs = [
            .init(bucket: "agent-files", path: "reports/stale.pdf", mediaType: "application/pdf"),
            .init(bucket: "agent-files", path: "reports/healthy.pdf", mediaType: "application/pdf"),
        ]
        vm.messages = [answer]
        vm.signedURLs = [
            "reports/stale.pdf": URL(string: "https://files.example/stale-token")!,
            "reports/healthy.pdf": URL(string: "https://files.example/healthy-token")!,
        ]
        let originalMessages = vm.messages

        vm.invalidateSignedURL(for: "reports/stale.pdf")

        XCTAssertNil(vm.signedURLs["reports/stale.pdf"])
        XCTAssertEqual(vm.signedURLs["reports/healthy.pdf"]?.absoluteString,
                       "https://files.example/healthy-token")
        XCTAssertEqual(vm.messages, originalMessages,
                       "retrying a signed download must not remove or rewrite the chat file card")
    }

    func testConversationMenuExposesLibraryAndManagementContract() {
        let hooks = AssistantBarHooks()
        hooks.isPinned = { false }
        hooks.hasProject = { false }
        hooks.canMutateConversation = { true }

        func titles(_ elements: [UIMenuElement]) -> [String] {
            elements.flatMap { element -> [String] in
                if let menu = element as? UIMenu {
                    return (menu.title.isEmpty ? [] : [menu.title]) + titles(menu.children)
                }
                return [element.title]
            }
        }

        let resolved = titles(hooks.resolvedConversationMenuSections())
        XCTAssertTrue(resolved.contains("Uploaded files"))
        XCTAssertTrue(resolved.contains("Search in this chat"))
        XCTAssertTrue(resolved.contains("Export"))
        XCTAssertTrue(resolved.contains("Plain text"))
        XCTAssertTrue(resolved.contains("Markdown"))
        XCTAssertTrue(resolved.contains("PDF"))
        XCTAssertTrue(resolved.contains("Rename"))
        XCTAssertTrue(resolved.contains("Archive"))
        XCTAssertTrue(resolved.contains("Delete"))
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

    func testPinnedSkillRawToolEnvelopeIsSplitWithoutLosingHumanPrefix() {
        let streamed = #"বস, তিনটি variation তৈরি করছি। [{"type":"tool_use","name":"generate_image","input":{"count":3}}]"#

        guard let split = AgentChatMessage.splitStreamedRawToolEnvelope(
            streamed, skillPinned: true) else {
            return XCTFail("an obvious pinned-skill tool envelope must be quarantined")
        }

        XCTAssertEqual(split.visible, "বস, তিনটি variation তৈরি করছি। ")
        XCTAssertEqual(
            split.suppressed,
            #"[{"type":"tool_use","name":"generate_image","input":{"count":3}}]"#)
    }

    func testPartialToolUseEnvelopeIsHeldAcrossProviderChunkBoundary() {
        let partial = #"ছবি তৈরি করছি। [{"type":"tool_"#

        let split = AgentChatMessage.splitStreamedRawToolEnvelope(
            partial, skillPinned: true)

        XCTAssertEqual(split?.visible, "ছবি তৈরি করছি। ")
        XCTAssertEqual(split?.suppressed, #"[{"type":"tool_"#)
    }

    func testOrdinaryJSONAndMarkdownCodeAreNeverSuppressed() {
        XCTAssertNil(AgentChatMessage.splitStreamedRawToolEnvelope(
            #"{"type":"chart","name":"sales","input":{"period":"today"}}"#,
            skillPinned: true))
        XCTAssertNil(AgentChatMessage.splitStreamedRawToolEnvelope(
            #"""
            ```json
            {"type":"tool_use","name":"generate_image","input":{}}
            ```
            """#,
            skillPinned: true))
        XCTAssertNotNil(AgentChatMessage.splitStreamedRawToolEnvelope(
            #"{"type":"tool_use","name":"generate_image","input":{}}"#,
            skillPinned: false),
            "a complete typed envelope is never owner-facing prose even without a skill pin")
    }

    func testRawToolEnvelopeDetectionAllowsProviderKeyOrderWithoutHidingNormalJSON() {
        let reordered = #"prefix [{"id":"call-1","name":"generate_image","type":"tool_use","input":{"count":1}}]"#
        let split = AgentChatMessage.splitStreamedRawToolEnvelope(
            reordered, skillPinned: false)

        XCTAssertEqual(split?.visible, "prefix ")
        XCTAssertTrue(split?.suppressed.contains(#""id":"call-1""#) == true)
        XCTAssertNil(AgentChatMessage.splitStreamedRawToolEnvelope(
            #"{"id":"chart-1","type":"chart","data":[1,2]}"#,
            skillPinned: false))
    }

    func testLiveReducerNeverPublishesRawToolEnvelopeBeforeTypedToolStart() {
        let vm = AssistantVM()
        vm.debugApplyTurnEvents([.skillPinned(
            skill: "alma-image-generation", source: "router",
            reason: "image generation", isolated: true)])
        vm.debugApplyTurnEvents([.textDelta(
            #"বস, variation তৈরি করছি। [{"type":"tool_"#)])
        vm.debugApplyTurnEvents([.textDelta(
            #"use","name":"generate_image","input":{"count":3}}]"#)])

        guard let live = vm.messages.last else { return XCTFail("missing live turn") }
        XCTAssertEqual(live.text, "বস, variation তৈরি করছি। ")
        XCTAssertTrue(live.suppressedRawToolEnvelope?.contains("generate_image") == true)
        XCTAssertFalse(live.blocks.contains { block in
            if case .prose(_, let text) = block { return text.contains("tool_use") }
            return false
        })

        vm.debugApplyTurnEvents([.toolStart(
            id: "tool-image", name: "generate_image", inputPretty: #"{"count":3}"#)])

        guard let afterStart = vm.messages.last else { return XCTFail("missing typed tool turn") }
        XCTAssertNil(afterStart.suppressedRawToolEnvelope)
        XCTAssertTrue(afterStart.timeline.contains { entry in
            if case .tool(let id, let name, _, _, _, _, _) = entry {
                return id == "tool-image" && name == "generate_image"
            }
            return false
        }, "typed tool chronology must remain authoritative")
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

    func testMarkdownLinkRouterUsesNativeALMAPathAndSafeExternalBrowserDestination() {
        let relative = URL(string: "/agent/costs?range=30d")!
        XCTAssertEqual(
            AgentMarkdownLinkRouter.destination(for: relative),
            .almaPath("/agent/costs?range=30d"))

        let sameHost = URL(string: "/orders/42", relativeTo: AssistantNet.base)!.absoluteURL
        XCTAssertEqual(
            AgentMarkdownLinkRouter.destination(for: sameHost),
            .almaPath("/orders/42"))

        let external = URL(string: "https://openai.com/research")!
        XCTAssertEqual(
            AgentMarkdownLinkRouter.destination(for: external),
            .external(external))
        let spoofed = URL(string: "https://evilalma-erp-six.vercel.app/agent")!
        XCTAssertEqual(
            AgentMarkdownLinkRouter.destination(for: spoofed),
            .external(spoofed), "a hostname suffix must not enter ALMA native routing")
        XCTAssertNil(AgentMarkdownLinkRouter.destination(
            for: URL(string: "javascript:alert(1)")!))
        XCTAssertNil(AgentMarkdownLinkRouter.destination(
            for: URL(string: "//evil.example/agent")!))
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

    func testClaimLocusCitationIDsUseStableResponseWideNumbers() {
        let firstClaim = """
        প্রথম claim [OpenAI research](https://openai.com/research?publishedAt=2026-08-09) সমর্থন করে।
        """
        let unsupportedClaim = "এই paragraph-এ কোনো citation নেই।"
        let secondClaim = """
        দ্বিতীয় claim [ALMA Costs](/agent/costs) সমর্থন করে; [video](https://example.com/demo.mp4) evidence নয়।
        """
        let repeatedFirstSource = """
        তৃতীয় claim একই [OpenAI source](https://openai.com/research?publishedAt=2026-08-09) আবার ব্যবহার করে।
        """
        let response = [firstClaim, unsupportedClaim, secondClaim, repeatedFirstSource]
            .joined(separator: "\n\n")
        let citations = AgentMarkdownText.extractCitations(response)

        XCTAssertEqual(citations.map(\.id), [1, 2])
        XCTAssertEqual(citations.map(\.title), ["OpenAI research", "ALMA Costs"])
        XCTAssertEqual(AgentMarkdownText.citationIDs(in: firstClaim, from: citations), [1])
        XCTAssertEqual(AgentMarkdownText.citationIDs(in: unsupportedClaim, from: citations), [])
        XCTAssertEqual(AgentMarkdownText.citationIDs(in: secondClaim, from: citations), [2])
        XCTAssertEqual(AgentMarkdownText.citationIDs(in: repeatedFirstSource, from: citations), [1])
    }

    func testRichOutputFileRefsSurviveCanonicalColdLoad() throws {
        let data = #"{"id":"rich","role":"assistant","content":[{"type":"text","text":"ready"},{"type":"file_ref","bucket":"agent-files","path":"one.jpg","mediaType":"image/jpeg"},{"type":"file_ref","bucket":"agent-files","path":"two.jpg","mediaType":"image/jpeg"}],"tokensIn":10,"tokensOut":5,"costUsd":0.04}"#.data(using: .utf8)!
        let message = AgentChatMessage.from(try JSONDecoder().decode(AgentMessageWire.self, from: data))
        XCTAssertEqual(message.fileRefs.count, 2)
        XCTAssertEqual(message.imagePaths, ["one.jpg", "two.jpg"])
        XCTAssertEqual(message.costUsd, "0.0400")
    }

    func testColdLoadedOwnerAttachmentContextMatchesTheLiveAuthoredBubble() throws {
        let data = Data(#"""
        {"id":"owner-files","clientMessageId":"owner-request","role":"user","content":[
          {"type":"file_ref","bucket":"agent-files","path":"general/one.jpg","mediaType":"image/jpeg"},
          {"type":"file_ref","bucket":"agent-files","path":"general/two.jpg","mediaType":"image/jpeg"},
          {"type":"text","text":"[Uploaded file path for tools: general/one.jpg]\n[Uploaded file path for tools: general/two.jpg]"},
          {"type":"text","text":"এই ২টি ছবিকে Image 1 ও Image 2 নামে compare করো।"},
          {"type":"text","text":"[সংযুক্ত ছবি/ফাইল Gemini Vision দিয়ে পড়া হয়েছে — নিচের বিবরণ ব্যবহার করে বসকে উত্তর দাও:\n[ফাইল 1] internal transcript\n[ফাইল 2] internal transcript]"}
        ]}
        """#.utf8)

        let message = AgentChatMessage.from(
            try JSONDecoder().decode(AgentMessageWire.self, from: data))

        XCTAssertEqual(message.text, "এই ২টি ছবিকে Image 1 ও Image 2 নামে compare করো।")
        XCTAssertEqual(message.fileRefs.map(\.path), ["general/one.jpg", "general/two.jpg"])
        XCTAssertFalse(message.text.contains("Uploaded file path"))
        XCTAssertFalse(message.text.contains("internal transcript"))

        let literalWithoutAttachment = Data(#"""
        {"id":"literal","role":"user","content":[
          {"type":"text","text":"[Uploaded file path for tools: example.jpg]"}
        ]}
        """#.utf8)
        let literal = AgentChatMessage.from(
            try JSONDecoder().decode(AgentMessageWire.self, from: literalWithoutAttachment))
        XCTAssertEqual(literal.text, "[Uploaded file path for tools: example.jpg]")
    }

    func testAssistantNonImageFileProjectionCoversMediaAndKeepsContractOrder() throws {
        let data = Data(#"""
        {"id":"rich-files","role":"assistant","content":[
          {"type":"file_ref","bucket":"agent-files","path":"generated/poster.jpg","mediaType":"image/jpeg"},
          {"type":"file_ref","bucket":"agent-files","path":"generated/voice%20note.m4a","mediaType":"audio/mp4"},
          {"type":"file_ref","bucket":"agent-files","path":"generated/demo.mp4","mediaType":"video/mp4"},
          {"type":"file_ref","bucket":"agent-files","path":"generated/brief.pdf","mediaType":"application/pdf"},
          {"type":"file_ref","bucket":"agent-files","path":"generated/archive.bin","mediaType":"application/octet-stream"},
          {"type":"file_ref","bucket":"agent-files","path":"generated/demo.mp4","mediaType":"video/mp4"}
        ]}
        """#.utf8)
        let message = AgentChatMessage.from(
            try JSONDecoder().decode(AgentMessageWire.self, from: data))

        let projected = almaOrderedUniqueNonImageFileRefs(message.fileRefs)

        XCTAssertEqual(projected.map(\.path), [
            "generated/voice%20note.m4a", "generated/demo.mp4",
            "generated/brief.pdf", "generated/archive.bin",
        ])
        XCTAssertEqual(AgentInlineFileMetadata.resolve(projected[0]), .init(
            name: "voice note.m4a", typeLabel: "Audio", systemImage: "waveform"))
        XCTAssertEqual(AgentInlineFileMetadata.resolve(projected[1]).typeLabel, "Video")
        XCTAssertEqual(AgentInlineFileMetadata.resolve(projected[2]).typeLabel, "PDF")
        XCTAssertEqual(AgentInlineFileMetadata.resolve(projected[3]).typeLabel, "BIN")
    }

    func testSettledImageAndFileOnlyTurnKeepsRealCostFooterWithoutInventingOne() {
        var richOnly = AgentChatMessage(id: "rich-only", role: .assistant)
        richOnly.fileRefs = [
            .init(bucket: "agent-files", path: "generated/poster.jpg", mediaType: "image/jpeg"),
            .init(bucket: "agent-files", path: "generated/brief.pdf", mediaType: "application/pdf"),
        ]
        richOnly.tokensIn = 120
        richOnly.tokensOut = 8
        richOnly.costUsd = "0.0400"

        XCTAssertTrue(AgentMessageActions.shouldRenderFooter(for: richOnly))

        richOnly.tokensIn = nil
        richOnly.tokensOut = nil
        richOnly.costUsd = nil
        XCTAssertFalse(AgentMessageActions.shouldRenderFooter(for: richOnly),
                       "rich UI alone must not invent a zero-cost footer")

        richOnly.costUsd = "0"
        XCTAssertTrue(AgentMessageActions.shouldRenderFooter(for: richOnly),
                      "an explicitly reported zero-cost turn still owns its footer")
        richOnly.costUsd = nil
        richOnly.tokensIn = 0
        richOnly.tokensOut = 0
        XCTAssertTrue(AgentMessageActions.shouldRenderFooter(for: richOnly),
                      "authoritative zero-token metadata is presence, not absence")
        richOnly.tokensIn = nil
        richOnly.tokensOut = nil
        richOnly.costUsd = "0.0400"
        XCTAssertTrue(AgentMessageActions.shouldRenderFooter(for: richOnly),
                      "a server-reported positive cost is sufficient without prose")
        richOnly.isStreaming = true
        XCTAssertFalse(AgentMessageActions.shouldRenderFooter(for: richOnly))
    }

    func testSyntaxHighlighterPreservesSourceText() {
        let source = "let amount = 5000 // whole taka"
        XCTAssertEqual(String(AgentSyntaxHighlighter.highlight(source, language: "swift").characters), source)
    }
}
