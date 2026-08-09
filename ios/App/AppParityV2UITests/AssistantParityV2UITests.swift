import XCTest

final class AssistantParityV2UITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        if name.contains("testPenaltyApprovalSheetKeepsHeaderAndActionReachable") {
            // This test owns a separate, non-submitting Approvals fixture launch;
            // do not make it depend on the Assistant smoke setup below.
            return
        }
        app.launchEnvironment["ALMA_OPEN_ASSISTANT"] = "1"
        app.launchEnvironment["ALMA_ASSISTANT_PARITY"] = "1"
        app.launchEnvironment["ALMA_MERGE_MOCK"] = "library"
        app.launch()
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

    func testAnchoredConversationMenuOpensLibrary() {
        let window = app.windows.firstMatch
        XCTAssertTrue(window.exists)

        // The source control is UIKit-native and now carries an explicit label;
        // querying it is stable across Dynamic Type and device heights.
        let conversationMenu = app.buttons["Conversation menu"]
        XCTAssertTrue(conversationMenu.waitForExistence(timeout: 3))
        conversationMenu.tap()

        let files = app.buttons["Uploaded files"]
        XCTAssertTrue(files.waitForExistence(timeout: 3))
        XCTAssertFalse(app.otherElements["Drag Indicator"].exists)
        files.tap()

        XCTAssertTrue(app.staticTexts["Library"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["Close Library"].exists)
        XCTAssertTrue(app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Generated")).count > 0)
        XCTAssertTrue(app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "Uploaded")).count > 0)
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

        let businessCluster = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "৩টি ব্যবসার data দেখেছে")
        ).firstMatch
        for _ in 0..<4 {
            if businessCluster.isHittable { break }
            app.swipeUp(velocity: .slow)
        }
        XCTAssertTrue(businessCluster.isHittable)
        businessCluster.tap()
        XCTAssertTrue(app.staticTexts["কাজের বিস্তারিত"].waitForExistence(timeout: 3))
        let salesTool = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "get_sales_overview")
        ).firstMatch
        XCTAssertTrue(salesTool.exists)
        salesTool.tap()
        XCTAssertTrue(app.staticTexts["ইনপুট · INPUT"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["ফলাফল · OUTPUT"].exists)
        app.buttons["বন্ধ করুন"].tap()

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

        let modelPicker = app.buttons["মডেল বাছাই"]
        XCTAssertTrue(modelPicker.waitForExistence(timeout: 3))
        modelPicker.tap()
        let sonnet = app.buttons["Claude Sonnet 4.6"]
        XCTAssertTrue(sonnet.waitForExistence(timeout: 4))
        sonnet.tap()
        let selected = NSPredicate(format: "value == %@", "Sonnet 4.6")
        expectation(for: selected, evaluatedWith: modelPicker)
        waitForExpectations(timeout: 4)

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
        XCTAssertFalse(app.staticTexts["Cache write"].exists,
                       "provider billing diagnostics must not clutter normal chat")
        XCTAssertFalse(app.staticTexts["Cache read"].exists)

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

    func testAgentSectionRoutesLiveInDrawerNotOverConversation() {
        let drawer = app.buttons["চ্যাট হিস্টরি"]
        XCTAssertTrue(drawer.waitForExistence(timeout: 3))
        drawer.tap()
        XCTAssertTrue(app.buttons["Chat"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Studio"].exists)
        XCTAssertTrue(app.buttons["WhatsApp"].exists)
        XCTAssertTrue(app.buttons["Monitor"].exists)
        XCTAssertTrue(app.buttons["Costs"].exists)
        XCTAssertTrue(app.buttons["Hub"].exists)
    }

    private func relaunch(fixture: String, mock: String) {
        app.terminate()
        app = XCUIApplication()
        app.launchEnvironment["ALMA_OPEN_ASSISTANT"] = "1"
        app.launchEnvironment[fixture] = "1"
        app.launchEnvironment["ALMA_MERGE_MOCK"] = mock
        app.launch()
        let title = app.staticTexts["ALMA AI"]
        if !title.waitForExistence(timeout: 5) {
            let assistantTab = app.tabBars.buttons["Assistant"]
            XCTAssertTrue(assistantTab.waitForExistence(timeout: 3))
            assistantTab.tap()
        }
        XCTAssertTrue(title.waitForExistence(timeout: 5))
    }
}
