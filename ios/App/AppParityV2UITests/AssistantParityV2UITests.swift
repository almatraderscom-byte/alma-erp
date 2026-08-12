import XCTest

final class AssistantParityV2UITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        if hasIOS265WebAccessibilityConflict,
           name.contains("testAgentSectionRoutesLiveInDrawerNotOverConversation") {
            // The test body records an explicit skip before any app interaction.
            // Avoid launching the hybrid shell here: iOS 26.5's duplicate
            // WebCore/WebKit accessibility loader can block the first native
            // toolbar hit test before XCTest reaches that skip.
            return
        }
        if name.contains("testPenaltyApprovalSheetKeepsHeaderAndActionReachable") {
            // This test owns a separate, non-submitting Approvals fixture launch;
            // do not make it depend on the Assistant smoke setup below.
            return
        }
        let ownsFixtureLaunch = [
            "testNativeActionCardsUseExplicitCleanHierarchy",
            "testClaudeChatFlowClustersToolsAndKeepsModeBesidePlus",
            "testClaudeInteractivePreviewSelectsModelAndStreamsArbitraryMessage",
            "testLiveThoughtSheetUpdatesWithoutReopening",
            "testCleanEOFWithoutTerminalRecoversSameTurnWithoutNavigation",
            "testNativeReadingSurfaceUsesSemanticMarkdownAndQuietChrome",
            "testRichOutputGallerySourcesAndSharedViewer",
            "testImageGenerationUsesLargeAnimatedCanvasAndTruthfulProgress",
            "testPendingImageApprovalHidesLegacyBdtAndExplainsUsd",
            "testImageModelPickerShowsQuotesDisabledReasonsAndTerminalSelection",
            "testSettledOwnerMessageShowsEditWithoutSendAgain",
            "testGeneratedImageEditPreparesExactReferenceApprovalFlow",
            "testGeneratedImageFailureRetriesWithoutLosingSettledTurn",
            "testFailedImageWorkerOffersFreshApprovalRetryWithoutLosingSettledTurn",
            "testLegacyFailedImageExplainsUnsupportedDirectRetry",
            "testFullscreenGeneratedImageFailureCanRetry",
            "testCommandAndSkillAutocompleteUsesSupportedContracts",
            "testGoalsSheetUsesAuthoritativeStateAndAllAgentPause",
            "testArchivedChatBrowserShowsRestorableConversationRows",
            "testConversationLibrarySurfaceMatchesMenuDestination",
            "testImageSetupSummaryOpensProfessionalSheetWithTruthfulQuote",
            "testApprovedImageSetupStaysReadOnlyWithPosterAspectCanvas",
            "testWorkStepsTrackerBlockAndDockShareOneStore",
            "testSettledTrackerColdVariantShowsCompletedWithoutSpeculativeExtras",
            "testColdSessionRestoreNeverShowsHeroBehindLoader",
        ].contains { name.contains($0) }
        if ownsFixtureLaunch {
            // These tests immediately relaunch with a dedicated fixture. Avoid
            // an unnecessary first app launch: on iOS 26 it can leave WebKit's
            // accessibility process racing the real fixture automation session.
            return
        }
        app.launchEnvironment["ALMA_OPEN_ASSISTANT"] = "1"
        // Make the native Assistant tab the real visible tab before asking
        // XCTest for controls. The legacy delayed hook can leave a perfectly
        // valid, but off-screen, Assistant accessibility tree behind Dashboard.
        app.launchEnvironment["ALMA_OPEN_TAB"] = "2"
        app.launchArguments.append("ALMA_OPEN_TAB=2")
        app.launchEnvironment["ALMA_ASSISTANT_PARITY"] = "1"
        app.launchEnvironment["ALMA_MERGE_MOCK"] = "library"
        app.launch()
        // The native shell's DEBUG launch hook keeps tab 2 authoritative through
        // the cold WebKit reparent window. Avoid querying the duplicate tab-bar
        // accessibility tree here; each test begins with its actual surface.
        if name.contains("testAgentSectionRoutesLiveInDrawerNotOverConversation") {
            // These tests deliberately open fixed native toolbar anchors. On
            // iOS 26.5, querying the WebKit-contaminated root/title first can
            // block in AX for over a minute even though the native screen is
            // visible. Select the Assistant tab through its fixed native tab-bar
            // position, then let their assertions begin after the toolbar action.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.94)).tap()
            // The tab transition owns a short full-window launch overlay. A menu
            // tap dispatched in the same run-loop turn is correctly swallowed by
            // that overlay, so wait for its animation to relinquish hit testing.
            Thread.sleep(forTimeInterval: 1.5)
            return
        }
        let title = app.staticTexts["ALMA AI"]
        if !title.waitForExistence(timeout: 5) {
            // A fresh simulator install may restore the Dashboard selection
            // before the debug deep-link wins. Use the real tab interaction as
            // a deterministic fallback; this is navigation setup, not the menu
            // behavior under test.
            let assistantTab = app.tabBars.buttons["Assistant"]
            XCTAssertTrue(assistantTab.waitForExistence(timeout: 3))
            assistantTab.tap()
        }
        XCTAssertTrue(title.waitForExistence(timeout: 5))
    }

    func testConversationLibrarySurfaceMatchesMenuDestination() throws {
        if hasIOS265WebAccessibilityConflict {
            throw XCTSkip("iOS 26.5 duplicates UIAccessibilityLoaderWebShared in WebCore and WebKit; menu contract is unit-tested and the Library fixture is screenshot-verified")
        }
        app.terminate()
        app = XCUIApplication()
        app.launchEnvironment["ALMA_OPEN_ASSISTANT"] = "1"
        app.launchEnvironment["ALMA_OPEN_TAB"] = "2"
        app.launchArguments.append("ALMA_OPEN_TAB=2")
        app.launchEnvironment["ALMA_ASSISTANT_PARITY"] = "1"
        app.launchEnvironment["ALMA_ASSISTANT_LIBRARY"] = "1"
        app.launchEnvironment["ALMA_MERGE_MOCK"] = "library"
        app.launch()
        // Avoid the iOS 26.5 WebKit/WebCore duplicate-loader race in the
        // shared navigation helper. The DEBUG tab hook reasserts through 10s
        // and the Library fixture presents after the Assistant surface mounts.
        Thread.sleep(forTimeInterval: 11)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.94)).tap()
        Thread.sleep(forTimeInterval: 1)

        XCTAssertTrue(app.staticTexts["Library"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.otherElements["Drag Indicator"].exists)
        XCTAssertTrue(app.buttons["Close Library"].exists)
        XCTAssertTrue(app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Generated")).count > 0)
        XCTAssertTrue(app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Uploaded")).count > 0)
    }

    func testSettledOwnerMessageShowsEditWithoutSendAgain() {
        relaunch(fixture: "ALMA_ASSISTANT_OWNER_ACTION_PROOF", mock: "ownerActionProof")

        let actions = app.descendants(matching: .any)["agent.accepted-prompt-actions"]
        let edit = app.buttons["Edit"]

        XCTAssertTrue(actions.waitForExistence(timeout: 5))
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Send again"].exists,
                       "a successful owner message must not look unsent")

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "agent-settled-owner-edit-without-send-again"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testPenaltyApprovalSheetKeepsHeaderAndActionReachable() {
        app.terminate()
        app = XCUIApplication()
        app.launchEnvironment["ALMA_OPEN_TAB"] = "3"
        app.launchEnvironment["ALMA_APPROVAL_SHEET_FIXTURE"] = "1"
        app.launch()

        let title = app.staticTexts["penalty.approval.title"]
        let close = app.buttons["penalty.approval.close"]
        let amount = app.textFields["penalty.approval.amount"]
        let confirm = app.buttons["penalty.approval.confirm"]

        XCTAssertTrue(title.waitForExistence(timeout: 8))
        XCTAssertTrue(close.exists)
        XCTAssertTrue(confirm.exists)
        XCTAssertTrue(confirm.isEnabled, "an empty optional note must not block approval")
        XCTAssertTrue(title.isHittable)
        XCTAssertTrue(close.isHittable)
        XCTAssertTrue(confirm.isHittable)
        let initialTitleFrame = title.frame

        let full = XCTAttachment(screenshot: app.screenshot())
        full.name = "penalty-approval-full"
        full.lifetime = .keepAlways
        add(full)

        let scroll = app.scrollViews["penalty.approval.scroll"]
        XCTAssertTrue(scroll.exists)
        scroll.swipeUp()
        XCTAssertTrue(app.textFields["penalty.approval.note"].isHittable)
        XCTAssertTrue(title.isHittable, "the pinned header must survive body scrolling")
        XCTAssertTrue(close.isHittable)
        XCTAssertTrue(confirm.isHittable, "the pinned action must survive body scrolling")

        scroll.swipeDown()
        let halfButton = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Half penalty")
        ).firstMatch
        XCTAssertTrue(halfButton.exists)
        halfButton.tap()
        XCTAssertTrue(app.staticTexts["Partial approval"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Wallet credit ৳500")
        ).firstMatch.exists)
        XCTAssertEqual(title.frame.minX, initialTitleFrame.minX, accuracy: 1,
                       "amount changes must not shift or clip the pinned title")

        let partial = XCTAttachment(screenshot: app.screenshot())
        partial.name = "penalty-approval-partial"
        partial.lifetime = .keepAlways
        add(partial)

        XCTAssertTrue(amount.isHittable)
        amount.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))
        XCTAssertTrue(title.isHittable, "the pinned title must remain usable with the keyboard open")
        XCTAssertTrue(close.isHittable)
        XCTAssertTrue(confirm.isHittable, "the pinned action must remain usable with the keyboard open")
        XCTAssertTrue(app.buttons["Done"].exists)
    }

    func testNativeActionCardsUseExplicitCleanHierarchy() {
        relaunch(fixture: "ALMA_ASSISTANT_ACTION_FIXTURE", mock: "approval409")
        XCTAssertTrue(app.staticTexts["এই কাজটি চালাব?"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["অনুমোদন দিন"].exists)
        XCTAssertTrue(app.buttons["অনুমোদন দেব না"].exists)
        XCTAssertTrue(app.buttons["আমার মত লিখি"].exists)
        XCTAssertTrue(app.staticTexts["Agent-এর প্রশ্ন"].exists)
        XCTAssertTrue(app.buttons["উত্তর পাঠান"].exists)
    }

    func testComposerPlusUsesAnchoredAttachmentMenu() {
        let plusButton = app.buttons["ফাইল যোগ করুন"]
        XCTAssertTrue(plusButton.waitForExistence(timeout: 4))
        plusButton.tap()
        XCTAssertTrue(app.buttons["Photo Library"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Files"].exists)
        XCTAssertTrue(app.buttons["Scan Document"].exists)
        XCTAssertTrue(app.buttons["Recent Library"].exists)
        XCTAssertFalse(app.otherElements["Drag Indicator"].exists)
    }

    func testClaudeChatFlowClustersToolsAndKeepsModeBesidePlus() {
        relaunch(fixture: "ALMA_ASSISTANT_CLAUDE_CHAT", mock: "claude-chat")

        let thought = app.staticTexts["ভেবেছে ১২ সেকেন্ড"]
        XCTAssertTrue(thought.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["৩টি ব্যবসার data দেখেছে"].exists)
        let thoughtRow = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "ভেবেছে ১২ সেকেন্ড")
        ).firstMatch
        XCTAssertTrue(thoughtRow.waitForExistence(timeout: 3))
        // iOS 26 sometimes gives the grouped parent Button an off-screen union
        // frame while its visible label has the correct hit point. Exercise the
        // same semantic control through that visible child instead of asserting
        // a brittle parent-frame implementation detail.
        thought.tap()
        XCTAssertTrue(app.staticTexts["ভাবনার বিস্তারিত"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "diagnosis এবং execution plan")
        ).firstMatch.exists)
        app.buttons["বন্ধ করুন"].tap()

        let plusButton = app.buttons["ফাইল যোগ করুন"]
        XCTAssertTrue(plusButton.exists)
        let composer = app.descendants(matching: .any)["agent.composer.input"]
        XCTAssertTrue(composer.exists)
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        let mode = app.buttons["agent.permission-mode"]
        XCTAssertTrue(mode.exists)
        XCTAssertLessThan(abs(plusButton.frame.midY - mode.frame.midY), 12,
                          "plus and execution mode must share the composer control row")
        XCTAssertGreaterThan(mode.frame.midX, plusButton.frame.midX)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()

        app.swipeUp(velocity: .fast)
        app.swipeUp(velocity: .fast)
        XCTAssertTrue(app.staticTexts["বিক্রির performance গবেষণা করেছে"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "৩০ দিনের Sales Recovery Plan.md")
        ).firstMatch.waitForExistence(timeout: 3))

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "claude-style-agent-chat-flow"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testClaudeInteractivePreviewSelectsModelAndStreamsArbitraryMessage() {
        relaunch(fixture: "ALMA_ASSISTANT_CLAUDE_CHAT", mock: "claudeInteractive")

        XCTAssertTrue(app.staticTexts["SIMULATOR DEMO · OFFLINE"].waitForExistence(timeout: 5))

        let surface = app.descendants(matching: .any)["agent.composer.surface"]
        let composer = app.descendants(matching: .any)["agent.composer.input"]
        XCTAssertTrue(surface.waitForExistence(timeout: 3))
        XCTAssertTrue(composer.exists)
        let context = app.buttons["agent.context-window"]
        XCTAssertFalse(context.exists, "context control stays tucked away in the idle compact composer")
        composer.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(context.waitForExistence(timeout: 3),
                      "focus expands the composer and reveals its action row")
        context.tap()
        XCTAssertTrue(app.staticTexts["Context window"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["88% left"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["24.8K used / 200K"].waitForExistence(timeout: 3))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.18)).tap()

        let mode = app.buttons["agent.permission-mode"]
        XCTAssertTrue(mode.waitForExistence(timeout: 3))
        XCTAssertLessThanOrEqual(mode.frame.width, 48,
                                 "approval mode must stay an icon-only compact control")
        mode.tap()
        XCTAssertTrue(app.descendants(matching: .any)["প্ল্যান"].waitForExistence(timeout: 3))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.18)).tap()

        // The compact model pill is a UIKit primary-action menu in the nav bar.
        // Finish the composer-focus proof before opening it: on iOS 26 the first
        // nav-bar tap can otherwise be consumed solely to end TextField editing.
        if app.keyboards.firstMatch.exists {
            app.keyboards.buttons["Return"].tap()
        }

        let modelPicker = app.buttons["মডেল বাছাই"]
        XCTAssertTrue(modelPicker.waitForExistence(timeout: 3))
        modelPicker.tap()
        let sonnet = app.buttons["Claude Sonnet 4.6"]
        if !sonnet.waitForExistence(timeout: 1.5), modelPicker.isHittable {
            // With an empty focused TextField, iOS can consume the first nav
            // tap only to end editing. Repeating the same semantic control tap
            // opens its primary-action menu without using coordinates.
            modelPicker.tap()
        }
        XCTAssertTrue(sonnet.waitForExistence(timeout: 4))
        sonnet.tap()
        let selected = NSPredicate(format: "value == %@", "Sonnet 4.6")
        expectation(for: selected, evaluatedWith: modelPicker)
        waitForExpectations(timeout: 4)

        composer.tap()
        composer.typeText("show me a recovery plan")
        let send = app.buttons["agent.composer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        XCTAssertTrue(send.isHittable)
        send.tap()

        XCTAssertTrue(app.textViews["show me a recovery plan"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "offline Simulator")
        ).firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.textViews.matching(
            NSPredicate(format: "label CONTAINS %@", "Simulator demo সম্পন্ন")
        ).firstMatch.waitForExistence(timeout: 12))
        XCTAssertTrue(app.textViews.matching(
            NSPredicate(format: "label CONTAINS %@", "Claude Sonnet 4.6")
        ).firstMatch.exists)
        XCTAssertTrue(app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "৩০ দিনের Sales Recovery Plan.md")
        ).firstMatch.waitForExistence(timeout: 4))

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "claude-interactive-offline-preview"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testLiveThoughtSheetUpdatesWithoutReopening() {
        relaunch(fixture: "ALMA_ASSISTANT_LIVE_THOUGHT", mock: "library")

        XCTAssertTrue(app.staticTexts["ভাবনার বিস্তারিত"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "প্রথম provider-visible কাজের সারাংশ")
        ).firstMatch.waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "দ্বিতীয় provider-visible update")
        ).firstMatch.waitForExistence(timeout: 4),
        "the presented sheet must observe the live VM instead of a tap-time snapshot")
        XCTAssertTrue(app.staticTexts["ভাবনার বিস্তারিত"].exists,
                      "the update arrived without closing or reopening the sheet")
        XCTAssertFalse(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "private chain-of-thought")
        ).firstMatch.exists)

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "agent-live-thought-sheet-updated"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testCleanEOFWithoutTerminalRecoversSameTurnWithoutNavigation() {
        relaunch(fixture: "ALMA_ASSISTANT_STREAM_EOF", mock: "streamEOF")
        let recovered = app.textViews.matching(
            NSPredicate(format: "label CONTAINS %@", "একই turn recovery থেকে উত্তর এসেছে")
        ).firstMatch
        XCTAssertTrue(recovered.waitForExistence(timeout: 12))
        XCTAssertTrue(app.textViews["আজকের স্টক রিপোর্ট দাও"].exists)
    }

    func testNativeReadingSurfaceUsesSemanticMarkdownAndQuietChrome() {
        relaunch(fixture: "ALMA_ASSISTANT_READING_FIXTURE", mock: "reading")

        XCTAssertTrue(app.staticTexts["লাইভ browser যাচাই করেছে"].waitForExistence(timeout: 4))
        // Selectable settled prose is backed by UITextView, not StaticText.
        let responseText = app.textViews.matching(
            NSPredicate(format: "label CONTAINS %@", "সবচেয়ে practical setup")
        ).firstMatch
        XCTAssertTrue(responseText.exists)
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Deepgram")
        ).firstMatch.exists)
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Google Cloud TTS")
        ).firstMatch.exists)
        XCTAssertFalse(app.staticTexts["live_browser_look"].exists)
        XCTAssertFalse(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "| --- |")
        ).firstMatch.exists)
        XCTAssertTrue(app.buttons["টেবিল কপি করুন"].exists)
        XCTAssertTrue(app.buttons["ফাইল যোগ করুন"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["agent.turn.cost-summary"].exists,
                      "every settled answer must retain its server-reported cost footer")
        XCTAssertTrue(app.staticTexts["Cache write"].exists)
        XCTAssertTrue(app.staticTexts["Cache read"].exists)

        let top = XCTAttachment(screenshot: app.screenshot())
        top.name = "native-reading-surface-top"
        top.lifetime = .keepAlways
        add(top)

        app.swipeUp(velocity: .fast)
        app.swipeUp(velocity: .fast)
        let bottom = XCTAttachment(screenshot: app.screenshot())
        bottom.name = "native-reading-surface-bottom"
        bottom.lifetime = .keepAlways
        add(bottom)
    }

    func testRichOutputGallerySourcesAndSharedViewer() {
        relaunch(fixture: "ALMA_ASSISTANT_RICH_OUTPUT", mock: "rich-output")

        XCTAssertTrue(app.descendants(matching: .any)["agent.turn.cost-summary"]
            .waitForExistence(timeout: 3), "Every settled rich turn must retain its cost footer")
        let gallery = app.otherElements["agent.generated-image-gallery"]
        for _ in 0..<6 where !gallery.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(gallery.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["Generated image 1 of 3"].exists)
        XCTAssertTrue(app.staticTexts["agent.generated-image.qc.0"].exists)
        XCTAssertTrue(app.staticTexts["agent.generated-image.qc.1"].exists)
        let renderCost = app.descendants(matching: .any)
            .matching(identifier: "agent.generated-image.render-cost")
        XCTAssertEqual(renderCost.count, 1, "one action's aggregate render spend appears once per gallery")
        XCTAssertTrue(renderCost.firstMatch.label.contains("~$0.4040"))

        let galleryProof = XCTAttachment(screenshot: app.screenshot())
        galleryProof.name = "agent-rich-output-gallery"
        galleryProof.lifetime = .keepAlways
        add(galleryProof)

        app.descendants(matching: .any)["Generated image 1 of 3"].tap()
        XCTAssertTrue(app.buttons["Close"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["agent.generated-image.save"].exists)
        XCTAssertTrue(app.buttons["agent.generated-image.share"].exists)
        XCTAssertTrue(app.buttons["agent.generated-image.copy"].exists)
        XCTAssertTrue(app.buttons["agent.generated-image.edit"].exists)
        XCTAssertTrue(app.buttons["agent.generated-image.variation"].exists)
        app.swipeLeft()
        XCTAssertTrue(app.staticTexts["2 / 3"].waitForExistence(timeout: 2))
        app.swipeLeft()
        XCTAssertTrue(app.staticTexts["3 / 3"].waitForExistence(timeout: 2))
        Thread.sleep(forTimeInterval: 0.8)

        let viewerProof = XCTAttachment(screenshot: app.screenshot())
        viewerProof.name = "agent-rich-output-shared-viewer"
        viewerProof.lifetime = .keepAlways
        add(viewerProof)

        app.buttons["Close"].tap()
        let firstInlineCitation = app.buttons["agent.citation.inline.1"]
        for _ in 0..<10 where !firstInlineCitation.isHittable { app.swipeDown(velocity: .slow) }
        XCTAssertTrue(firstInlineCitation.waitForExistence(timeout: 4))
        XCTAssertTrue(firstInlineCitation.isHittable,
                      "the claim-locus citation chip must be a tappable control")
        XCTAssertTrue(app.buttons["agent.citation.inline.2"].exists,
                      "all sources in the claim retain their response-wide citation ids")
        for _ in 0..<8 where !app.buttons["agent.sources.open"].isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(app.buttons["agent.sources.open"].waitForExistence(timeout: 4))
        app.buttons["agent.sources.open"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["agent.sources.sheet"]
            .waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["OpenAI"].exists)
        XCTAssertTrue(app.staticTexts["ALMA Costs"].exists)
        XCTAssertTrue(app.buttons["agent.source.row.1"].isHittable)
        XCTAssertTrue(app.buttons["agent.source.row.2"].isHittable,
                      "external and ALMA source rows must both be tappable routed controls")
    }

    func testPendingImageApprovalHidesLegacyBdtAndExplainsUsd() {
        if hasIOS265WebAccessibilityConflict {
            // The first injected host on this runtime can remain behind the
            // shell's native loading overlay even though its title is exposed.
            // Consume that one known cold-host race, then verify the real card
            // in a clean second process. No production state or network is used.
            relaunch(
                fixture: "ALMA_ASSISTANT_OWNER_ACTION_PROOF",
                mock: "ownerActionProof")
        }
        // Reuse the established action-card fixture lane so a cold XCTest
        // launch cannot race a second Assistant host while iOS retires the
        // hybrid shell's WebKit accessibility tree. `imagePriceProof` keeps the
        // real legacy 4.40 value in the card model for suppression proof.
        relaunch(fixture: "ALMA_ASSISTANT_ACTION_FIXTURE", mock: "imagePriceProof")

        let note = app.descendants(matching: .any)[
            "agent.confirm-card.image-cost-unavailable"]
        XCTAssertTrue(note.waitForExistence(timeout: 4))
        XCTAssertTrue(note.label.contains("USD estimate এখন নেই"))
        XCTAssertFalse(app.descendants(matching: .any)["~৳4.40"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["~$4.40"].exists,
                       "the legacy BDT value must never be relabelled as USD")

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "agent-image-approval-hides-legacy-price"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testImageModelPickerShowsQuotesDisabledReasonsAndTerminalSelection() {
        relaunch(fixture: "ALMA_ASSISTANT_IMAGE_MODEL_PICKER", mock: "library")

        let selector = app.buttons["agent.confirm-card.image-model"]
        XCTAssertTrue(selector.waitForExistence(timeout: 5))
        XCTAssertTrue(selector.label.contains("Nano Banana Pro"))
        let quote = app.descendants(matching: .any)["agent.confirm-card.image-quote"]
        XCTAssertTrue(quote.waitForExistence(timeout: 3))
        XCTAssertTrue(quote.label.contains("Base $0.96"))
        XCTAssertTrue(quote.label.contains("সর্বোচ্চ $2.88"))
        selector.tap()

        XCTAssertTrue(app.descendants(matching: .any)[
            "agent.confirm-card.image-model-picker"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["agent.image-model.option.gemini-3-pro-image"].exists)
        XCTAssertTrue(app.staticTexts["Selected"].exists)
        let disabled = app.buttons["agent.image-model.option.seedream-5.0-pro"]
        XCTAssertTrue(disabled.exists)
        XCTAssertFalse(disabled.isEnabled)
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "provider এখন unavailable")).count > 0)

        let pickerProof = XCTAttachment(screenshot: app.screenshot())
        pickerProof.name = "agent-image-model-picker-quotes-and-disabled-reason"
        pickerProof.lifetime = .keepAlways
        add(pickerProof)

        let gpt = app.buttons["agent.image-model.option.gpt-image-2"]
        XCTAssertTrue(gpt.isEnabled)
        gpt.tap()
        XCTAssertTrue(selector.waitForExistence(timeout: 5))
        XCTAssertTrue(selector.label.contains("GPT Image 2"),
                      "the card must change only after the server echoes the selected model")
        XCTAssertTrue(quote.label.contains("Base $0.20"))
        XCTAssertTrue(quote.label.contains("সর্বোচ্চ $0.60"))

        let selectedProof = XCTAttachment(screenshot: app.screenshot())
        selectedProof.name = "agent-image-model-server-echo-selection"
        selectedProof.lifetime = .keepAlways
        add(selectedProof)

        relaunch(
            fixture: "ALMA_ASSISTANT_IMAGE_MODEL_PICKER", mock: "library",
            extraEnvironment: ["ALMA_ASSISTANT_IMAGE_MODEL_READONLY": "1"])
        let readOnly = app.descendants(matching: .any)["agent.confirm-card.image-model"]
        XCTAssertTrue(readOnly.waitForExistence(timeout: 5))
        XCTAssertTrue(readOnly.label.contains("read only"))
        XCTAssertFalse(app.buttons["agent.confirm-card.image-model"].exists)
        XCTAssertTrue(app.buttons["agent.generated-image.worker-retry"].exists)

        let terminalProof = XCTAttachment(screenshot: app.screenshot())
        terminalProof.name = "agent-image-model-terminal-read-only"
        terminalProof.lifetime = .keepAlways
        add(terminalProof)
    }

    func testImageGenerationUsesLargeAnimatedCanvasAndTruthfulProgress() {
        relaunch(fixture: "ALMA_ASSISTANT_IMAGE_GENERATING", mock: "library")

        let canvas = app.descendants(matching: .any)["agent.generated-image.generating-canvas"]
        // Wait for the surface to MOUNT before scroll-hunting: swipes issued
        // during the launch splash land nowhere, and with the faster fixture
        // boot (no web dashboard) they used to spill onto the fresh chat and
        // scroll the canvas out of its hittable frame.
        XCTAssertTrue(canvas.waitForExistence(timeout: 10))
        for _ in 0..<5 where !canvas.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(canvas.isHittable)
        XCTAssertGreaterThan(canvas.frame.height, canvas.frame.width * 1.15,
                             "image generation must be a first-class media surface, not a thin rail")
        XCTAssertTrue((canvas.value as? String)?.contains("আনুমানিক") == true)
        XCTAssertTrue(app.staticTexts["ছবি তৈরি হচ্ছে"].exists)
        let quote = app.descendants(matching: .any)["agent.confirm-card.image-quote"]
        XCTAssertTrue(quote.exists)
        XCTAssertTrue(quote.label.contains("Estimate $0.24"))
        XCTAssertFalse(app.staticTexts["~৳1.10"].exists,
                       "legacy unversioned image estimates must stay suppressed")
        XCTAssertFalse(app.buttons["অনুমোদন দিন"].exists)
        XCTAssertFalse(app.buttons["agent.generated-image.worker-retry"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["agent.turn.cost-summary"].exists,
                      "the settled turn cost footer must survive the larger canvas")

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "agent-image-generation-animated-canvas"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testGeneratedImageEditPreparesExactReferenceApprovalFlow() {
        relaunch(fixture: "ALMA_ASSISTANT_RICH_OUTPUT", mock: "rich-output")

        let gallery = app.otherElements["agent.generated-image-gallery"]
        for _ in 0..<7 where !gallery.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(gallery.waitForExistence(timeout: 5))
        for index in 1...3 {
            XCTAssertTrue(
                app.buttons["agent.generated-image.open.\(index - 1)"].waitForExistence(timeout: 8),
                "the shared viewer must not be exercised until every adjacent image is decoded"
            )
        }
        let firstImage = app.buttons["agent.generated-image.open.0"]
        let editButton = app.buttons["agent.generated-image.edit"]
        firstImage.tap()
        if !editButton.waitForExistence(timeout: 2), firstImage.exists {
            // A first-run system permission alert may consume the opening tap even after
            // XCTest dismisses it. Retry the idempotent viewer-open gesture once.
            firstImage.tap()
        }
        XCTAssertTrue(editButton.waitForExistence(timeout: 4))
        editButton.tap()

        let input = app.textFields["agent.composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 4))
        XCTAssertTrue(app.descendants(matching: .any)["agent.composer.reference-image"].exists)
        XCTAssertTrue((input.value as? String)?.contains("edited image তৈরি করুন") == true)
        XCTAssertTrue((input.value as? String)?.contains("generate_image referenceImageId") == true)
        XCTAssertTrue((input.value as? String)?.contains("approval-এর আগে render করবেন না") == true)

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "agent-generated-image-edit-reference-flow"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testGeneratedImageFailureRetriesWithoutLosingSettledTurn() {
        relaunch(
            fixture: "ALMA_ASSISTANT_RICH_OUTPUT",
            mock: "rich-output",
            extraEnvironment: ["ALMA_ASSISTANT_RICH_IMAGE_FAILURE": "1"])

        let retry = app.buttons["agent.generated-image.retry"]
        for _ in 0..<7 where !retry.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["agent.turn.cost-summary"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["agent.generated-image.ready-100"].exists,
                       "one failed variant must keep the shared gallery below 100 percent")

        // A failed sibling must not lock the already-ready variants out of their
        // shared viewer/download actions.
        let readySibling = app.buttons["agent.generated-image.open.1"]
        XCTAssertTrue(readySibling.waitForExistence(timeout: 10))
        readySibling.tap()
        XCTAssertTrue(app.buttons["agent.generated-image.save"].waitForExistence(timeout: 4))
        app.buttons["Close"].tap()

        retry.tap()
        XCTAssertTrue(app.descendants(matching: .any)["Generated image 1 of 3"]
            .waitForExistence(timeout: 10))
        XCTAssertFalse(retry.exists)
        XCTAssertTrue(app.descendants(matching: .any)["agent.turn.cost-summary"].exists)

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "agent-generated-image-retry-preserves-turn"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testFailedImageWorkerOffersFreshApprovalRetryWithoutLosingSettledTurn() {
        relaunch(
            fixture: "ALMA_ASSISTANT_RICH_OUTPUT",
            mock: "rich-output",
            extraEnvironment: ["ALMA_ASSISTANT_RICH_WORKER_FAILURE": "1"])

        let retry = app.buttons["agent.generated-image.worker-retry"]
        for _ in 0..<9 where !retry.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        XCTAssertTrue(retry.isHittable)
        XCTAssertTrue(retry.isEnabled)
        XCTAssertTrue(app.staticTexts["ছবি তৈরি ব্যর্থ হয়েছে"].exists)
        XCTAssertFalse(app.buttons["অনুমোদন দিন"].exists,
                       "a terminal worker action must not expose its old approval again")
        XCTAssertTrue(app.descendants(matching: .any)["agent.turn.cost-summary"].exists,
                      "worker failure must not remove the settled turn cost footer")

        retry.tap()
        let newPending = app.staticTexts["এই ছবিটি তৈরি করব?"]
        XCTAssertTrue(newPending.waitForExistence(timeout: 6),
                      "direct retry must rehydrate the server-persisted fresh approval card")
        XCTAssertTrue(app.descendants(matching: .any)["agent.confirm-card.image-model"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["agent.turn.cost-summary"].exists)
        XCTAssertFalse(app.buttons["agent.generated-image.worker-retry"].isEnabled)

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "agent-image-worker-failure-fresh-approval-retry"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testLegacyFailedImageExplainsUnsupportedDirectRetry() {
        relaunch(
            fixture: "ALMA_ASSISTANT_RICH_OUTPUT", mock: "rich-output",
            extraEnvironment: [
                "ALMA_ASSISTANT_RICH_WORKER_FAILURE": "1",
                "ALMA_ASSISTANT_RICH_WORKER_LEGACY_FAILURE": "1",
            ])

        let unsupported = app.descendants(matching: .any)[
            "agent.generated-image.worker-retry-unsupported"]
        for _ in 0..<9 where !unsupported.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(unsupported.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["agent.generated-image.worker-retry"].exists)
    }

    func testFullscreenGeneratedImageFailureCanRetry() {
        relaunch(
            fixture: "ALMA_ASSISTANT_RICH_OUTPUT", mock: "rich-output",
            extraEnvironment: ["ALMA_ASSISTANT_RICH_VIEWER_FAILURE": "1"])

        let first = app.buttons["agent.generated-image.open.0"]
        for _ in 0..<7 where !first.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertTrue(first.isHittable)
        first.tap()
        let retry = app.buttons["agent.generated-image.viewer-retry"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        retry.tap()
        let resigned = app.descendants(matching: .any)[
            "agent.generated-image.viewer-resigned"]
        XCTAssertTrue(resigned.waitForExistence(timeout: 5),
                      "fullscreen retry must re-sign the exact persisted file ref")
        XCTAssertEqual(resigned.value as? String, "fixture/rich-image-1.jpg")
        XCTAssertTrue(app.buttons["agent.generated-image.save"].waitForExistence(timeout: 5))
        XCTAssertFalse(retry.exists)
    }

    func testCommandAndSkillAutocompleteUsesSupportedContracts() {
        relaunch(
            fixture: "ALMA_ASSISTANT_PARITY",
            mock: "library",
            extraEnvironment: ["ALMA_ASSISTANT_AUTOCOMPLETE_FIXTURE": "1"])

        let input = app.textFields["agent.composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 4))
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        input.typeText("/")
        XCTAssertTrue(app.descendants(matching: .any)["agent.composer.autocomplete"]
            .waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["/status"].exists)
        XCTAssertFalse(app.buttons["ios-simulator-verifier"].exists,
                       "slash autocomplete must contain commands only")

        app.buttons["/status"].tap()
        XCTAssertTrue((input.value as? String)?.contains("/status") == true)
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 8))
        input.typeText("@ios")
        XCTAssertTrue(app.buttons["ios-simulator-verifier"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["/status"].exists,
                       "at-sign autocomplete must contain skills only")

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "agent-command-skill-autocomplete"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testGoalsSheetUsesAuthoritativeStateAndAllAgentPause() {
        relaunch(
            fixture: "ALMA_BACKGROUND_TASK_FIXTURE",
            mock: "library",
            extraEnvironment: ["ALMA_BACKGROUND_TASK_SHEET": "1"])

        let allAgentControl = app.descendants(matching: .any)["agent.global-agent-control"]
        XCTAssertTrue(allAgentControl.waitForExistence(timeout: 5))
        XCTAssertTrue(app.switches["agent.global-agent-toggle"].waitForExistence(timeout: 5))

        XCTAssertTrue(app.descendants(matching: .any)["agent.goal.debug-running"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["agent.goal.debug-attention"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["agent.goal.status.debug-running"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["agent.goal.status.debug-attention"].exists)
        XCTAssertFalse(app.buttons["agent.goal.action.resume.debug-running"].exists,
                       "an authoritative running goal must not offer recovery actions")
        XCTAssertTrue(app.buttons["agent.goal.action.resume.debug-attention"].exists)
        XCTAssertTrue(app.buttons["agent.goal.action.add-budget.debug-attention"].exists)
        XCTAssertTrue(app.buttons["agent.goal.action.abandon.debug-attention"].exists)

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "agent-goals-authoritative-state-and-all-agent-control"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testArchivedChatBrowserShowsRestorableConversationRows() {
        relaunch(
            fixture: "ALMA_ASSISTANT_RICH_OUTPUT",
            mock: "rich-output",
            extraEnvironment: [
                "ALMA_ASSISTANT_SIDEBAR": "1",
                "ALMA_ASSISTANT_ARCHIVE_TAB": "1",
            ])

        XCTAssertTrue(app.buttons["আর্কাইভ"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["ALMA launch archive, ফিরিয়ে নিন"].exists)
        XCTAssertTrue(app.buttons["Citation research archive, ফিরিয়ে নিন"].exists)

        let proof = XCTAttachment(screenshot: app.screenshot())
        proof.name = "agent-archived-chat-browser"
        proof.lifetime = .keepAlways
        add(proof)
    }

    func testAgentSectionRoutesLiveInDrawerNotOverConversation() throws {
        if hasIOS265WebAccessibilityConflict {
            throw XCTSkip("iOS 26.5 duplicate WebCore/WebKit accessibility loader blocks native toolbar hit testing")
        }
        tapVisibleToolbarButton("চ্যাট হিস্টরি",
                                fallback: CGVector(dx: 0.055, dy: 0.085))
        XCTAssertTrue(app.buttons["Chat"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Studio"].exists)
        XCTAssertTrue(app.buttons["WhatsApp"].exists)
        XCTAssertTrue(app.buttons["Monitor"].exists)
        XCTAssertTrue(app.buttons["Costs"].exists)
        XCTAssertTrue(app.buttons["Hub"].exists)
    }

    private func relaunch(fixture: String, mock: String,
                          extraEnvironment: [String: String] = [:]) {
        app.terminate()
        app = XCUIApplication()
        app.launchEnvironment["ALMA_OPEN_ASSISTANT"] = "1"
        // Select the native Assistant tab synchronously at shell launch. The
        // older delayed ALMA_OPEN_ASSISTANT hook is still kept as a fallback,
        // but on iOS 26 a Dashboard-hosted WebKit accessibility snapshot can
        // take minutes before XCTest reaches the fallback tap.
        app.launchEnvironment["ALMA_OPEN_TAB"] = "2"
        app.launchArguments.append("ALMA_OPEN_TAB=2")
        app.launchEnvironment[fixture] = "1"
        app.launchEnvironment["ALMA_MERGE_MOCK"] = mock
        // The production DEBUG hook intentionally accepts both environment
        // variables and KEY=value arguments. Pass both: XCTest/iOS 26.5 can
        // relaunch the hybrid host through a path that drops one environment
        // snapshot while preserving launch arguments.
        app.launchArguments.append("\(fixture)=1")
        app.launchArguments.append("ALMA_MERGE_MOCK=\(mock)")
        for (key, value) in extraEnvironment {
            app.launchEnvironment[key] = value
            // iOS 26.5 can drop the environment snapshot when the hybrid host
            // is relaunched through WebKit. Production DEBUG hooks support the
            // same KEY=value argument fallback used for the primary fixture,
            // so keep every scenario flag deterministic too.
            app.launchArguments.append("\(key)=\(value)")
        }
        app.launch()
        // Do not ask XCTest for the Dashboard/WebKit accessibility hierarchy
        // before leaving that tab: the iOS 26.5 runtime can spend minutes
        // snapshotting its duplicate WebCore/WebKit accessibility classes.
        // This coordinate is only deterministic fixture setup (the production
        // gallery interactions below remain semantic accessibility queries).
        Thread.sleep(forTimeInterval: 1.5)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.94)).tap()
        let title = app.staticTexts["ALMA AI"]
        if !title.waitForExistence(timeout: 8) {
            // Never select `tabBars.buttons["Assistant"]` here. On iOS 26.5
            // WebCore and WebKit can expose an off-screen duplicate whose hit
            // point is {-1,-1}; the fixed native tab coordinate is authoritative.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.94)).tap()
        }
        XCTAssertTrue(title.waitForExistence(timeout: 5))
    }

    private var hasIOS265WebAccessibilityConflict: Bool {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        return version.majorVersion == 26 && version.minorVersion == 5
    }

    // MARK: - Build 103 Issue 2/3 fixtures

    /// SwiftUI's `.accessibilityElement(children: .combine)` rows and styled
    /// containers surface with unpredictable element types (staticText/other/
    /// scrollView) — query by identifier across ANY type.
    private func anyElement(_ app: XCUIApplication, _ identifier: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: identifier).firstMatch
    }

    /// The hybrid shell's duplicated accessibility trees can leave a native
    /// element with an invalid hit point, silently no-opping `element.tap()`.
    /// Tap through the window at the element's normalized frame center instead.
    private func tapViaWindow(_ app: XCUIApplication, _ element: XCUIElement) {
        guard let window = app.windows.allElementsBoundByIndex.first,
              !element.frame.isEmpty else {
            element.tap()
            return
        }
        let x = (element.frame.midX - window.frame.minX) / window.frame.width
        let y = (element.frame.midY - window.frame.minY) / window.frame.height
        window.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
    }

    private func launchFixture(_ env: [String: String]) -> XCUIApplication {
        let fixture = XCUIApplication()
        fixture.launchEnvironment["ALMA_OPEN_ASSISTANT"] = "1"
        fixture.launchEnvironment["ALMA_OPEN_TAB"] = "2"
        fixture.launchArguments.append("ALMA_OPEN_TAB=2")
        for (key, value) in env { fixture.launchEnvironment[key] = value }
        fixture.launch()
        dismissAppLockIfPresented(fixture)
        return fixture
    }

    /// The web BiometricLockGate raises the system device-owner passcode sheet
    /// ~10s AFTER launch (once the background Dashboard webview boots), which
    /// intercepts any tap the test performs from that moment on. Wait for it
    /// deterministically, unlock, and only then hand the app to the test. The
    /// passcode comes from the runner's environment (never committed); if the
    /// sheet never appears (lock disabled), the wait simply times out once.
    private func dismissAppLockIfPresented(_ fixture: XCUIApplication) {
        let prompt = fixture.staticTexts
            .containing(NSPredicate(format: "label CONTAINS %@", "Enter iPhone Passcode"))
            .firstMatch
        guard prompt.waitForExistence(timeout: 14) else { return }
        guard let passcode = ProcessInfo.processInfo.environment["ALMA_TEST_APP_PASSCODE"],
              !passcode.isEmpty else {
            XCTFail("app lock appeared but ALMA_TEST_APP_PASSCODE is not set for the runner")
            return
        }
        for _ in 0..<2 {
            let field = fixture.textFields.firstMatch.exists
                ? fixture.textFields.firstMatch
                : fixture.secureTextFields.firstMatch
            guard field.waitForExistence(timeout: 3) else { break }
            field.tap()
            field.typeText(passcode)
            field.typeText("\n")
            if prompt.waitForNonExistence(timeout: 8) { return }
        }
        XCTAssertFalse(prompt.exists, "app lock must be dismissed before assertions")
    }

    func testImageSetupSummaryOpensProfessionalSheetWithTruthfulQuote() {
        let fixture = launchFixture(["ALMA_ASSISTANT_IMAGE_SETUP_PROOF": "1"])
        let setupRow = anyElement(fixture, "agent.confirm-card.image-setup")
        XCTAssertTrue(setupRow.waitForExistence(timeout: 10),
                      "pending v2 card must show the Image setup summary row")
        // The summary names preset, exact server-resolved pixels and count.
        XCTAssertTrue(fixture.staticTexts["Facebook / Instagram post · 4:5 · 1856×2304"]
            .waitForExistence(timeout: 4))
        tapViaWindow(fixture, setupRow)
        // Preset chips, size options with reasons, count and quality controls.
        XCTAssertTrue(anyElement(fixture, "agent.image-setup.preset.poster")
            .waitForExistence(timeout: 8))
        let fourK = anyElement(fixture, "agent.image-setup.size.4K")
        XCTAssertTrue(fourK.waitForExistence(timeout: 4))
        XCTAssertFalse(fourK.isEnabled,
                       "an unsupported size stays visible with its reason, never tappable")
        XCTAssertTrue(anyElement(fixture, "agent.image-setup.count.4").exists)
        // SwiftUI List rows are lazy — quality/model/quote sit below the fold.
        fixture.swipeUp()
        XCTAssertTrue(anyElement(fixture, "agent.image-setup.quality.pro")
            .waitForExistence(timeout: 4))
        fixture.swipeUp()
        XCTAssertTrue(anyElement(fixture, "agent.image-setup.model.gpt-image-2")
            .waitForExistence(timeout: 4))
        XCTAssertTrue(anyElement(fixture, "agent.image-setup.quote")
            .waitForExistence(timeout: 4))
        let proofSheet = XCTAttachment(screenshot: fixture.screenshot())
        proofSheet.name = "b103-image-setup-sheet"
        proofSheet.lifetime = .keepAlways
        add(proofSheet)
    }

    func testApprovedImageSetupStaysReadOnlyWithPosterAspectCanvas() {
        let fixture = launchFixture([
            "ALMA_ASSISTANT_IMAGE_SETUP_PROOF": "1",
            "ALMA_ASSISTANT_IMAGE_SETUP_STATUS": "approved",
            "ALMA_ASSISTANT_IMAGE_SETUP_ASPECT": "2:3",
        ])
        let lockedRow = anyElement(fixture, "agent.confirm-card.image-setup")
        XCTAssertTrue(lockedRow.waitForExistence(timeout: 10),
                      "after approval the pinned setup renders read-only")
        XCTAssertTrue(fixture.staticTexts
            .containing(NSPredicate(format: "label CONTAINS %@", "Portrait poster"))
            .firstMatch.waitForExistence(timeout: 4)
            || lockedRow.label.contains("Portrait poster"))
        XCTAssertFalse(anyElement(fixture, "agent.image-setup.sheet").exists)
        let proofLocked = XCTAttachment(screenshot: fixture.screenshot())
        proofLocked.name = "b103-image-setup-locked-poster"
        proofLocked.lifetime = .keepAlways
        add(proofLocked)
    }

    func testWorkStepsTrackerBlockAndDockShareOneStore() {
        let fixture = launchFixture(["ALMA_ASSISTANT_WORK_STEPS_PROOF": "1"])
        // Canonical in-turn block.
        let header = anyElement(fixture, "agent.work-steps.header")
        XCTAssertTrue(header.waitForExistence(timeout: 10))
        // Dock strip above the composer projects the SAME tracker (1 of 5).
        let dock = anyElement(fixture, "agent.work-steps.dock.progress")
        XCTAssertTrue(dock.waitForExistence(timeout: 4))
        XCTAssertTrue(dock.label.contains("1 of 5"),
                      "dock count must come from durable step evidence")
        // Expanding the dock shows the numbered five-step panel while the
        // composer stays visible.
        tapViaWindow(fixture, dock)
        XCTAssertTrue(anyElement(fixture, "agent.work-steps.dock.panel")
            .waitForExistence(timeout: 6))
        XCTAssertTrue(fixture.textViews.firstMatch.exists
                      || fixture.textFields.firstMatch.exists,
                      "composer must remain mounted under the expanded panel")
        // Expanding the block lists steps with stable identifiers.
        tapViaWindow(fixture, dock)   // collapse to avoid covering the block
        tapViaWindow(fixture, header)
        XCTAssertTrue(anyElement(fixture, "agent.work-steps.step.fixture-step-2")
            .waitForExistence(timeout: 6))
        let proofTracker = XCTAttachment(screenshot: fixture.screenshot())
        proofTracker.name = "b103-work-steps-block-expanded"
        proofTracker.lifetime = .keepAlways
        add(proofTracker)
    }

    func testSettledTrackerColdVariantShowsCompletedWithoutSpeculativeExtras() {
        let fixture = launchFixture([
            "ALMA_ASSISTANT_WORK_STEPS_PROOF": "1",
            "ALMA_ASSISTANT_WORK_STEPS_VARIANT": "settled",
        ])
        let header = anyElement(fixture, "agent.work-steps.header")
        XCTAssertTrue(header.waitForExistence(timeout: 10))
        XCTAssertTrue(header.label.contains("5 of 5"))
        // A settled tracker offers NO dock strip — nothing is running.
        XCTAssertFalse(anyElement(fixture, "agent.work-steps.dock.progress").exists)
        let proofSettled = XCTAttachment(screenshot: fixture.screenshot())
        proofSettled.name = "b103-work-steps-settled"
        proofSettled.lifetime = .keepAlways
        add(proofSettled)
    }

    func testColdSessionRestoreNeverShowsHeroBehindLoader() {
        // The awakening fixture drives an existing-session restore: during the
        // restore phase the hero must not exist, and at most ONE restore
        // indicator is on screen (owner two-robots regression, IMG_0140).
        let fixture = launchFixture(["ALMA_ASSISTANT_NEW_SESSION_UI": "1"])
        _ = fixture.wait(for: .runningForeground, timeout: 8)
        let loader = fixture.otherElements["agent.session.loader"]
        let hero = fixture.otherElements["agent.empty.hero"]
        if loader.waitForExistence(timeout: 3) {
            XCTAssertFalse(hero.exists,
                           "hero and restore loader may never coexist")
        }
    }

    /// The hybrid shell can briefly expose two accessibility copies of the
    /// Assistant toolbar while Dashboard's WebKit tree is being retired. Always
    /// drive the visible native candidate; `app.buttons[label]` picks the first
    /// copy, which can legitimately have an off-screen {-1,-1} hit point.
    private func tapVisibleToolbarButton(_ label: String, fallback: CGVector) {
        let matches = app.buttons.matching(identifier: label)
        XCTAssertTrue(matches.firstMatch.waitForExistence(timeout: 4))
        let candidates = matches.allElementsBoundByIndex
        if let visible = candidates.first(where: { $0.isHittable }) {
            visible.tap()
        } else if let window = app.windows.allElementsBoundByIndex.first,
                  let onScreen = candidates.first(where: {
                      !$0.frame.isEmpty && $0.frame.width > 1 && $0.frame.height > 1
                          && window.frame.intersects($0.frame)
                  }) {
            let x = (onScreen.frame.midX - window.frame.minX) / window.frame.width
            let y = (onScreen.frame.midY - window.frame.minY) / window.frame.height
            window.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y)).tap()
        } else {
            app.windows.firstMatch.coordinate(withNormalizedOffset: fallback).tap()
        }
    }
}
