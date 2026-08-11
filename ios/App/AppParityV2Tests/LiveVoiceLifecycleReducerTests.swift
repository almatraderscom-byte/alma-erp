import XCTest
@testable import App

final class LiveVoiceLifecycleReducerTests: XCTestCase {
    private typealias Reducer = AlmaLiveVoiceLifecycleReducer
    private let generation: UInt64 = 41

    private struct TransitionRow {
        let kind: Reducer.Event.Kind
        let prepare: [Reducer.Event]
        let event: Reducer.Event
        let verify: (Reducer.Transition) -> Void
    }

    private func makeReducer(
        backgroundContinuation: Reducer.BackgroundContinuation = .foregroundOnly
    ) -> Reducer {
        guard let reducer = Reducer(
            generation: generation,
            backgroundContinuation: backgroundContinuation)
        else {
            fatalError("nonzero test generation must create a reducer")
        }
        return reducer
    }

    @discardableResult
    private func apply(
        _ event: Reducer.Event,
        to reducer: inout Reducer,
        generation sourceGeneration: UInt64? = nil,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> Reducer.Transition {
        let transition = reducer.reduce(.init(
            generation: sourceGeneration ?? generation,
            event: event))
        XCTAssertEqual(transition.outcome, .applied, file: file, line: line)
        XCTAssertTrue(transition.mayApplyEffects, file: file, line: line)
        return transition
    }

    func testTransitionTableCoversAndAppliesEveryLifecycleInput() {
        let rows: [TransitionRow] = [
            .init(kind: .appForegrounded, prepare: [.appBackgrounded], event: .appForegrounded) {
                XCTAssertEqual($0.state.appLocation, .foreground)
                XCTAssertEqual($0.decision.microphone, .stream)
            },
            .init(kind: .appBackgrounded, prepare: [], event: .appBackgrounded) {
                XCTAssertEqual($0.state.appLocation, .background)
                XCTAssertEqual($0.decision.microphone, .stop(.background))
            },
            .init(kind: .deviceLocked, prepare: [], event: .deviceLocked) {
                XCTAssertTrue($0.state.isDeviceLocked)
                XCTAssertEqual($0.decision.ui.session, .suspended(.deviceLocked))
            },
            .init(kind: .deviceUnlocked, prepare: [.deviceLocked], event: .deviceUnlocked) {
                XCTAssertFalse($0.state.isDeviceLocked)
                XCTAssertEqual($0.decision.microphone, .stream)
            },
            .init(kind: .routeLost, prepare: [], event: .routeLost) {
                XCTAssertEqual($0.state.route, .unavailable)
                XCTAssertEqual($0.decision.playback, .pause(.routeUnavailable))
            },
            .init(kind: .routeChanged, prepare: [.routeLost], event: .routeChanged(.bluetooth)) {
                XCTAssertEqual($0.state.route, .available(.bluetooth))
                XCTAssertEqual($0.decision.microphone, .stream)
            },
            .init(kind: .audioInterruptionBegan, prepare: [], event: .audioInterruptionBegan) {
                XCTAssertTrue($0.state.isAudioInterrupted)
                XCTAssertEqual($0.decision.playback, .pause(.audioInterrupted))
            },
            .init(
                kind: .audioInterruptionEnded,
                prepare: [.audioInterruptionBegan],
                event: .audioInterruptionEnded
            ) {
                XCTAssertFalse($0.state.isAudioInterrupted)
                XCTAssertEqual($0.decision.microphone, .stream)
            },
            .init(kind: .callKitReserved, prepare: [], event: .callKitReserved) {
                XCTAssertEqual($0.state.callKit, .reserved)
                XCTAssertEqual($0.decision.ui.session, .suspended(.waitingForCallKit))
            },
            .init(
                kind: .callKitActivated,
                prepare: [.callKitReserved],
                event: .callKitActivated
            ) {
                XCTAssertEqual($0.state.callKit, .active)
                XCTAssertEqual($0.decision.microphone, .stream)
            },
            .init(
                kind: .callKitDeactivated,
                prepare: [.callKitReserved, .callKitActivated],
                event: .callKitDeactivated
            ) {
                XCTAssertEqual($0.state.callKit, .deactivated)
                XCTAssertEqual($0.decision.playback, .pause(.waitingForCallKit))
            },
            .init(kind: .networkDown, prepare: [], event: .networkDown) {
                XCTAssertEqual($0.state.network, .down)
                XCTAssertEqual($0.state.provider, .disconnected)
                XCTAssertEqual($0.decision.transport, .waitForNetwork)
            },
            .init(kind: .networkUp, prepare: [.networkDown], event: .networkUp) {
                XCTAssertEqual($0.state.network, .up)
                XCTAssertEqual($0.state.provider, .disconnected)
                XCTAssertEqual($0.decision.transport, .reconnect)
            },
            .init(kind: .providerDisconnected, prepare: [], event: .providerDisconnected) {
                XCTAssertEqual($0.state.provider, .disconnected)
                XCTAssertEqual($0.decision.playback, .stopAndDiscard(.providerDisconnected))
            },
            .init(
                kind: .providerReconnected,
                prepare: [.providerDisconnected],
                event: .providerReconnected
            ) {
                XCTAssertEqual($0.state.provider, .connected)
                XCTAssertEqual($0.decision.transport, .maintain)
            },
            .init(kind: .userMuted, prepare: [], event: .userMuted) {
                XCTAssertTrue($0.state.isMuted)
                XCTAssertEqual($0.decision.microphone, .stop(.muted))
            },
            .init(kind: .userUnmuted, prepare: [.userMuted], event: .userUnmuted) {
                XCTAssertFalse($0.state.isMuted)
                XCTAssertEqual($0.decision.microphone, .stream)
            },
            .init(kind: .userEnded, prepare: [], event: .userEnded) {
                XCTAssertEqual($0.state.terminalReason, .userEnded)
                XCTAssertEqual($0.decision.transport, .disconnectAndInvalidateGeneration)
            },
            .init(kind: .toolPending, prepare: [], event: .toolPending(id: "tool-1")) {
                XCTAssertEqual($0.state.pendingToolIDs, ["tool-1"])
                XCTAssertEqual($0.decision.ui.work, .pending(count: 1))
                XCTAssertEqual($0.decision.playback, .pause(.toolPending))
            },
            .init(
                kind: .toolCompleted,
                prepare: [.toolPending(id: "tool-1")],
                event: .toolCompleted(id: "tool-1")
            ) {
                XCTAssertTrue($0.state.pendingToolIDs.isEmpty)
                XCTAssertEqual($0.decision.ui.work, .idle)
                XCTAssertEqual($0.decision.playback, .allow)
            },
        ]

        XCTAssertEqual(
            Set(rows.map(\.kind)),
            Set(Reducer.Event.Kind.allCases),
            "adding a lifecycle input requires an explicit transition-table row")
        XCTAssertEqual(rows.count, Reducer.Event.Kind.allCases.count)

        for row in rows {
            var reducer = makeReducer()
            for setupEvent in row.prepare { apply(setupEvent, to: &reducer) }
            let transition = apply(row.event, to: &reducer)
            XCTAssertEqual(transition.input.event.kind, row.kind)
            row.verify(transition)
        }
    }

    func testEveryTerminalFollowupIsRejectedAndCannotAutoResume() {
        let allEvents: [Reducer.Event] = [
            .appForegrounded,
            .appBackgrounded,
            .deviceLocked,
            .deviceUnlocked,
            .routeLost,
            .routeChanged(.builtInReceiver),
            .audioInterruptionBegan,
            .audioInterruptionEnded,
            .callKitReserved,
            .callKitActivated,
            .callKitDeactivated,
            .networkDown,
            .networkUp,
            .providerDisconnected,
            .providerReconnected,
            .userMuted,
            .userUnmuted,
            .userEnded,
            .toolPending(id: "late-tool"),
            .toolCompleted(id: "late-tool"),
        ]
        XCTAssertEqual(Set(allEvents.map(\.kind)), Set(Reducer.Event.Kind.allCases))

        for event in allEvents {
            var reducer = makeReducer()
            apply(.toolPending(id: "accepted-before-end"), to: &reducer)
            apply(.userEnded, to: &reducer)
            let terminalState = reducer.state

            let transition = reducer.reduce(.init(generation: generation, event: event))

            XCTAssertEqual(transition.outcome, .ignored(.terminal), "event: \(event.kind)")
            XCTAssertFalse(transition.mayApplyEffects)
            XCTAssertEqual(transition.previousState, terminalState)
            XCTAssertEqual(transition.state, terminalState)
            XCTAssertEqual(transition.decision.microphone, .stop(.terminal))
            XCTAssertEqual(transition.decision.transport, .disconnectAndInvalidateGeneration)
            XCTAssertEqual(transition.decision.playback, .stopAndDiscard(.terminal))
            XCTAssertEqual(
                transition.decision.tools,
                .init(execution: .cancel, resultDelivery: .suppress))
            XCTAssertEqual(transition.decision.ui.session, .ended)
            XCTAssertFalse(transition.decision.ui.isTimerRunning)
        }
    }

    func testEveryWrongGenerationInputIsASideEffectFreeNoOp() {
        let allEvents: [Reducer.Event] = [
            .appForegrounded, .appBackgrounded, .deviceLocked, .deviceUnlocked,
            .routeLost, .routeChanged(.wired),
            .audioInterruptionBegan, .audioInterruptionEnded,
            .callKitReserved, .callKitActivated, .callKitDeactivated,
            .networkDown, .networkUp,
            .providerDisconnected, .providerReconnected,
            .userMuted, .userUnmuted, .userEnded,
            .toolPending(id: "wrong-generation"),
            .toolCompleted(id: "wrong-generation"),
        ]
        let rejectedGenerations: [UInt64] = [0, generation - 1, generation + 1]

        for sourceGeneration in rejectedGenerations {
            for event in allEvents {
                var reducer = makeReducer()
                let original = reducer.state
                let transition = reducer.reduce(.init(
                    generation: sourceGeneration,
                    event: event))

                XCTAssertEqual(transition.outcome, .ignored(.generationMismatch))
                XCTAssertFalse(transition.mayApplyEffects)
                XCTAssertEqual(transition.previousState, original)
                XCTAssertEqual(transition.state, original)
                XCTAssertEqual(transition.decision, reducer.decision)
            }
        }
    }

    func testNetworkUpDoesNotOpenMediaUntilProviderExplicitlyReconnects() {
        var reducer = makeReducer()

        apply(.networkDown, to: &reducer)
        XCTAssertEqual(reducer.decision.microphone, .stop(.networkUnavailable))
        XCTAssertEqual(reducer.decision.playback, .stopAndDiscard(.networkUnavailable))

        apply(.networkUp, to: &reducer)
        XCTAssertEqual(reducer.decision.transport, .reconnect)
        XCTAssertEqual(reducer.decision.microphone, .stop(.providerDisconnected))
        XCTAssertEqual(reducer.decision.playback, .stopAndDiscard(.providerDisconnected))

        apply(.providerReconnected, to: &reducer)
        XCTAssertEqual(reducer.decision.transport, .maintain)
        XCTAssertEqual(reducer.decision.microphone, .stream)
        XCTAssertEqual(reducer.decision.playback, .allow)
    }

    func testCompositeBlockersRequireEveryMatchingRecoverySignal() {
        var reducer = makeReducer()
        apply(.appBackgrounded, to: &reducer)
        apply(.deviceLocked, to: &reducer)
        apply(.routeLost, to: &reducer)
        apply(.audioInterruptionBegan, to: &reducer)
        apply(.callKitReserved, to: &reducer)
        apply(.networkDown, to: &reducer)

        apply(.networkUp, to: &reducer)
        apply(.providerReconnected, to: &reducer)
        XCTAssertEqual(reducer.decision.microphone, .stop(.audioInterrupted))

        apply(.audioInterruptionEnded, to: &reducer)
        XCTAssertEqual(reducer.decision.microphone, .stop(.waitingForCallKit))

        apply(.callKitActivated, to: &reducer)
        XCTAssertEqual(reducer.decision.microphone, .stop(.routeUnavailable))

        apply(.routeChanged(.builtInReceiver), to: &reducer)
        XCTAssertEqual(reducer.decision.microphone, .stop(.deviceLocked))

        apply(.deviceUnlocked, to: &reducer)
        XCTAssertEqual(reducer.decision.microphone, .stop(.background))

        apply(.appForegrounded, to: &reducer)
        XCTAssertEqual(reducer.decision.microphone, .stream)
        XCTAssertEqual(reducer.decision.playback, .allow)
        XCTAssertEqual(reducer.decision.ui.session, .ready)
    }

    func testCallKitBackgroundContinuationRequiresCurrentExplicitActivation() {
        var reducer = makeReducer(backgroundContinuation: .whileCallKitActive)
        apply(.callKitReserved, to: &reducer)
        apply(.callKitActivated, to: &reducer)
        apply(.appBackgrounded, to: &reducer)
        apply(.deviceLocked, to: &reducer)

        XCTAssertEqual(reducer.decision.microphone, .stream)
        XCTAssertEqual(reducer.decision.playback, .allow)

        apply(.callKitDeactivated, to: &reducer)
        XCTAssertEqual(reducer.decision.microphone, .stop(.waitingForCallKit))
        XCTAssertEqual(reducer.decision.playback, .pause(.waitingForCallKit))

        apply(.callKitActivated, to: &reducer)
        XCTAssertEqual(reducer.decision.microphone, .stream)
        XCTAssertEqual(reducer.decision.playback, .allow)
    }

    func testPendingToolPolicyIsExplicitAcrossEveryLifecycleBoundary() {
        struct Row {
            let name: String
            let events: [Reducer.Event]
            let execution: Reducer.ToolPolicy.Execution
            let delivery: Reducer.ToolPolicy.ResultDelivery
            let playback: Reducer.PlaybackPolicy
            let work: Reducer.UITruth.Work
        }

        let rows: [Row] = [
            .init(
                name: "foreground",
                events: [],
                execution: .acceptAndContinue,
                delivery: .deliverInOrder,
                playback: .pause(.toolPending),
                work: .pending(count: 1)),
            .init(
                name: "background",
                events: [.appBackgrounded],
                execution: .acceptAndContinue,
                delivery: .holdInOrder,
                playback: .pause(.background),
                work: .pending(count: 1)),
            .init(
                name: "lock",
                events: [.deviceLocked],
                execution: .acceptAndContinue,
                delivery: .holdInOrder,
                playback: .pause(.deviceLocked),
                work: .pending(count: 1)),
            .init(
                name: "route loss",
                events: [.routeLost],
                execution: .acceptAndContinue,
                delivery: .holdInOrder,
                playback: .pause(.routeUnavailable),
                work: .pending(count: 1)),
            .init(
                name: "interruption",
                events: [.audioInterruptionBegan],
                execution: .acceptAndContinue,
                delivery: .holdInOrder,
                playback: .pause(.audioInterrupted),
                work: .pending(count: 1)),
            .init(
                name: "CallKit reservation",
                events: [.callKitReserved],
                execution: .acceptAndContinue,
                delivery: .holdInOrder,
                playback: .pause(.waitingForCallKit),
                work: .pending(count: 1)),
            .init(
                name: "provider disconnect",
                events: [.providerDisconnected],
                execution: .acceptAndContinue,
                delivery: .holdInOrder,
                playback: .stopAndDiscard(.providerDisconnected),
                work: .pending(count: 1)),
            .init(
                name: "network down",
                events: [.networkDown],
                execution: .hold,
                delivery: .holdInOrder,
                playback: .stopAndDiscard(.networkUnavailable),
                work: .pending(count: 1)),
            .init(
                name: "mute",
                events: [.userMuted],
                execution: .acceptAndContinue,
                delivery: .deliverInOrder,
                playback: .pause(.toolPending),
                work: .pending(count: 1)),
            .init(
                name: "terminal",
                events: [.userEnded],
                execution: .cancel,
                delivery: .suppress,
                playback: .stopAndDiscard(.terminal),
                work: .idle),
        ]

        for row in rows {
            var reducer = makeReducer()
            apply(.toolPending(id: "tool-policy"), to: &reducer)
            for event in row.events { apply(event, to: &reducer) }

            XCTAssertEqual(reducer.decision.tools.execution, row.execution, row.name)
            XCTAssertEqual(reducer.decision.tools.resultDelivery, row.delivery, row.name)
            XCTAssertEqual(reducer.decision.playback, row.playback, row.name)
            XCTAssertEqual(reducer.decision.ui.work, row.work, row.name)
        }
    }

    func testToolIdentityIsExactAndCompletionOrderDoesNotLoseConcurrentWork() {
        var reducer = makeReducer()
        apply(.toolPending(id: "tool-A"), to: &reducer)
        apply(.toolPending(id: "tool-B"), to: &reducer)
        XCTAssertEqual(reducer.state.pendingToolIDs, ["tool-A", "tool-B"])

        let duplicate = reducer.reduce(.init(
            generation: generation,
            event: .toolPending(id: "tool-A")))
        XCTAssertEqual(duplicate.outcome, .ignored(.duplicateTool))
        XCTAssertFalse(duplicate.mayApplyEffects)

        apply(.toolCompleted(id: "tool-B"), to: &reducer)
        XCTAssertEqual(reducer.state.pendingToolIDs, ["tool-A"])
        XCTAssertEqual(reducer.decision.ui.work, .pending(count: 1))

        apply(.toolCompleted(id: "tool-A"), to: &reducer)
        XCTAssertTrue(reducer.state.pendingToolIDs.isEmpty)
        XCTAssertEqual(reducer.decision.ui.work, .idle)

        let late = reducer.reduce(.init(
            generation: generation,
            event: .toolCompleted(id: "tool-B")))
        XCTAssertEqual(late.outcome, .ignored(.unknownToolCompletion))
        XCTAssertFalse(late.mayApplyEffects)
    }

    func testInvalidRecoveryTransitionsAndToolInputsFailClosed() {
        XCTAssertNil(Reducer(generation: 0))

        let invalidEvents: [(Reducer.Event, Reducer.IgnoredReason)] = [
            (.deviceUnlocked, .noStateChange),
            (.audioInterruptionEnded, .invalidTransition),
            (.callKitActivated, .invalidTransition),
            (.callKitDeactivated, .invalidTransition),
            (.networkUp, .invalidTransition),
            (.providerReconnected, .invalidTransition),
            (.userUnmuted, .noStateChange),
            (.toolPending(id: ""), .invalidToolIdentifier),
            (.toolCompleted(id: ""), .invalidToolIdentifier),
            (.toolCompleted(id: "unknown"), .unknownToolCompletion),
        ]

        for (event, reason) in invalidEvents {
            var reducer = makeReducer()
            let original = reducer.state
            let transition = reducer.reduce(.init(generation: generation, event: event))
            XCTAssertEqual(transition.outcome, .ignored(reason), "event: \(event.kind)")
            XCTAssertFalse(transition.mayApplyEffects)
            XCTAssertEqual(transition.state, original)
        }

        var disconnected = makeReducer()
        apply(.providerDisconnected, to: &disconnected)
        let staleTool = disconnected.reduce(.init(
            generation: generation,
            event: .toolPending(id: "arrived-after-disconnect")))
        XCTAssertEqual(staleTool.outcome, .ignored(.invalidTransition))
        XCTAssertTrue(disconnected.state.pendingToolIDs.isEmpty)
    }

    func testLifecycleReducerRollbackGateHasDeterministicPrecedence() throws {
        let suite = "alma-live-voice-lifecycle-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertTrue(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .lifecycleReducerV1,
            environment: [:],
            defaults: defaults))
        AlmaLiveVoiceRecoveryFeatures.set(
            false,
            for: .lifecycleReducerV1,
            defaults: defaults)
        XCTAssertFalse(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .lifecycleReducerV1,
            environment: [:],
            defaults: defaults))
        XCTAssertTrue(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .lifecycleReducerV1,
            environment: ["ALMA_LIVE_VOICE_LIFECYCLE_REDUCER_V1": "on"],
            defaults: defaults))
        XCTAssertFalse(AlmaLiveVoiceRecoveryFeatures.isEnabled(
            .lifecycleReducerV1,
            environment: ["ALMA_LIVE_VOICE_LIFECYCLE_REDUCER_V1": "off"],
            defaults: defaults))
    }

    func testDecisionInvariantsHoldAcrossEverySingleInput() {
        let events: [Reducer.Event] = [
            .appForegrounded, .appBackgrounded, .deviceLocked, .deviceUnlocked,
            .routeLost, .routeChanged(.airPlay),
            .audioInterruptionBegan, .audioInterruptionEnded,
            .callKitReserved, .callKitActivated, .callKitDeactivated,
            .networkDown, .networkUp,
            .providerDisconnected, .providerReconnected,
            .userMuted, .userUnmuted, .userEnded,
            .toolPending(id: "invariant-tool"),
            .toolCompleted(id: "invariant-tool"),
        ]

        for event in events {
            var reducer = makeReducer()
            _ = reducer.reduce(.init(generation: generation, event: event))
            let decision = reducer.decision

            if decision.microphone == .stream {
                XCTAssertEqual(decision.transport, .maintain, "event: \(event.kind)")
                XCTAssertEqual(decision.ui.session, .ready, "event: \(event.kind)")
                XCTAssertFalse(reducer.state.isMuted, "event: \(event.kind)")
            }
            if reducer.state.isTerminal {
                XCTAssertEqual(decision.microphone, .stop(.terminal))
                XCTAssertEqual(decision.transport, .disconnectAndInvalidateGeneration)
                XCTAssertEqual(decision.playback, .stopAndDiscard(.terminal))
                XCTAssertEqual(decision.tools.resultDelivery, .suppress)
                XCTAssertFalse(decision.ui.isTimerRunning)
            } else {
                XCTAssertTrue(decision.ui.isTimerRunning)
                XCTAssertEqual(
                    decision.ui.isMuted,
                    reducer.state.isMuted,
                    "UI mute truth must equal reducer state")
            }
        }
    }
}
