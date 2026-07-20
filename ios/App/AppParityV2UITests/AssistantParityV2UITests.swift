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
}
