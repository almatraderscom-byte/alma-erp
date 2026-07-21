import XCTest

final class AssistantParityV2UITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
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
        let add = app.buttons["ফাইল যোগ করুন"]
        XCTAssertTrue(add.waitForExistence(timeout: 4))
        add.tap()
        XCTAssertTrue(app.buttons["Photo Library"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Files"].exists)
        XCTAssertTrue(app.buttons["Scan Document"].exists)
        XCTAssertTrue(app.buttons["Recent Library"].exists)
        XCTAssertFalse(app.otherElements["Drag Indicator"].exists)
    }

    func testCleanEOFWithoutTerminalRecoversSameTurnWithoutNavigation() {
        relaunch(fixture: "ALMA_ASSISTANT_STREAM_EOF", mock: "streamEOF")
        let recovered = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "একই turn recovery থেকে উত্তর এসেছে")
        ).firstMatch
        XCTAssertTrue(recovered.waitForExistence(timeout: 12))
        XCTAssertTrue(app.staticTexts["আজকের স্টক রিপোর্ট দাও"].exists)
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
        XCTAssertTrue(app.staticTexts["Input"].exists)
        XCTAssertTrue(app.staticTexts["Output"].exists)
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
