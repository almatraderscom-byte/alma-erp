import XCTest
@testable import App

/// Gemini Live discards owner content that collides with an open model turn
/// (server "INTERRUPTED model turn", live-reproduced 2026-08-13) — the
/// harness must replay the dropped request instead of making Boss repeat it.
final class LiveVoiceDroppedRequestRecoveryTests: XCTestCase {
    func testStashKeepsLatestMeaningfulTranscript() {
        var recovery = AlmaLiveVoiceDroppedRequestRecovery()
        recovery.stash("এডস ম্যানেজারের রিপোর্ট বের করে দাও")
        recovery.stash("গত সাত দিনের বিক্রি দেখাও")
        XCTAssertEqual(recovery.stashedRequest, "গত সাত দিনের বিক্রি দেখাও")
    }

    func testShortOrEmptyTranscriptsAreRejected() {
        var recovery = AlmaLiveVoiceDroppedRequestRecovery()
        recovery.stash("")
        recovery.stash("   \n ")
        recovery.stash("হুম")
        XCTAssertNil(recovery.stashedRequest)
        // A short filler must never clobber a stashed real request either.
        recovery.stash("রিপোর্ট বের করে দাও")
        recovery.stash("হুম")
        XCTAssertEqual(recovery.stashedRequest, "রিপোর্ট বের করে দাও")
    }

    func testStashTrimsWhitespace() {
        var recovery = AlmaLiveVoiceDroppedRequestRecovery()
        recovery.stash("  এডস রিপোর্ট দাও  \n")
        XCTAssertEqual(recovery.stashedRequest, "এডস রিপোর্ট দাও")
    }

    func testConsumeRespectsBudgetAndClears() {
        var recovery = AlmaLiveVoiceDroppedRequestRecovery()
        let t0 = Date(timeIntervalSince1970: 1_000)
        // Nothing stashed — nothing to resend, and no budget spent.
        XCTAssertNil(recovery.consumeForResend(now: t0))
        recovery.stash("এডস ম্যানেজারের গত সাত দিনের রিপোর্ট বের করে দাও")
        XCTAssertEqual(
            recovery.consumeForResend(now: t0),
            "এডস ম্যানেজারের গত সাত দিনের রিপোর্ট বের করে দাও")
        // Consuming clears the stash — no double replay of the same request.
        XCTAssertNil(recovery.stashedRequest)
        XCTAssertNil(recovery.consumeForResend(now: t0.addingTimeInterval(9)))
        // Too soon after the first resend: spacing refuses, stash survives.
        recovery.stash("আবার সেই রিপোর্টটা দেখাও")
        XCTAssertNil(recovery.consumeForResend(now: t0.addingTimeInterval(3)))
        XCTAssertEqual(recovery.stashedRequest, "আবার সেই রিপোর্টটা দেখাও")
        // Spaced out: second (and last) resend allowed.
        XCTAssertEqual(
            recovery.consumeForResend(now: t0.addingTimeInterval(12)),
            "আবার সেই রিপোর্টটা দেখাও")
        // Budget spent (limit 2 per call) — the truth goes to the owner
        // instead of a third replay.
        recovery.stash("তৃতীয়বারের অনুরোধ এটা")
        XCTAssertNil(recovery.consumeForResend(now: t0.addingTimeInterval(120)))
    }

    func testResendTextCarriesMarkerAndRequest() {
        let request = "এডস ম্যানেজারের গত সাত দিনের রিপোর্ট বের করে দাও"
        let text = AlmaLiveVoiceDroppedRequestRecovery.resendText(request)
        // Marked as a harness correction, NOT new speech from Boss.
        XCTAssertTrue(text.contains("Boss-এর নতুন কথা নয়"))
        XCTAssertTrue(text.contains("«\(request)»"))
        XCTAssertTrue(text.contains("quick_erp_lookup"))
        XCTAssertTrue(text.contains("run_agent_turn"))
    }

    func testClearDropsTheStash() {
        var recovery = AlmaLiveVoiceDroppedRequestRecovery()
        recovery.stash("এডস ম্যানেজারের রিপোর্ট বের করে দাও")
        recovery.clear()
        XCTAssertNil(recovery.stashedRequest)
        XCTAssertNil(recovery.consumeForResend())
    }
}
