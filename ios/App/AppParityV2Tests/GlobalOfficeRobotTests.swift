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

    func testLaunchTimelineBeginsFullyOffscreenAndKeepsAwarenessVisible() {
        let initial = LaunchRobotTimeline.state(at: 0)
        let awareness = LaunchRobotTimeline.state(at: 2.5)

        XCTAssertLessThan(initial.robotCenter.y + initial.robotSize.height / 2, 0)
        XCTAssertEqual(awareness.phase, .awareness)
        XCTAssertEqual(awareness.robotOpacity, 1)
        XCTAssertGreaterThan(awareness.robotCenter.y, 0)
        XCTAssertLessThan(awareness.robotCenter.y, 844)
    }

    func testLaunchTimelineContainsTwoDistinctHopPhases() {
        XCTAssertEqual(LaunchRobotTimeline.phase(at: 3.55), .hopOne)
        XCTAssertEqual(LaunchRobotTimeline.phase(at: 4.10), .hopTwo)

        let firstPeak = LaunchRobotTimeline.state(at: 3.575)
        let secondPeak = LaunchRobotTimeline.state(at: 4.125)
        XCTAssertNotEqual(firstPeak.robotCenter.x, secondPeak.robotCenter.x)
        XCTAssertNotEqual(firstPeak.robotCenter.y, secondPeak.robotCenter.y)
    }

    func testLaunchLandingAndActivationEffectsAreReadable() {
        let landing = LaunchRobotTimeline.state(at: 1.32)
        let activation = LaunchRobotTimeline.state(at: 6.72)

        XCTAssertEqual(landing.phase, .landing)
        XCTAssertGreaterThan(landing.impactOpacity, 0)
        XCTAssertGreaterThan(landing.particleOpacity, 0)
        XCTAssertEqual(activation.phase, .activation)
        XCTAssertGreaterThan(activation.coreOpacity, 0)
        XCTAssertGreaterThan(activation.scanOpacity, 0)
    }

    func testLaunchMergeEndsWithCanonicalHostAsOnlyVisibleOwner() {
        let destination = CGPoint(x: 334, y: 380)
        let merge = LaunchRobotTimeline.state(
            at: 9.08,
            destinationCenter: destination
        )
        let fixedReaction = LaunchRobotTimeline.state(
            at: 9.35,
            destinationCenter: destination
        )
        let final = LaunchRobotTimeline.state(
            at: LaunchRobotTimeline.duration,
            destinationCenter: destination
        )

        XCTAssertEqual(merge.phase, .merge)
        XCTAssertEqual(merge.robotCenter.x, destination.x, accuracy: 0.5)
        XCTAssertEqual(merge.robotCenter.y, destination.y, accuracy: 0.5)
        XCTAssertGreaterThan(merge.portalOpacity, 0.9)
        XCTAssertEqual(fixedReaction.phase, .fixedReaction)
        XCTAssertEqual(fixedReaction.robotOpacity, 0)
        XCTAssertEqual(final.robotOpacity, 0)
        XCTAssertEqual(final.portalOpacity, 0)
    }
}
