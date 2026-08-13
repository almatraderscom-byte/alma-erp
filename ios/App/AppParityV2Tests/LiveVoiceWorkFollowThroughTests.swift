import XCTest
@testable import App

/// The live model may not settle a work-promising turn without a tool call —
/// the same claim-verifier contract the head has had since #494, now on the
/// call (owner rule 2026-08-13: "কথা নয়, কাজ").
final class LiveVoiceWorkFollowThroughTests: XCTestCase {
    func testWorkPromisesAreDetected() {
        for line in [
            "হ্যাঁ Boss, দেখছি। একটু সময় লাগবে।",
            "ঠিক আছে, আমি এডস ম্যানেজারের রিপোর্ট এবং পারফরম্যান্স দেখছি।",
            "আচ্ছা, চেক করছি।",
            "Boss, ব্যবস্থা করছি। অপেক্ষা করুন।",
        ] {
            XCTAssertTrue(AlmaLiveVoiceWorkFollowThrough.promisesWork(line), line)
        }
    }

    func testPlainConversationIsNotAPromise() {
        for line in [
            "আসসালামু আলাইকুম Boss, কেমন আছেন?",
            "আজকের মোট বিক্রি শূন্য টাকা।",
            "কোন বিষয়ে রিপোর্ট চাইছেন, Boss?",
            "",
        ] {
            XCTAssertFalse(AlmaLiveVoiceWorkFollowThrough.promisesWork(line), line)
        }
    }

    func testCorrectionNamesBothToolsAndForbidsTalkingInsteadOfWorking() {
        let text = AlmaLiveVoiceWorkFollowThrough.correction
        XCTAssertTrue(text.contains("quick_erp_lookup"))
        XCTAssertTrue(text.contains("run_agent_turn"))
        XCTAssertTrue(text.contains("মুখে বলা কাজ নয়"))
        XCTAssertTrue(text.contains("Boss-এর কথা নয়"))
    }

    func testBudgetBoundsAndSpacesCorrections() {
        var budget = AlmaLiveVoiceWorkFollowThrough.Budget(limit: 2, minimumSpacing: 8)
        let t0 = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(budget.claim(now: t0))
        // Too soon — a correction burst would loop the model.
        XCTAssertFalse(budget.claim(now: t0.addingTimeInterval(3)))
        XCTAssertTrue(budget.claim(now: t0.addingTimeInterval(9)))
        // Budget spent — the truth goes to the owner instead of another nudge.
        XCTAssertFalse(budget.claim(now: t0.addingTimeInterval(60)))
    }
}
