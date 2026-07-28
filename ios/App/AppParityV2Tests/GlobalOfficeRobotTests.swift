import XCTest
@testable import App

@MainActor
final class GlobalOfficeRobotTests: XCTestCase {
    private func state(
        baseline: Bool = false,
        observed: String? = nil,
        token: Int = 0
    ) -> GlobalOfficeRobotStore.ReducerState {
        GlobalOfficeRobotStore.ReducerState(
            hasEstablishedBaseline: baseline,
            lastObservedCompletionTurnId: observed,
            lastObservedCompletionCursor: observed.map {
                "2026-07-28T04:00:00.000Z#\($0)"
            },
            completionToken: token
        )
    }

    private func completion(
        _ id: String,
        at: String = "2026-07-28T04:00:00.000Z"
    ) -> GlobalOfficeRobotStore.LatestCompletion {
        GlobalOfficeRobotStore.LatestCompletion(
            turnId: id,
            conversationId: "conversation-\(id)",
            preview: "কাজ শেষ হয়েছে Boss।",
            completedAt: at
        )
    }

    func testInitialCompletionEstablishesBaselineWithoutCelebrating() {
        let reduction = GlobalOfficeRobotStore.reduce(
            snapshot: .init(
                runningCount: 2,
                attentionCount: 1,
                latestCompletion: completion("turn-a")
            ),
            state: state()
        )

        XCTAssertEqual(reduction.taskCount, 3)
        XCTAssertEqual(reduction.state.completionToken, 0)
        XCTAssertEqual(reduction.state.lastObservedCompletionTurnId, "turn-a")
        XCTAssertEqual(reduction.latestCompletion?.turnId, "turn-a")
    }

    func testNewCompletionCelebratesExactlyOnce() {
        let prior = state(
            baseline: true,
            observed: "turn-a",
            token: 7
        )
        let first = GlobalOfficeRobotStore.reduce(
            snapshot: .init(
                runningCount: 0,
                attentionCount: 0,
                latestCompletion: completion("turn-b")
            ),
            state: prior
        )
        let replay = GlobalOfficeRobotStore.reduce(
            snapshot: .init(
                runningCount: 0,
                attentionCount: 0,
                latestCompletion: completion("turn-b")
            ),
            state: first.state
        )

        XCTAssertEqual(first.state.completionToken, 8)
        XCTAssertEqual(replay.state.completionToken, 8)
    }

    func testCountsClampAndSaturate() {
        let reduction = GlobalOfficeRobotStore.reduce(
            snapshot: .init(
                runningCount: -4,
                attentionCount: 2_000,
                latestCompletion: nil
            ),
            state: state(baseline: true)
        )

        XCTAssertEqual(reduction.runningCount, 0)
        XCTAssertEqual(reduction.attentionCount, 999)
        XCTAssertEqual(reduction.taskCount, 999)
    }

    func testOlderSnapshotCannotReplayCelebration() {
        let prior = state(
            baseline: true,
            observed: "turn-b",
            token: 4
        )
        let reduction = GlobalOfficeRobotStore.reduce(
            snapshot: .init(
                runningCount: 0,
                attentionCount: 0,
                latestCompletion: completion(
                    "turn-a",
                    at: "2026-07-28T03:59:59.000Z"
                )
            ),
            state: prior
        )

        XCTAssertEqual(reduction.state.lastObservedCompletionTurnId, "turn-b")
        XCTAssertEqual(reduction.state.completionToken, 4)
        XCTAssertNil(reduction.latestCompletion)
    }

    func testDragDirectionsUseMatchingRunningSpriteRows() {
        XCTAssertEqual(OfficeRobotDragDirection.right.runningSpriteRow, 1)
        XCTAssertEqual(OfficeRobotDragDirection.left.runningSpriteRow, 2)
        XCTAssertEqual(OfficeRobotDragDirection.right.horizontalSign, 1)
        XCTAssertEqual(OfficeRobotDragDirection.left.horizontalSign, -1)
    }
}
