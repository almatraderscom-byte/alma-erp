import XCTest
@testable import App

/// The live transcript must read back exactly what the owner heard. Anything the
/// speech synthesiser does not pronounce has no business appearing in it.
final class LiveVoiceSpokenTranscriptTests: XCTestCase {
    func testBoldEmphasisIsNotPrintedAsMarkers() {
        XCTAssertEqual(
            AlmaLiveVoiceSpokenText.plain("**Boss**, দুপুর ২:১১ বাজে।"),
            "Boss, দুপুর ২:১১ বাজে।")
    }

    func testItalicAndCodeMarkersAreRemoved() {
        XCTAssertEqual(
            AlmaLiveVoiceSpokenText.plain("*আজ* `শূন্য` টাকা"),
            "আজ শূন্য টাকা")
    }

    func testOrdinaryBanglaTextIsUntouched() {
        let line = "আজকে এখনো কোনো বিক্রি হয়নি, মোট বিক্রির পরিমাণ শূন্য টাকা।"
        XCTAssertEqual(AlmaLiveVoiceSpokenText.plain(line), line)
    }

    func testSnakeCaseIdentifierKeepsItsUnderscores() {
        XCTAssertEqual(
            AlmaLiveVoiceSpokenText.plain("get_sales_summary"),
            "get_sales_summary")
    }

    func testLongMarkerRunIsNotEmphasisAndSurvives() {
        XCTAssertEqual(AlmaLiveVoiceSpokenText.plain("****"), "****")
    }

    func testEmptyTranscriptStaysEmpty() {
        XCTAssertEqual(AlmaLiveVoiceSpokenText.plain(""), "")
    }
}
