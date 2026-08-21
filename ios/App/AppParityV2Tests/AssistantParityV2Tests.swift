import AVFoundation
import SwiftUI
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
        guard case .confirmCard(let id, _, let type, _, let selection, _) = AgentTurnEvent(dto: dto) else {
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
        guard case .confirmCard(let liveId, let summary, _, _, let selection, _) =
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

    func testLiveAcousticRouteClassificationUsesActualOutputNotSpeakerPreference() {
        XCTAssertEqual(
            AlmaLiveVoiceAcousticOutputClass.classify([.builtInSpeaker]),
            .exposedLoudspeaker)
        for privateOrExternal in [
            AVAudioSession.Port.builtInReceiver,
            .headphones,
            .bluetoothHFP,
            .bluetoothA2DP,
            .airPlay,
            .carAudio,
            .HDMI,
            .usbAudio,
        ] {
            let route = AlmaLiveVoiceAcousticOutputClass.classify([privateOrExternal])
            XCTAssertEqual(route, .privateOrExternal, "unexpected exposed route: \(privateOrExternal)")
            XCTAssertFalse(route.needsNoAECProtection(voiceProcessingUnavailable: true))
        }
        XCTAssertTrue(AlmaLiveVoiceAcousticOutputClass.exposedLoudspeaker
            .needsNoAECProtection(voiceProcessingUnavailable: true))
        XCTAssertFalse(AlmaLiveVoiceAcousticOutputClass.exposedLoudspeaker
            .needsNoAECProtection(voiceProcessingUnavailable: false))
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
        recorder.recordInputWithheldByPolicy(
            .playbackTailRetained,
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
                        .noAECEchoGuard, .playbackTailSuppression])
        XCTAssertEqual(events.filter { $0.name == .audioWithheldByPolicy }.map(\.retention),
                       [.boundedPreRoll, .boundedPreRoll, .discarded, .boundedPreRoll,
                        .boundedPreRoll])
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
            "previewSource", "contextTriggerTokens", "contextTargetTokens",
            "observedContextTokens",
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

    func testLiveVoiceEvidenceSeparatesPreviewCompressionAndTransportResumption() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest,
            previewSource: .disk)
        recorder.recordContextCompressionConfigured(
            triggerTokens: 25_000,
            targetTokens: 8_000)
        recorder.recordContextCompressionThresholdObserved(
            observedTokens: 24_999,
            triggerTokens: 25_000,
            targetTokens: 8_000)
        recorder.recordContextCompressionThresholdObserved(
            observedTokens: 25_000,
            triggerTokens: 25_000,
            targetTokens: 8_000)
        recorder.recordContextCompressionThresholdObserved(
            observedTokens: 40_000,
            triggerTokens: 25_000,
            targetTokens: 8_000)
        let generation = recorder.beginTransportAttempt(resuming: true)
        recorder.recordTransportEvent(.resumptionAccepted, generation: generation)

        // Deterministically exceed the production ledger cap. These ordinary
        // lifecycle observations must roll over while the fixed cross-phase
        // milestones remain distinguishable in the same encoded artifact.
        for index in 0..<625 {
            recorder.recordLifecycleEvent(
                index.isMultiple(of: 2) ? .appBackgrounded : .appBecameActive)
        }

        let artifact = try recorder.encodedReport()
        let events = try JSONDecoder().decode(
            AlmaLiveVoiceEvidenceReport.self,
            from: artifact).events
        XCTAssertEqual(events.count, 600, "runtime evidence must remain strictly bounded")
        XCTAssertGreaterThan(
            try XCTUnwrap(events.last?.sequence),
            events.count,
            "a sequence beyond the cap proves deterministic FIFO rollover occurred")
        let preview = try XCTUnwrap(events.first { $0.name == .previewAssetResolved })
        XCTAssertEqual(preview.previewSource, .disk)
        let configured = try XCTUnwrap(events.first {
            $0.name == .contextCompressionConfigured
        })
        XCTAssertEqual(configured.contextTriggerTokens, 25_000)
        XCTAssertEqual(configured.contextTargetTokens, 8_000)
        let threshold = events.filter {
            $0.name == .contextCompressionThresholdObserved
        }
        XCTAssertEqual(threshold.count, 1, "one session records the first crossing only")
        let thresholdEvent = try XCTUnwrap(threshold.first)
        XCTAssertEqual(thresholdEvent.observedContextTokens, 25_000)
        let resumed = try XCTUnwrap(events.first { $0.name == .resumptionAccepted })
        XCTAssertEqual(resumed.transportGeneration, generation)
        XCTAssertEqual(
            Set([preview.sequence, configured.sequence,
                 thresholdEvent.sequence, resumed.sequence]).count,
            4,
            "preview, compression, threshold, and resumption must remain separate milestones")
        XCTAssertNotEqual(
            AlmaLiveVoiceEvidenceEventName.previewAssetResolved.rawValue,
            AlmaLiveVoiceEvidenceEventName.contextCompressionThresholdObserved.rawValue)
        XCTAssertNotEqual(
            AlmaLiveVoiceEvidenceEventName.contextCompressionThresholdObserved.rawValue,
            AlmaLiveVoiceEvidenceEventName.resumptionAccepted.rawValue)
    }

    func testLiveVoiceEvidenceRecordsToolExecutionThroughAudibleResultInOrder() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)
        let generation = recorder.beginTransportAttempt(resuming: false)
        recorder.recordProviderActivityObserved(generation: generation)
        let ordinal = try XCTUnwrap(recorder.recordToolCallObserved(
            .quickLookup,
            generation: generation))
        recorder.recordToolExecutionStarted(
            ordinal: ordinal,
            tool: .quickLookup,
            generation: generation)
        recorder.recordToolResponseQueued(
            ordinal: ordinal,
            tool: .quickLookup,
            generation: generation)
        recorder.recordToolResponseSendSucceeded(
            ordinal: ordinal,
            tool: .quickLookup,
            generation: generation)
        recorder.recordProviderModelAudioObserved(
            generation: generation,
            playbackGeneration: 1)
        let providerIdentityCanary = "secret-provider-call-901"
        _ = recorder.recordToolCallObserved(
            AlmaLiveVoiceEvidenceTool(providerName: providerIdentityCanary),
            generation: generation)

        let toolEvents = recorder.report().events.filter {
            $0.toolOrdinal == ordinal
        }
        XCTAssertEqual(toolEvents.map(\.name), [
            .toolCallObserved,
            .toolExecutionStarted,
            .toolResponseQueued,
            .toolResponseSendSucceeded,
            .toolResultPlaybackStarted,
        ])
        XCTAssertTrue(toolEvents.allSatisfy { $0.tool == .quickLookup })
        XCTAssertTrue(recorder.report().events.contains {
            $0.name == .providerActivityObserved
        })
        let json = try XCTUnwrap(String(
            data: recorder.encodedReport(),
            encoding: .utf8))
        XCTAssertFalse(json.contains(providerIdentityCanary),
                       "provider call identities must never enter event fields")
    }

    func testLiveVoiceEvidenceMarksEverySentToolInOneCombinedPlayback() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)
        let generation = recorder.beginTransportAttempt(resuming: false)
        let first = try XCTUnwrap(recorder.recordToolCallObserved(
            .quickLookup,
            generation: generation))
        let second = try XCTUnwrap(recorder.recordToolCallObserved(
            .runAgentTurn,
            generation: generation))
        for (ordinal, tool) in [
            (first, AlmaLiveVoiceEvidenceTool.quickLookup),
            (second, AlmaLiveVoiceEvidenceTool.runAgentTurn),
        ] {
            recorder.recordToolResponseSendSucceeded(
                ordinal: ordinal,
                tool: tool,
                generation: generation)
        }

        recorder.recordProviderModelAudioObserved(
            generation: generation,
            playbackGeneration: 1)
        recorder.recordProviderModelAudioObserved(
            generation: generation,
            playbackGeneration: 2)

        let playback = recorder.report().events.filter {
            $0.name == .toolResultPlaybackStarted
        }
        XCTAssertEqual(playback.map(\.toolOrdinal), [first, second])
        XCTAssertEqual(playback.map(\.tool), [.quickLookup, .runAgentTurn])
        XCTAssertEqual(playback.map(\.sequence), playback.map(\.sequence).sorted())
        XCTAssertEqual(playback.count, 2,
                       "later unrelated model audio must not consume a stale tool")
    }

    func testLiveVoiceToolSendCompletionKeepsCapturedAttemptAcrossReconnect() throws {
        let recorder = AlmaLiveVoiceEvidenceRecorder(enabled: true)
        recorder.beginFixtureSession(
            modelID: AlmaLiveVoicePreferences.gemini25,
            voiceID: "Aoede",
            callMode: .standalone,
            fixture: .unitTest)

        let firstGeneration = recorder.beginTransportAttempt(resuming: false)
        let firstSocket = NSObject()
        let firstAttempt = AlmaLiveVoiceSocketAttempt(
            ordinal: 41,
            socketIdentity: ObjectIdentifier(firstSocket),
            evidenceGeneration: firstGeneration)

        let invocation = AlmaLiveVoiceToolInvocation(
            callID: "provider-call-1",
            functionName: AlmaLiveVoiceToolName.quickLookup.rawValue,
            payload: .quickLookup(tool: "get_sales_summary"))
        var ledger = AlmaLiveVoiceToolLedger()
        XCTAssertEqual(ledger.admit(invocation), .accepted)
        XCTAssertEqual(ledger.nextExecution(), invocation)
        XCTAssertTrue(ledger.complete(
            callID: invocation.callID,
            functionName: invocation.functionName,
            result: "ok"))
        let firstTicket = try XCTUnwrap(
            ledger.nextResponse(transportOrdinal: firstAttempt.ordinal))
        let firstSend = try XCTUnwrap(
            AlmaLiveVoiceToolResponseSendEvidenceContext(
                attempt: firstAttempt,
                ticketTransportOrdinal: firstTicket.transportOrdinal))
        XCTAssertNil(AlmaLiveVoiceToolResponseSendEvidenceContext(
            attempt: firstAttempt,
            ticketTransportOrdinal: firstAttempt.ordinal + 1))

        let toolOrdinal = try XCTUnwrap(recorder.recordToolCallObserved(
            .quickLookup,
            generation: firstGeneration))
        recorder.recordToolResponseQueued(
            ordinal: toolOrdinal,
            tool: .quickLookup,
            generation: firstGeneration)

        let replacementGeneration = recorder.beginTransportAttempt(resuming: true)
        let replacementSocket = NSObject()
        let replacementAttempt = AlmaLiveVoiceSocketAttempt(
            ordinal: 42,
            socketIdentity: ObjectIdentifier(replacementSocket),
            evidenceGeneration: replacementGeneration)
        ledger.invalidateTransport(firstAttempt.ordinal)
        XCTAssertFalse(
            ledger.finishSend(firstTicket, succeeded: true),
            "socket A's late callback cannot retire the replay on socket B")
        let replacementTicket = try XCTUnwrap(
            ledger.nextResponse(transportOrdinal: replacementAttempt.ordinal))
        let replacementSend = try XCTUnwrap(
            AlmaLiveVoiceToolResponseSendEvidenceContext(
                attempt: replacementAttempt,
                ticketTransportOrdinal: replacementTicket.transportOrdinal))

        recorder.recordToolResponseSendSucceeded(
            ordinal: toolOrdinal,
            tool: .quickLookup,
            sendContext: firstSend)
        XCTAssertFalse(recorder.report().events.contains {
            $0.name == .toolResponseSendSucceeded
        }, "socket A's completion must not borrow socket B's generation")

        recorder.recordToolResponseSendSucceeded(
            ordinal: toolOrdinal,
            tool: .quickLookup,
            sendContext: replacementSend)
        XCTAssertTrue(ledger.finishSend(replacementTicket, succeeded: true))
        let success = try XCTUnwrap(recorder.report().events.first {
            $0.name == .toolResponseSendSucceeded
        })
        XCTAssertEqual(firstSend.socketAttemptOrdinal, firstAttempt.ordinal)
        XCTAssertEqual(firstSend.transportGeneration, firstGeneration)
        XCTAssertEqual(success.transportGeneration, replacementGeneration)
        XCTAssertEqual(success.toolOrdinal, toolOrdinal)
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

    func testFinalReplySurvivesRepeatedVerifierRetriesUntilAtomicReplacement() {
        let vm = AssistantVM()
        vm.debugApplyTurnEvents([.textDelta("পুরোনো পূর্ণ উত্তর")])
        vm.debugApplyTurnEvents([.verificationRetry(attempt: 1, maxAttempts: 2)])
        vm.debugApplyTurnEvents([.textDelta("প্রথম সংশোধনের খসড়া")])

        XCTAssertEqual(vm.messages.last?.text, "পুরোনো পূর্ণ উত্তর",
                       "a verifier rewrite remains hidden until it is complete")
        XCTAssertEqual(vm.messages.last?.verificationReplacementText,
                       "প্রথম সংশোধনের খসড়া")

        vm.debugApplyTurnEvents([.verificationRetry(attempt: 2, maxAttempts: 2)])
        XCTAssertEqual(vm.messages.last?.text, "পুরোনো পূর্ণ উত্তর",
                       "another retry must not blank or restart the visible answer")
        XCTAssertEqual(vm.messages.last?.verificationReplacementText, "")
        vm.debugApplyTurnEvents([.textDelta("সংশোধিত পূর্ণ উত্তর")])

        vm.debugApplyTurnEvents([.done(
            messageId: "answer-1", tokensIn: nil, tokensOut: nil, costUsd: nil,
            needContinue: false, apiRounds: nil, cacheCreation: nil,
            cacheRead: nil, roundCostsUsd: nil)])

        XCTAssertEqual(vm.messages.last?.text, "সংশোধিত পূর্ণ উত্তর")
        XCTAssertNil(vm.messages.last?.verificationReplacementText)
        XCTAssertTrue(vm.messages.last?.blocks.contains { block in
            if case .prose(_, let text) = block { return text == "সংশোধিত পূর্ণ উত্তর" }
            return false
        } == true)
    }

    func testMakePlanStartDropsLegacyPrePlanLeadAndKeepsOnlyFinalReply() {
        let vm = AssistantVM()
        vm.debugApplyTurnEvents([.textDelta("পুরোনো pre-plan পূর্ণ উত্তর")])
        vm.debugApplyTurnEvents([.preamble("পুরোনো pre-plan পূর্ণ উত্তর")])

        XCTAssertNotNil(vm.messages.last?.leadProseId)
        vm.debugApplyTurnEvents([.toolStart(
            id: "plan-1", name: "make_plan", inputPretty: #"{"steps":4}"#)])

        XCTAssertNil(vm.messages.last?.leadProseId)
        XCTAssertEqual(vm.messages.last?.text, "")
        XCTAssertFalse(vm.messages.last?.blocks.contains { block in
            if case .prose(_, let text) = block { return text.contains("পুরোনো") }
            return false
        } == true)

        vm.debugApplyTurnEvents([.textDelta("একবারের সঠিক final reply")])
        vm.debugApplyTurnEvents([.done(
            messageId: "answer-plan-1", tokensIn: nil, tokensOut: nil, costUsd: nil,
            needContinue: false, apiRounds: nil, cacheCreation: nil,
            cacheRead: nil, roundCostsUsd: nil)])

        XCTAssertEqual(vm.messages.last?.text, "একবারের সঠিক final reply")
        XCTAssertEqual(vm.messages.last?.blocks.compactMap { block -> String? in
            if case .prose(_, let text) = block { return text }
            return nil
        }, ["একবারের সঠিক final reply"])
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

    // MARK: - Build 103 Issue 1: session surface state machine

    func testInitialSurfaceIsUnresolvedNeverImplicitNewChat() {
        let vm = AssistantVM()
        // Fresh VM: nil conversation + empty messages used to read as "new
        // chat". The authoritative surface must read as UNRESOLVED instead.
        XCTAssertNil(vm.conversationId)
        XCTAssertTrue(vm.messages.isEmpty)
        XCTAssertTrue(vm.surfaceIsRestoring,
                      "cold start owns a restore surface, not a hero")
        XCTAssertFalse(vm.surfaceShowsHero,
                       "the hero may never render before the route resolves")
        XCTAssertNil(vm.surfaceFailure)
    }

    func testHeroRendersOnlyFromExplicitReadyNew() {
        let vm = AssistantVM()
        XCTAssertFalse(vm.surfaceShowsHero)
        vm.debugSetSessionSurface(.loadingHistory(conversationId: "c1", requestToken: UUID()))
        XCTAssertFalse(vm.surfaceShowsHero, "loading an existing chat is never a new chat")
        XCTAssertTrue(vm.surfaceIsRestoring)
        vm.debugSetSessionSurface(.failedHistory(conversationId: "c1", requestToken: UUID(), message: "x"))
        XCTAssertFalse(vm.surfaceShowsHero, "failure must not fall back to the hero")
        XCTAssertFalse(vm.surfaceIsRestoring)
        vm.debugSetSessionSurface(.readyNew(sessionIdentity: "s1"))
        XCTAssertTrue(vm.surfaceShowsHero)
    }

    func testExistingZeroMessageConversationIsReadyConversationNotHero() {
        let vm = AssistantVM()
        vm.debugSetSessionSurface(.readyConversation(conversationId: "empty-chat"))
        XCTAssertTrue(vm.messages.isEmpty)
        XCTAssertFalse(vm.surfaceShowsHero,
                       "an existing conversation with zero rows is still an existing conversation")
        XCTAssertFalse(vm.surfaceIsRestoring)
    }

    func testNewerSurfaceTokenInvalidatesOlderRequest() {
        let vm = AssistantVM()
        let tokenA = vm.debugIssueSurfaceToken(loading: "chat-a")
        XCTAssertTrue(vm.debugSurfaceTokenIsCurrent(tokenA))
        // Rapid A → B switch: B's request replaces A's before A responds.
        let tokenB = vm.debugIssueSurfaceToken(loading: "chat-b")
        XCTAssertFalse(vm.debugSurfaceTokenIsCurrent(tokenA),
                       "a late Chat-A response may not commit into Chat B")
        XCTAssertTrue(vm.debugSurfaceTokenIsCurrent(tokenB))
    }

    func testNewChatInvalidatesInFlightHistoryToken() async {
        let vm = AssistantVM()
        let token = vm.debugIssueSurfaceToken(loading: "chat-a")
        let opened = await vm.newChat()
        XCTAssertTrue(opened)
        XCTAssertTrue(vm.surfaceShowsHero, "explicit New Chat is the genuine hero state")
        XCTAssertFalse(vm.debugSurfaceTokenIsCurrent(token),
                       "a late history response may not replace the fresh chat")
        XCTAssertFalse(vm.loadingHistory)
    }

    func testTerminalReadyStatesRejectEveryToken() {
        let vm = AssistantVM()
        let token = vm.debugIssueSurfaceToken(loading: nil)
        vm.debugSetSessionSurface(.readyConversation(conversationId: "c9"))
        XCTAssertFalse(vm.debugSurfaceTokenIsCurrent(token),
                       "a committed surface owns itself; stale bootstrap responses are dead")
    }

    func testFailureSurfaceStaysTiedToSelectedConversation() {
        let vm = AssistantVM()
        let token = UUID()
        vm.debugSetSessionSurface(.failedHistory(
            conversationId: "chat-a", requestToken: token, message: "কথোপকথন লোড করা যায়নি"))
        XCTAssertEqual(vm.surfaceFailure?.conversationId, "chat-a")
        XCTAssertEqual(vm.surfaceFailure?.message, "কথোপকথন লোড করা যায়নি")
        XCTAssertFalse(vm.surfaceShowsHero)
        // The failed request's own token remains addressable for retry.
        XCTAssertTrue(vm.debugSurfaceTokenIsCurrent(token))
    }

    func testInitialRouteFailureIsRetryableWithoutConversation() {
        let vm = AssistantVM()
        let token = UUID()
        vm.debugSetSessionSurface(.failedHistory(
            conversationId: nil, requestToken: token, message: "সেশন খুলতে সমস্যা হয়েছে"))
        XCTAssertNil(vm.surfaceFailure?.conversationId)
        XCTAssertNotNil(vm.surfaceFailure)
        XCTAssertFalse(vm.surfaceShowsHero,
                       "a failed route resolution may not silently become a blank new chat")
    }

    // MARK: - Build 103 Issue 2: v2 image render selection decode

    private func renderSelectionJSON(
        revision: Int = 3,
        fingerprint: String = "fp-1",
        quoteFingerprint: String = "fp-1",
        extraField: Bool = false
    ) -> Data {
        Data("""
        {
          "contractVersion": 2,
          "revision": \(revision),
          "selectedModel": "gpt-image-2",
          \(extraField ? "\"futureUnknownField\": {\"nested\": true}," : "")
          "config": {
            "version": 1, "presetId": "social_post", "sizeMode": "tier",
            "aspectRatio": "4:5", "imageSize": "2K", "width": 1856, "height": 2304,
            "quality": "standard", "providerQuality": "medium",
            "variationCount": 4, "pipelineMode": "preview"
          },
          "configFingerprint": "\(fingerprint)",
          "modelOptions": [
            {"id": "gpt-image-2", "label": "GPT Image 2", "provider": "openai", "enabled": true},
            {"id": "gemini-3-pro-image", "label": "Nano Banana Pro", "provider": "gemini",
             "enabled": false, "unavailableReason": "Live image worker has not proven this option."}
          ],
          "presetOptions": [
            {"id": "social_post", "label": "Facebook / Instagram post", "aspectRatio": "4:5", "enabled": true},
            {"id": "poster", "label": "Portrait poster", "aspectRatio": "2:3", "enabled": false,
             "unavailableReason": "Live image worker has not proven this option."}
          ],
          "sizeOptions": [
            {"id": "1K", "enabled": true, "width": 928, "height": 1152},
            {"id": "2K", "enabled": true, "width": 1856, "height": 2304},
            {"id": "4K", "enabled": false, "unavailableReason": "GPT Image does not support 4K at 4:5."}
          ],
          "qualityOptions": [
            {"id": "standard", "providerQuality": "medium", "description": "OpenAI quality medium"},
            {"id": "pro", "providerQuality": "high", "description": "OpenAI quality high"}
          ],
          "countOptions": [1, 2, 3, 4],
          "quote": {
            "version": 2, "currency": "USD", "kind": "provider_render_estimate",
            "model": "gpt-image-2", "provider": "openai", "presetId": "social_post",
            "aspectRatio": "4:5", "imageSize": "2K", "width": 1856, "height": 2304,
            "quality": "standard", "providerQuality": "medium", "requestedImages": 4,
            "unitPriceUsd": 0.05, "minCostUsd": 0.2, "maxCostUsd": 0.2,
            "maxPaidGenerationsPerImage": 1,
            "configFingerprint": "\(quoteFingerprint)",
            "pricingBasis": "internal_list_estimate", "pricingLastVerifiedAt": "2026-07-12",
            "pricedComponents": ["provider_output_render"],
            "excludes": ["qc_vision", "taxes", "provider_credits",
                         "prompt_text_input_tokens", "reference_image_input_tokens"]
          }
        }
        """.utf8)
    }

    func testImageRenderSelectionDecodesCompleteV2Projection() throws {
        let wire = try JSONDecoder().decode(
            AgentImageRenderSelectionWire.self, from: renderSelectionJSON())
        let selection = try XCTUnwrap(wire.trustedValue)
        XCTAssertEqual(selection.revision, 3)
        XCTAssertEqual(selection.config.width, 1856)
        XCTAssertEqual(selection.config.aspectRatio, "4:5")
        XCTAssertEqual(selection.countOptions, [1, 2, 3, 4])
        // Disabled combinations stay visible with a reason.
        XCTAssertEqual(selection.sizeOptions.first(where: { $0.id == "4K" })?.enabled, false)
        XCTAssertNotNil(selection.sizeOptions.first(where: { $0.id == "4K" })?.unavailableReason)
        XCTAssertEqual(selection.presetOptions.first(where: { $0.id == "poster" })?.enabled, false)
    }

    func testImageRenderSelectionSurvivesUnknownFutureFields() throws {
        let wire = try JSONDecoder().decode(
            AgentImageRenderSelectionWire.self, from: renderSelectionJSON(extraField: true))
        XCTAssertNotNil(wire.trustedValue)
    }

    func testImageRenderSelectionRejectsQuoteFingerprintMismatch() throws {
        // A quote that binds a DIFFERENT selection could approve a different
        // price than shown — the whole projection is untrusted.
        let wire = try JSONDecoder().decode(
            AgentImageRenderSelectionWire.self,
            from: renderSelectionJSON(quoteFingerprint: "fp-OTHER"))
        XCTAssertNil(wire.trustedValue)
    }

    func testPinnedAspectDrivesContainerRatioWithBoundedRange() {
        XCTAssertEqual(AgentGeneratedImageSizing.containerAspectRatio(fromPinned: "1:1"), 1.0)
        XCTAssertEqual(AgentGeneratedImageSizing.containerAspectRatio(fromPinned: "2:3"),
                       CGFloat(2.0 / 3.0), accuracy: 0.001)
        XCTAssertEqual(AgentGeneratedImageSizing.containerAspectRatio(fromPinned: "9:16"),
                       CGFloat(9.0 / 16.0), accuracy: 0.001)
        // Legacy/unknown input keeps the stable 4:5 reservation.
        XCTAssertEqual(AgentGeneratedImageSizing.containerAspectRatio(fromPinned: nil),
                       AgentGeneratedImageSizing.stableContainerAspectRatio)
        XCTAssertEqual(AgentGeneratedImageSizing.containerAspectRatio(fromPinned: "banana"),
                       AgentGeneratedImageSizing.stableContainerAspectRatio)
        // Bounded for phone height: extreme ratios clamp instead of exploding.
        XCTAssertEqual(AgentGeneratedImageSizing.containerAspectRatio(fromPinned: "100:1"), 1.9)
    }

    // MARK: - Build 103 Issue 3: tracker decode + monotonic reducer

    private func workStepsJSON(
        revision: Int = 1,
        status: String = "running",
        boundMessageId: String? = nil,
        stepOneStatus: String = "completed",
        stepTwoStatus: String = "running",
        updatedAt: String = "2026-08-11T00:00:03Z",
        source: String = "agent_plan",
        turnId: String = "turn-1"
    ) -> String {
        """
        {
          "type": "work_steps_snapshot",
          "version": 1,
          "trackerId": "\(source == "turn_runtime" ? "turn:\(turnId)" : "plan-\(turnId)")",
          "originTurnId": "\(turnId)",
          "currentTurnId": "\(turnId)",
          "turnIds": ["\(turnId)"],
          "conversationId": "conversation-1",
          "originAssistantMessageId": \(boundMessageId.map { "\"\($0)\"" } ?? "null"),
          "revision": \(revision),
          "source": "\(source)",
          "sourceId": "plan-1",
          "goal": "Prepare the requested deliverable",
          "status": "\(status)",
          "headline": "১/৩ ধাপ শেষ",
          "blockedBy": null,
          "retryRef": null,
          "steps": [
            {"id": "s1", "position": 1, "title": "Inspect the request", "status": "\(stepOneStatus)",
             "toolCallIds": [], "startedAt": "2026-08-11T00:00:00Z", "finishedAt": "2026-08-11T00:00:03Z"},
            {"id": "s2", "position": 2, "title": "Draft the output", "status": "\(stepTwoStatus)",
             "toolCallIds": [], "startedAt": null, "finishedAt": null},
            {"id": "s3", "position": 3, "title": "Verify the result", "status": "pending",
             "toolCallIds": [], "startedAt": null, "finishedAt": null}
          ],
          "updatedAt": \(updatedAt.debugDescription)
        }
        """
    }

    private func decodeTurnEvent(_ json: String) throws -> AgentTurnEvent {
        let dto = try JSONDecoder().decode(AgentSSEEvent.self, from: Data(json.utf8))
        return AgentTurnEvent(dto: dto)
    }

    func testWorkStepsSnapshotDecodesTypedNeverUnknown() throws {
        let event = try decodeTurnEvent(workStepsJSON())
        guard case .workSteps(let snapshot) = event else {
            return XCTFail("work_steps_snapshot must decode typed, got \(event)")
        }
        XCTAssertEqual(snapshot.trackerId, "plan-turn-1")
        XCTAssertEqual(snapshot.revision, 1)
        XCTAssertEqual(snapshot.steps.count, 3)
        XCTAssertEqual(snapshot.steps.map(\.status), ["completed", "running", "pending"])
        XCTAssertEqual(snapshot.completedCount, 1)
        XCTAssertFalse(snapshot.isTerminal)
    }

    func testWorkStepsUsesCodexStyleCurrentStepBeforeAndAfterTransition() throws {
        let initialEvent = try decodeTurnEvent(workStepsJSON(
            status: "preparing", stepOneStatus: "pending", stepTwoStatus: "pending"))
        guard case .workSteps(let initial) = initialEvent else {
            return XCTFail("initial work steps did not decode")
        }
        XCTAssertEqual(initial.currentDisplayPosition, 1)
        XCTAssertTrue(initial.isCurrentDisplayStep(initial.steps[0]))

        let advancedEvent = try decodeTurnEvent(workStepsJSON())
        guard case .workSteps(let advanced) = advancedEvent else {
            return XCTFail("advanced work steps did not decode")
        }
        XCTAssertEqual(advanced.currentDisplayPosition, 2)
        XCTAssertFalse(advanced.isCurrentDisplayStep(advanced.steps[0]))
        XCTAssertTrue(advanced.isCurrentDisplayStep(advanced.steps[1]))
    }

    func testWorkStepPresentationRemovesRedundantModelOrdinalsOnly() {
        XCTAssertEqual(
            AgentWorkStepPresentation.displayTitle(
                "Step 1: Inspect the live surface", position: 1),
            "Inspect the live surface")
        XCTAssertEqual(
            AgentWorkStepPresentation.displayTitle(
                "2. Step 2: Verify the simulator", position: 2),
            "Verify the simulator")
        XCTAssertEqual(
            AgentWorkStepPresentation.displayTitle(
                "Review Step 3 evidence", position: 3),
            "Review Step 3 evidence",
            "step wording inside a real title must not be altered")
    }

    func testPlanAndTurnProgressDecodeTypedNeverUnknown() throws {
        let plan = try decodeTurnEvent("""
        {"type": "plan_progress", "planId": "p1", "goal": "g", "headline": "১/২",
         "doneCount": 1, "total": 2,
         "steps": [{"seq": 1, "action": "a", "status": "done"}]}
        """)
        guard case .planProgress = plan else { return XCTFail("plan_progress decoded as \(plan)") }
        let turn = try decodeTurnEvent("""
        {"type": "turn_progress", "round": 3, "elapsedSec": 42, "lastToolLabel": null, "text": "কাজ চলছে"}
        """)
        guard case .turnProgress = turn else { return XCTFail("turn_progress decoded as \(turn)") }
    }

    func testMalformedWorkStepsBecomesTelemetryNotCrash() throws {
        let event = try decodeTurnEvent("""
        {"type": "work_steps_snapshot", "version": 99, "trackerId": "x"}
        """)
        guard case .unknown(let type) = event else {
            return XCTFail("future-version snapshot must be telemetry, got \(event)")
        }
        XCTAssertEqual(type, "work_steps_snapshot/invalid")
    }

    private func snapshotFixture(
        revision: Int, status: String = "running", boundMessageId: String? = nil,
        updatedAt: String = "2026-08-11T00:00:03Z", source: String = "agent_plan",
        turnId: String = "turn-1"
    ) throws -> AgentWorkStepsSnapshot {
        let event = try decodeTurnEvent(workStepsJSON(
            revision: revision, status: status, boundMessageId: boundMessageId,
            updatedAt: updatedAt, source: source, turnId: turnId))
        guard case .workSteps(let snapshot) = event else {
            throw NSError(domain: "fixture", code: 1)
        }
        return snapshot
    }

    func testWorkTrackerMergeIsMonotonicAndTerminalDominant() throws {
        let vm = AssistantVM()
        vm.debugMergeWorkSteps(try snapshotFixture(revision: 2))
        // A lower revision (replay overlap) never regresses the store.
        vm.debugMergeWorkSteps(try snapshotFixture(revision: 1, status: "preparing"))
        XCTAssertEqual(vm.workTrackers["plan-turn-1"]?.revision, 2)
        XCTAssertEqual(vm.workTrackers["plan-turn-1"]?.status, "running")
        // Terminal state cannot regress to running from a late higher revision
        // replay of a non-terminal frame.
        vm.debugMergeWorkSteps(try snapshotFixture(revision: 3, status: "completed"))
        vm.debugMergeWorkSteps(try snapshotFixture(revision: 4, status: "running"))
        XCTAssertEqual(vm.workTrackers["plan-turn-1"]?.status, "completed")
    }

    func testDockShowsOnlyTheCurrentProspectivePlanNeverRuntimeToolRows() throws {
        let vm = AssistantVM()
        vm.conversationId = "conversation-1"
        vm.isStreaming = true
        vm.currentTurnId = "turn-1"
        // The runtime projection arrives LAST (it re-emits every round), but
        // the dock must still show the real plan tracker — owner 2026-08-15:
        // the chip said "১ of ২" while the work detail listed 5 plan steps.
        vm.debugMergeWorkSteps(try snapshotFixture(revision: 3))
        vm.debugMergeWorkSteps(try snapshotFixture(
            revision: 9, updatedAt: "2026-08-11T09:00:00Z", source: "turn_runtime"))
        XCTAssertEqual(vm.activeWorkTracker?.trackerId, "plan-turn-1")
        XCTAssertEqual(vm.activeWorkTracker?.source, "agent_plan")

        // A plan tracker from a PREVIOUS turn and a runtime projection from the
        // current turn must both stay out: tool calls are activity, not a plan.
        let stale = AssistantVM()
        stale.conversationId = "conversation-1"
        stale.isStreaming = true
        stale.currentTurnId = "turn-1"
        stale.debugMergeWorkSteps(try snapshotFixture(revision: 4, turnId: "turn-OLD"))
        stale.debugMergeWorkSteps(try snapshotFixture(
            revision: 5, updatedAt: "2026-08-11T09:00:00Z", source: "turn_runtime"))
        XCTAssertNil(stale.activeWorkTracker)

        // A stale RUNNING plan with no runtime tracker (first round of a new
        // turn) must not hold the dock (Codex P2 #765) …
        let staleAlone = AssistantVM()
        staleAlone.conversationId = "conversation-1"
        staleAlone.isStreaming = true
        staleAlone.currentTurnId = "turn-1"
        staleAlone.debugMergeWorkSteps(try snapshotFixture(
            revision: 2, status: "running", turnId: "turn-OLD"))
        XCTAssertNil(staleAlone.activeWorkTracker)

        // A settled reply owns no composer dock, even if its durable plan says
        // it is waiting on an owner decision; that state remains in-message.
        let waitingOld = AssistantVM()
        waitingOld.conversationId = "conversation-1"
        waitingOld.currentTurnId = "turn-OLD"
        waitingOld.debugMergeWorkSteps(try snapshotFixture(
            revision: 2, status: "waiting_owner", turnId: "turn-OLD"))
        XCTAssertNil(waitingOld.activeWorkTracker)

        // With no plan tracker at all, runtime tool rows never manufacture one.
        let runtimeOnly = AssistantVM()
        runtimeOnly.conversationId = "conversation-1"
        runtimeOnly.isStreaming = true
        runtimeOnly.currentTurnId = "turn-1"
        runtimeOnly.debugMergeWorkSteps(try snapshotFixture(
            revision: 2, source: "turn_runtime"))
        XCTAssertNil(runtimeOnly.activeWorkTracker)
    }

    func testDockShowsOnlyLiveWorkNeverPausedOrStalledChips() throws {
        let vm = AssistantVM()
        vm.conversationId = "conversation-1"
        vm.currentTurnId = "turn-1"

        // Streaming turn with a running tracker: the dock chip shows. A live
        // turn emits FRESH snapshots — streaming alone no longer rescues a
        // stale row (Codex P2 #765).
        let liveStamp = ISO8601DateFormatter.almaWorkStepsLenient.string(from: Date())
        vm.isStreaming = true
        vm.debugMergeWorkSteps(try snapshotFixture(revision: 2, updatedAt: liveStamp))
        XCTAssertEqual(vm.activeWorkTracker?.trackerId, "plan-turn-1")

        // Turn-end honest projection parks it paused: the chip must leave
        // (build 103 owner report — chip lingered after the answer landed).
        vm.debugMergeWorkSteps(try snapshotFixture(
            revision: 3, status: "paused", updatedAt: liveStamp))
        XCTAssertNil(vm.activeWorkTracker)

        // A dropped final snapshot leaves a STALE "running" row with no
        // stream — it ages out of the dock (freshness window, build 104 fix).
        vm.debugMergeWorkSteps(try snapshotFixture(revision: 4, status: "running"))
        vm.isStreaming = false
        XCTAssertNil(vm.activeWorkTracker)

        // A fresh snapshot cannot outlive the visible reply. Codex removes its
        // composer chip as soon as the response settles.
        let freshStamp = ISO8601DateFormatter.almaWorkStepsLenient
            .string(from: Date())
        vm.debugMergeWorkSteps(try snapshotFixture(
            revision: 5, status: "running", updatedAt: freshStamp))
        XCTAssertNil(vm.activeWorkTracker)
        // The freshness window EXPIRES: the same snapshot evaluated 200s later
        // is gone — the dock's 30s clock tick drives this re-evaluation in the
        // UI (Codex P1 #758).
        XCTAssertNil(vm.activeWorkTracker(now: Date().addingTimeInterval(200)))

        // Waiting and terminal states never resurrect the dock after settle.
        vm.debugMergeWorkSteps(try snapshotFixture(revision: 6, status: "waiting_owner"))
        XCTAssertNil(vm.activeWorkTracker)
        vm.debugMergeWorkSteps(try snapshotFixture(revision: 7, status: "completed"))
        XCTAssertNil(vm.activeWorkTracker)
    }

    func testSameRevisionSamePayloadIsIdempotentNoOp() throws {
        let vm = AssistantVM()
        let snapshot = try snapshotFixture(revision: 2)
        vm.debugMergeWorkSteps(snapshot)
        vm.debugMergeWorkSteps(snapshot)
        XCTAssertEqual(vm.workTrackers.count, 1)
        XCTAssertEqual(vm.workTrackers["plan-turn-1"]?.revision, 2)
    }

    func testTerminalBoundSnapshotReparentsSameTrackerNeverTwo() throws {
        let vm = AssistantVM()
        // Live: unbound snapshot anchored to the streaming message.
        vm.debugMergeWorkSteps(try snapshotFixture(revision: 1), anchoredMessageId: "stream-1")
        XCTAssertEqual(vm.workTrackerAnchors["stream-1"], ["plan-turn-1"])
        // Settlement: bound snapshot reparents to the canonical message id.
        vm.debugMergeWorkSteps(
            try snapshotFixture(revision: 2, status: "completed", boundMessageId: "msg-9"))
        XCTAssertEqual(vm.workTrackerAnchors["msg-9"], ["plan-turn-1"])
        XCTAssertEqual(vm.workTrackerAnchors["stream-1"], [],
                       "the same logical tracker must move, never duplicate")
        XCTAssertEqual(vm.workTrackers.count, 1)
    }

    func testLiveDockGeometryClampsAboveBottomChromeAndSafeArea() {
        let bounds = AgentLiveDockGeometry.bounds(
            container: CGSize(width: 390, height: 844),
            safeArea: EdgeInsets(top: 59, leading: 0, bottom: 34, trailing: 0),
            player: CGSize(width: 286, height: 161),
            margin: 12,
            bottomObstacleMinY: 650)
        let clamped = AgentLiveDockGeometry.clamp(
            CGPoint(x: -200, y: 2_000), to: bounds)

        XCTAssertEqual(clamped.x, 155, accuracy: 0.001)
        XCTAssertEqual(clamped.y, 557.5, accuracy: 0.001)
        XCTAssertLessThanOrEqual(clamped.y + 80.5, 650 - 12,
                                 "the PiP must keep a real gap above tracker+composer")
    }

    func testLiveDockGeometrySnapsToPersistedEdgeAndVerticalFraction() {
        let bounds = AgentLiveDockGeometry.Bounds(
            minX: 155, maxX: 235, minY: 100, maxY: 600)
        XCTAssertEqual(
            AgentLiveDockGeometry.position(onRight: false, verticalFraction: 0.25, in: bounds),
            CGPoint(x: 155, y: 225))
        XCTAssertEqual(
            AgentLiveDockGeometry.position(onRight: true, verticalFraction: 2, in: bounds),
            CGPoint(x: 235, y: 600),
            "rotation/restoration must clamp stale saved fractions")
    }

    func testLiveDockDismissalAndContextSelectionUseStablePreviewIdentity() {
        let now = "2026-08-19T10:00:00.000Z"
        let chromeA = AgentLiveActivityPreview(
            surface: "browser", contextId: "browser:a", screenshot: nil, screenshotAt: now,
            labelBn: "Chrome A", active: true, videoDeviceId: nil)
        let chromeB = AgentLiveActivityPreview(
            surface: "browser", contextId: "browser:b", screenshot: nil, screenshotAt: now,
            labelBn: "Chrome B", active: true, videoDeviceId: nil)
        let feed = AgentLiveActivityFeed(
            active: true, current: nil, steps: [], streaming: false, sessions: nil,
            screenshot: nil, screenshotAt: nil, screenshotSurface: nil,
            videoDeviceId: nil, macDisplays: nil, previews: [chromeA, chromeB])
        let store = AgentLiveDockStore()
        store.feed = feed
        store.reconcilePreviewSelection([chromeA, chromeB])
        XCTAssertEqual(store.selectedPreview?.id, "browser:a")
        store.selectPreview("browser:b")
        XCTAssertEqual(store.selectedPreview?.id, "browser:b")

        store.dismiss()
        XCTAssertFalse(store.show, "a nil-current feed must stay closed")
        store.reconcileDismissal(with: feed)
        XCTAssertFalse(store.show, "an identical poll must not reopen it")

        let newFrame = AgentLiveActivityPreview(
            surface: "browser", contextId: "browser:a", screenshot: nil,
            screenshotAt: "2026-08-19T10:00:01.000Z",
            labelBn: "Chrome A", active: true, videoDeviceId: nil)
        let refreshed = AgentLiveActivityFeed(
            active: true, current: nil, steps: [], streaming: false, sessions: nil,
            screenshot: nil, screenshotAt: nil, screenshotSurface: nil,
            videoDeviceId: nil, macDisplays: nil, previews: [newFrame])
        store.feed = refreshed
        store.reconcileDismissal(with: refreshed)
        store.reconcilePreviewSelection([newFrame])
        XCTAssertTrue(store.show)
        XCTAssertEqual(store.selectedPreview?.id, "browser:a",
                       "a disappeared context must fall back to the remaining card")
    }

    func testLiveDockExpiresFrozenFeedAfterFailedPollWindow() {
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(AgentLiveDockStore.shouldExpireFeed(
            lastSuccessfulAt: start,
            now: start.addingTimeInterval(19.999)))
        XCTAssertTrue(AgentLiveDockStore.shouldExpireFeed(
            lastSuccessfulAt: start,
            now: start.addingTimeInterval(20)))
        XCTAssertTrue(AgentLiveDockStore.shouldExpireFeed(
            lastSuccessfulAt: Date(),
            force: true),
            "two owner-auth failures must remove a sensitive cached frame immediately")
    }

    func testComputerUseSurfaceClassifierIncludesOnlyPixelProducingTools() {
        XCTAssertEqual(AgentComputerUseSurface.classify(toolName: "live_browser_look"), .browser)
        XCTAssertEqual(AgentComputerUseSurface.classify(toolName: "live_browser_act"), .browser)
        XCTAssertEqual(AgentComputerUseSurface.classify(toolName: "look_mac_app"), .mac)
        XCTAssertEqual(AgentComputerUseSurface.classify(toolName: "drive_mac_app"), .mac)
        XCTAssertEqual(AgentComputerUseSurface.classify(
            toolName: "mac_desk_control", inputPretty: #"{"action":"screenshot"}"#), .mac)
        XCTAssertEqual(AgentComputerUseSurface.classify(toolName: "run_mac_command"), .mac)
        XCTAssertTrue(AgentComputerUseSurface.allowsOptimisticReveal(
            toolName: "live_browser_look"))
        XCTAssertTrue(AgentComputerUseSurface.allowsOptimisticReveal(
            toolName: "look_mac_app"))
        XCTAssertTrue(AgentComputerUseSurface.allowsOptimisticReveal(
            toolName: "mac_desk_control", inputPretty: #"{"action":"screenshot"}"#))
        XCTAssertFalse(AgentComputerUseSurface.allowsOptimisticReveal(
            toolName: "drive_mac_app"), "approval staging is not a pixel source")
        XCTAssertFalse(AgentComputerUseSurface.allowsOptimisticReveal(
            toolName: "run_mac_command"), "an amber command may only stage approval")
        XCTAssertNil(AgentComputerUseSurface.classify(toolName: "mac_desk_control"))
        for nonVisualAction in ["keep_awake", "allow_sleep", "power_status"] {
            XCTAssertNil(AgentComputerUseSurface.classify(
                toolName: "mac_desk_control",
                inputPretty: #"{"action":"\#(nonVisualAction)"}"#))
        }

        for excluded in [
            "live_browser_pair", "live_browser_status", "live_browser_trust",
            "browser_diagnose", "set_live_browser", "check_mac_command",
            "mac_agent_status", "list_mac_apps",
        ] {
            XCTAssertNil(AgentComputerUseSurface.classify(toolName: excluded), excluded)
        }
    }

    func testLivePresentationRequiresMotionAndReportsReconnectAndFinishTruthfully() {
        let now = Date(timeIntervalSince1970: 2_000)
        XCTAssertEqual(AgentLiveDockStore.presentationState(
            turnActive: true, turnReconnecting: false, sourceState: "live",
            frameAdvances: 0, lastFrameAdvanceAt: nil, now: now), .connecting,
            "a live lease without moving pixels is still Connecting")
        XCTAssertEqual(AgentLiveDockStore.presentationState(
            turnActive: true, turnReconnecting: false, sourceState: "live",
            frameAdvances: 1, lastFrameAdvanceAt: now.addingTimeInterval(-1), now: now), .live)
        XCTAssertEqual(AgentLiveDockStore.presentationState(
            turnActive: true, turnReconnecting: false, sourceState: nil,
            frameAdvances: 1, lastFrameAdvanceAt: now.addingTimeInterval(-6), now: now), .reconnecting)
        XCTAssertEqual(AgentLiveDockStore.presentationState(
            turnActive: true, turnReconnecting: true, sourceState: nil,
            frameAdvances: 2, lastFrameAdvanceAt: now, now: now), .reconnecting)
        XCTAssertEqual(AgentLiveDockStore.presentationState(
            turnActive: false, turnReconnecting: false, sourceState: "live",
            frameAdvances: 2, lastFrameAdvanceAt: now, now: now), .finished)
    }

    func testAssistantReducerPublishesOnlyComputerUseToolStartsToDock() {
        let vm = AssistantVM()
        vm.conversationId = "conversation-1"
        vm.currentTurnId = "turn-1"
        vm.isStreaming = true

        vm.debugApplyTurnEvents([.toolStart(
            id: "pair", name: "live_browser_pair", inputPretty: "{}")])
        XCTAssertEqual(vm.computerUseToolStartGeneration, 0)

        vm.debugApplyTurnEvents([.toolStart(
            id: "power", name: "mac_desk_control",
            inputPretty: #"{"action":"power_status"}"#)])
        XCTAssertEqual(vm.computerUseToolStartGeneration, 0)

        vm.debugApplyTurnEvents([.toolStart(
            id: "look", name: "live_browser_look", inputPretty: "{}")])
        XCTAssertEqual(vm.computerUseToolStartGeneration, 1)
        XCTAssertEqual(vm.computerUseSurface, .browser)
        XCTAssertEqual(vm.computerUseConversationId, "conversation-1")
        XCTAssertEqual(vm.computerUseTurnId, "turn-1")
    }

    func testApprovalStagingWaitsForExactPreviewAndProgressTurnBindsBeforePOSTReturns() async {
        let vm = AssistantVM()
        vm.conversationId = "conversation-approval"
        vm.currentTurnId = "turn-that-staged-card"
        vm.isStreaming = true
        vm.debugApplyTurnEvents([.toolStart(
            id: "stage-drive", name: "drive_mac_app",
            inputPretty: #"{"bundleId":"com.google.Chrome","action":"click"}"#)])
        XCTAssertFalse(vm.computerUseAllowsOptimisticReveal)

        let dock = AgentLiveDockStore()
        await dock.synchronize(
            conversationId: vm.conversationId, turnId: vm.currentTurnId,
            turnIsStreaming: true, turnReconnecting: false,
            computerUseToolStartGeneration: vm.computerUseToolStartGeneration,
            computerUseSurface: vm.computerUseSurface,
            computerUseAllowsOptimisticReveal: vm.computerUseAllowsOptimisticReveal,
            computerUseConversationId: vm.computerUseConversationId,
            computerUseTurnId: vm.computerUseTurnId,
            performNetwork: false)
        XCTAssertFalse(dock.show)
        XCTAssertNil(dock.presentedFeed,
                     "staging an approval must not paint a black synthetic player")

        var approvalPOSTReturned = false
        let pendingApprovalPOST = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            approvalPOSTReturned = true
        }
        defer { pendingApprovalPOST.cancel() }
        var statusPoll = 0
        let progressTurnId = await AssistantVM.awaitApprovalProgressTurn(
            actionId: "drive-action",
            expectedConversationId: "conversation-approval",
            excludingTurnId: "turn-that-staged-card",
            delays: [0, 0],
            sleep: { _ in },
            currentConversationId: { vm.conversationId }
        ) {
            statusPoll += 1
            return statusPoll == 1
                ? .init(
                    id: "another-action", conversationId: "conversation-approval",
                    progressTurnId: "turn-that-staged-card",
                    progressConversationId: "conversation-approval",
                    progressTurnStatus: "running")
                : .init(
                    id: "drive-action", conversationId: "conversation-approval",
                    progressTurnId: "turn-approved-progress",
                    progressConversationId: "conversation-approval",
                    progressTurnStatus: "running")
        }
        XCTAssertEqual(progressTurnId, "turn-approved-progress")
        XCTAssertFalse(approvalPOSTReturned,
                       "progress identity must bind while the synchronous approval request is pending")

        vm.currentTurnId = progressTurnId
        await dock.synchronize(
            conversationId: vm.conversationId, turnId: vm.currentTurnId,
            turnIsStreaming: true, turnReconnecting: false,
            computerUseToolStartGeneration: vm.computerUseToolStartGeneration,
            computerUseSurface: vm.computerUseSurface,
            computerUseAllowsOptimisticReveal: vm.computerUseAllowsOptimisticReveal,
            computerUseConversationId: vm.computerUseConversationId,
            computerUseTurnId: vm.computerUseTurnId,
            performNetwork: false)
        let exactProgressPreview = AgentLiveActivityPreview(
            surface: "mac", contextId: "mac:paired-device", screenshot: nil,
            screenshotAt: nil, labelBn: "Approved Mac work", active: true,
            videoDeviceId: "paired-device", turnId: "turn-approved-progress",
            conversationId: "conversation-approval", activityId: "approved-work",
            sourceState: "connecting")
        dock.feed = AgentLiveActivityFeed(
            active: true, current: nil, steps: [], streaming: true, sessions: nil,
            screenshot: nil, screenshotAt: nil, screenshotSurface: "mac",
            videoDeviceId: "paired-device", macDisplays: nil,
            previews: [exactProgressPreview])
        dock.debugRecoverMissedComputerUse(from: [exactProgressPreview])
        XCTAssertTrue(dock.show,
                      "the exact approved progress turn must recover its player before POST completion")
        XCTAssertEqual(dock.selectedPreview?.turnId, "turn-approved-progress")
        XCTAssertFalse(approvalPOSTReturned)
    }

    func testConversationSerializesApprovalsUntilExactProgressTerminal() {
        let vm = AssistantVM()
        XCTAssertTrue(vm.claimApprovalExecution(
            cardId: "action-a", conversationId: "conversation-overlap"))
        XCTAssertFalse(vm.claimApprovalExecution(
            cardId: "action-b", conversationId: "conversation-overlap"),
            "B must not send a mutation while A owns the conversation's one PiP/turn")
        XCTAssertEqual(vm.approvalExecutionOwner(
            conversationId: "conversation-overlap"), "action-a")

        vm.releaseApprovalExecutionAfterTerminal(
            cardId: "action-b", conversationId: "conversation-overlap")
        XCTAssertEqual(vm.approvalExecutionOwner(
            conversationId: "conversation-overlap"), "action-a",
            "a foreign completion cannot release A")

        vm.releaseApprovalExecutionAfterTerminal(
            cardId: "action-a", conversationId: "conversation-overlap")
        XCTAssertTrue(vm.claimApprovalExecution(
            cardId: "action-b", conversationId: "conversation-overlap"),
            "B may begin only after A's exact progress terminal releases the lock")
    }

    func testApprovalProgressPollStopsOnNavigationAndTimeoutDoesNotCancelClaimedWork() async {
        var currentConversation: String? = "conversation-a"
        var fetchCount = 0
        let discovered = await AssistantVM.awaitApprovalProgressTurn(
            actionId: "action-a",
            expectedConversationId: "conversation-a",
            excludingTurnId: nil,
            delays: [1],
            sleep: { _ in currentConversation = "conversation-b" },
            currentConversationId: { currentConversation }
        ) {
            fetchCount += 1
            return .init(
                id: "action-a", conversationId: "conversation-a",
                progressTurnId: "progress-a", progressConversationId: "conversation-a",
                progressTurnStatus: "running")
        }
        XCTAssertNil(discovered)
        XCTAssertEqual(fetchCount, 0,
                       "a pending approval must not attach after the owner changes chat")

        XCTAssertTrue(AssistantVM.approvalFailureMayHaveCommitted(
            AlmaAPIError.transport(URLError(.timedOut))),
            "the 20-second client timeout must leave the exact progress monitor alive")
        XCTAssertTrue(AssistantVM.approvalFailureMayHaveCommitted(
            AlmaAPIError.http(status: 503, body: "gateway timeout")))
        XCTAssertFalse(AssistantVM.approvalFailureMayHaveCommitted(
            AlmaAPIError.http(status: 409, body: #"{"error":"already_resolved"}"#)),
            "a definitive conflict can settle/cancel its monitor")
    }

    func testLiveDockOptimisticLifecyclePersistsUntilTurnEndsAndDismissStaysClosed() async {
        let store = AgentLiveDockStore()
        await store.synchronize(
            conversationId: "conversation-1", turnId: "turn-1",
            turnIsStreaming: true, turnReconnecting: false,
            computerUseToolStartGeneration: 1, computerUseSurface: .browser,
            computerUseConversationId: "conversation-1", computerUseTurnId: "turn-1",
            performNetwork: false)

        XCTAssertTrue(store.show)
        XCTAssertEqual(store.presentedFeed?.previews?.first?.surface, "browser")
        XCTAssertEqual(store.presentationState, .connecting)
        store.debugAdvanceLifecycleClock(by: 30)
        XCTAssertTrue(store.show, "active current-turn computer use must not vanish after 20 seconds")

        store.dismiss()
        XCTAssertFalse(store.show)
        let emptyPoll = AgentLiveActivityFeed(
            active: false, current: nil, steps: [], streaming: false, sessions: nil,
            screenshot: nil, screenshotAt: nil, screenshotSurface: nil,
            videoDeviceId: nil, macDisplays: nil, previews: [])
        store.feed = emptyPoll
        store.reconcileDismissal(with: emptyPoll)
        XCTAssertFalse(store.show, "poll children must not reopen a dismissed lifecycle")

        await store.synchronize(
            conversationId: "conversation-1", turnId: "turn-1",
            turnIsStreaming: true, turnReconnecting: false,
            computerUseToolStartGeneration: 2, computerUseSurface: .browser,
            computerUseConversationId: "conversation-1", computerUseTurnId: "turn-1",
            performNetwork: false)
        XCTAssertFalse(store.show, "another action in the same task must respect Close")

        await store.synchronize(
            conversationId: "conversation-1", turnId: "turn-2",
            turnIsStreaming: true, turnReconnecting: false,
            computerUseToolStartGeneration: 3, computerUseSurface: .browser,
            computerUseConversationId: "conversation-1", computerUseTurnId: "turn-2",
            performNetwork: false)
        XCTAssertTrue(store.show, "a genuinely new task may reopen the card")

        store.feed = AgentLiveActivityFeed(
            active: false, current: nil, steps: [], streaming: false, sessions: nil,
            screenshot: nil, screenshotAt: nil, screenshotSurface: nil,
            videoDeviceId: nil, macDisplays: nil, previews: [])
        await store.synchronize(
            conversationId: "conversation-1", turnId: "turn-2",
            turnIsStreaming: false, turnReconnecting: false,
            computerUseToolStartGeneration: 3, computerUseSurface: .browser,
            computerUseConversationId: "conversation-1", computerUseTurnId: "turn-2",
            performNetwork: false)
        XCTAssertEqual(store.presentationState, .finished)
        XCTAssertTrue(store.show)
        store.debugAdvanceLifecycleClock(by: AgentLiveDockStore.finishedLingerSeconds + 0.1)
        XCTAssertFalse(store.show, "finished linger is bounded")

        let delayed = AgentLiveActivityPreview(
            surface: "browser", contextId: "browser:delayed", screenshot: nil,
            screenshotAt: nil, labelBn: "Approved browser action", active: true,
            videoDeviceId: nil, turnId: "turn-2", conversationId: "conversation-1",
            activityId: "approval-1", sourceState: "connecting",
            activityAt: "2100-01-01T00:00:00.000Z", frameAt: nil, frameSeq: nil)
        store.feed = AgentLiveActivityFeed(
            active: true, current: nil, steps: [], streaming: false, sessions: nil,
            screenshot: nil, screenshotAt: nil, screenshotSurface: "browser",
            videoDeviceId: nil, macDisplays: nil, previews: [delayed])
        XCTAssertTrue(store.show,
                      "a scoped approved action that starts after linger must not be shadowed")
        XCTAssertEqual(store.presentationState, .connecting)
    }

    func testLiveDockRemountDoesNotResurrectCompletedGeneration() async {
        let remounted = AgentLiveDockStore()
        await remounted.synchronize(
            conversationId: "conversation-1", turnId: "turn-finished",
            turnIsStreaming: false, turnReconnecting: false,
            computerUseToolStartGeneration: 9, computerUseSurface: .mac,
            computerUseConversationId: "conversation-1", computerUseTurnId: "turn-finished",
            performNetwork: false)
        XCTAssertFalse(remounted.show)
        XCTAssertNil(remounted.presentedFeed)
    }

    func testLiveDockRecoversMissedToolStartOnlyFromCurrentScopedTurn() async {
        let store = AgentLiveDockStore()
        await store.synchronize(
            conversationId: "conversation-1", turnId: "turn-current",
            turnIsStreaming: true, turnReconnecting: false,
            computerUseToolStartGeneration: 0, computerUseSurface: nil,
            computerUseConversationId: nil, computerUseTurnId: nil,
            performNetwork: false)
        let stale = AgentLiveActivityPreview(
            surface: "browser", contextId: "browser:old", screenshot: nil,
            screenshotAt: nil, labelBn: "Old", active: true, videoDeviceId: nil,
            turnId: "turn-old", conversationId: "conversation-1")
        store.debugRecoverMissedComputerUse(from: [stale])
        XCTAssertFalse(store.show, "an owner-global stale card must not be adopted")

        let partialScope = AgentLiveActivityPreview(
            surface: "browser", contextId: "browser:partial", screenshot: nil,
            screenshotAt: nil, labelBn: "Partial", active: true, videoDeviceId: nil,
            turnId: "turn-current", conversationId: nil)
        store.debugRecoverMissedComputerUse(from: [partialScope])
        XCTAssertFalse(store.show,
                       "a turn-only rolling-server card must not cross conversation scope")

        let current = AgentLiveActivityPreview(
            surface: "browser", contextId: "browser:current", screenshot: nil,
            screenshotAt: nil, labelBn: "Current", active: true, videoDeviceId: nil,
            turnId: "turn-current", conversationId: "conversation-1",
            activityId: "activity-current")
        store.feed = AgentLiveActivityFeed(
            active: true, current: nil, steps: [], streaming: false, sessions: nil,
            screenshot: nil, screenshotAt: nil, screenshotSurface: "browser",
            videoDeviceId: nil, macDisplays: nil, previews: [current])
        store.debugRecoverMissedComputerUse(from: [current])
        XCTAssertTrue(store.show)
        XCTAssertEqual(store.preferredComputerSurface, .browser)
        XCTAssertEqual(store.selectedPreview?.id, "browser:current")
    }


    func testLiveDockNavigationDropsOldTurnWithoutFinishedLinger() async {
        let store = AgentLiveDockStore()
        await store.synchronize(
            conversationId: "conversation-1", turnId: "turn-1",
            turnIsStreaming: true, turnReconnecting: false,
            computerUseToolStartGeneration: 1, computerUseSurface: .browser,
            computerUseConversationId: "conversation-1", computerUseTurnId: "turn-1",
            performNetwork: false)
        XCTAssertTrue(store.show)

        await store.synchronize(
            conversationId: "conversation-2", turnId: "turn-2",
            turnIsStreaming: false, turnReconnecting: false,
            computerUseToolStartGeneration: 1, computerUseSurface: .browser,
            computerUseConversationId: "conversation-1", computerUseTurnId: "turn-1",
            performNetwork: false)

        XCTAssertFalse(store.show)
        XCTAssertNil(store.presentedFeed)
        XCTAssertNil(store.trackedConversationId)
        XCTAssertNil(store.trackedTurnId)
    }

    func testLiveDockSurvivesReconnectAndWaitsForBackendTerminalConfirmation() async {
        let store = AgentLiveDockStore()
        await store.synchronize(
            conversationId: "conversation-1", turnId: "turn-1",
            turnIsStreaming: true, turnReconnecting: false,
            computerUseToolStartGeneration: 1, computerUseSurface: .browser,
            computerUseConversationId: "conversation-1", computerUseTurnId: "turn-1",
            performNetwork: false)

        store.feed = AgentLiveActivityFeed(
            active: true, current: nil, steps: [], streaming: false, sessions: nil,
            screenshot: nil, screenshotAt: nil, screenshotSurface: "browser",
            videoDeviceId: nil, macDisplays: nil, previews: [])
        await store.synchronize(
            conversationId: "conversation-1", turnId: "turn-1",
            turnIsStreaming: false, turnReconnecting: true,
            computerUseToolStartGeneration: 1, computerUseSurface: .browser,
            computerUseConversationId: "conversation-1", computerUseTurnId: "turn-1",
            performNetwork: false)
        XCTAssertTrue(store.show)
        XCTAssertEqual(store.presentationState, .reconnecting)

        await store.synchronize(
            conversationId: "conversation-1", turnId: "turn-1",
            turnIsStreaming: false, turnReconnecting: false,
            computerUseToolStartGeneration: 1, computerUseSurface: .browser,
            computerUseConversationId: "conversation-1", computerUseTurnId: "turn-1",
            performNetwork: false)
        XCTAssertTrue(store.show,
                      "fresh scoped backend activity must outlive a dropped local SSE flag")

        store.feed = AgentLiveActivityFeed(
            active: false, current: nil, steps: [], streaming: false, sessions: nil,
            screenshot: nil, screenshotAt: nil, screenshotSurface: nil,
            videoDeviceId: nil, macDisplays: nil, previews: [])
        await store.synchronize(
            conversationId: "conversation-1", turnId: "turn-1",
            turnIsStreaming: false, turnReconnecting: false,
            computerUseToolStartGeneration: 1, computerUseSurface: .browser,
            computerUseConversationId: "conversation-1", computerUseTurnId: "turn-1",
            performNetwork: false)
        XCTAssertEqual(store.presentationState, .finished)
        XCTAssertTrue(store.show, "confirmed terminal state keeps only the bounded last-frame linger")
    }

    func testFinishedMacLingerKeepsStillCardButNeverRendersDeviceScopedRTC() async {
        let store = AgentLiveDockStore()
        await store.synchronize(
            conversationId: "conversation-a", turnId: "turn-a",
            turnIsStreaming: true, turnReconnecting: false,
            computerUseToolStartGeneration: 1, computerUseSurface: .mac,
            computerUseConversationId: "conversation-a", computerUseTurnId: "turn-a",
            performNetwork: false)
        let exact = AgentLiveActivityPreview(
            surface: "mac", contextId: "mac:shared-device", screenshot: nil,
            screenshotAt: "2026-08-20T01:00:00.000Z", labelBn: "Task A Mac",
            active: true, videoDeviceId: "shared-device", turnId: "turn-a",
            conversationId: "conversation-a", activityId: "activity-a",
            sourceState: "connecting")
        store.feed = AgentLiveActivityFeed(
            active: true, current: nil, steps: [], streaming: true, sessions: nil,
            screenshot: nil, screenshotAt: exact.screenshotAt, screenshotSurface: "mac",
            videoDeviceId: "shared-device", macDisplays: nil, previews: [exact])
        store.reconcilePreviewSelection([exact])
        XCTAssertTrue(store.shouldRenderRealtimeVideo)

        store.feed = AgentLiveActivityFeed(
            active: false, current: nil, steps: [], streaming: false, sessions: nil,
            screenshot: nil, screenshotAt: exact.screenshotAt, screenshotSurface: "mac",
            videoDeviceId: "shared-device", macDisplays: nil, previews: [exact])
        await store.synchronize(
            conversationId: "conversation-a", turnId: "turn-a",
            turnIsStreaming: false, turnReconnecting: false,
            computerUseToolStartGeneration: 1, computerUseSurface: .mac,
            computerUseConversationId: "conversation-a", computerUseTurnId: "turn-a",
            performNetwork: false)

        XCTAssertEqual(store.presentationState, .finished)
        XCTAssertTrue(store.show, "Task A may retain its exact still during bounded linger")
        XCTAssertEqual(store.selectedPreview?.videoDeviceId, "shared-device",
                       "the regression is meaningful even while the feed still names the device")
        XCTAssertFalse(store.shouldRenderRealtimeVideo,
                       "Task A must leave/hide RTC before Task B can reuse the device channel")
    }

    func testLiveDockStreamOptimismIsBoundedAndClaimRetryIsShort() {
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(AgentLiveDockStore.macStreamClaimRetrySeconds, 4)
        XCTAssertLessThan(AgentLiveDockStore.macStreamClaimRetrySeconds,
                          AgentLiveDockStore.macStreamRenewSeconds)
        XCTAssertEqual(AgentLiveDockStore.reconciledStreamOptimistic(
            true, setAt: start, serverStreaming: false,
            now: start.addingTimeInterval(4.9)), true)
        XCTAssertNil(AgentLiveDockStore.reconciledStreamOptimistic(
            true, setAt: start, serverStreaming: false,
            now: start.addingTimeInterval(5)),
            "no fresh server frame must clear an optimistic stream state")
        XCTAssertNil(AgentLiveDockStore.reconciledStreamOptimistic(
            true, setAt: start, serverStreaming: true,
            now: start.addingTimeInterval(1)))

        XCTAssertEqual(AgentLiveDockStore.browserLeaseCompletionAction(
            requestActivityKey: "activity-a", currentActivityKey: "activity-b",
            currentTrackedActive: true), .stopStaleAndRenewCurrent,
            "late A completion must clean A and immediately renew current B")
        XCTAssertEqual(AgentLiveDockStore.browserLeaseCompletionAction(
            requestActivityKey: "activity-a", currentActivityKey: "activity-a",
            currentTrackedActive: true), .own)
        XCTAssertEqual(AgentLiveDockStore.browserLeaseCompletionAction(
            requestActivityKey: "activity-a", currentActivityKey: nil,
            currentTrackedActive: false), .stopStale)
    }

    func testTaskBoundMacManualControlPayloadKeepsExactScopeAndDisplay() throws {
        let body = AgentLiveDockStore.ComputerUseStreamBody(
            on: true, deviceId: "mac-device-1", maxSeconds: 120,
            displayIndex: 2, reason: "computer_use",
            conversationId: "conversation-1", turnId: "turn-1")
        let data = try JSONEncoder().encode(body)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(object["on"] as? Bool, true)
        XCTAssertEqual(object["deviceId"] as? String, "mac-device-1")
        XCTAssertEqual(object["displayIndex"] as? Int, 2)
        XCTAssertEqual(object["reason"] as? String, "computer_use")
        XCTAssertEqual(object["conversationId"] as? String, "conversation-1")
        XCTAssertEqual(object["turnId"] as? String, "turn-1")
        XCTAssertFalse(AgentLiveDockStore.scopedManualControlBlocksRenewal(streamOn: true),
                       "same-owner start/display must renew beyond the 120-second daemon cap")
        XCTAssertTrue(AgentLiveDockStore.scopedManualControlBlocksRenewal(streamOn: false),
                      "an explicit scoped Stop must not be undone by auto-renewal")
        XCTAssertLessThan(AgentLiveDockStore.macStreamRenewSeconds, 120)
    }
}
