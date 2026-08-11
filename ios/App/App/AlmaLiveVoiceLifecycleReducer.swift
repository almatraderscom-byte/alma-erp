//
//  AlmaLiveVoiceLifecycleReducer.swift
//  App
//
//  Pure lifecycle policy for Live Voice. OS/provider callbacks are reduced here
//  before any microphone, transport, playback, tool, or UI side effect runs.
//

/// A deterministic, generation-bound lifecycle reducer for one logical Live
/// Voice session. The reducer owns policy only; it never touches AVFoundation,
/// CallKit, sockets, tools, ActivityKit, or UI objects.
struct AlmaLiveVoiceLifecycleReducer: Equatable, Sendable {
    enum AppLocation: Equatable, Sendable {
        case foreground
        case background
    }

    enum Route: Equatable, Sendable {
        case builtInReceiver
        case builtInSpeaker
        case bluetooth
        case wired
        case airPlay
        case carAudio
        case otherUsable
    }

    enum RouteState: Equatable, Sendable {
        case available(Route)
        case unavailable
    }

    enum CallKitState: Equatable, Sendable {
        /// The session is not waiting on CallKit audio ownership.
        case notManaged
        /// Audio ownership has been reserved, but `didActivate` has not arrived.
        case reserved
        /// CallKit has explicitly activated this session's audio.
        case active
        /// CallKit explicitly deactivated audio; only a later activation reopens it.
        case deactivated
    }

    enum NetworkState: Equatable, Sendable {
        case up
        case down
    }

    enum ProviderState: Equatable, Sendable {
        case connected
        case disconnected
    }

    /// Background/lock continuation is deliberately opt-in and narrow. The
    /// default is fail-closed until real-device evidence proves a wider policy.
    enum BackgroundContinuation: Equatable, Sendable {
        case foregroundOnly
        case whileCallKitActive
    }

    enum TerminalReason: Equatable, Sendable {
        case userEnded
    }

    struct State: Equatable, Sendable {
        let generation: UInt64
        let backgroundContinuation: BackgroundContinuation
        var appLocation: AppLocation
        var isDeviceLocked: Bool
        var route: RouteState
        var isAudioInterrupted: Bool
        var callKit: CallKitState
        var network: NetworkState
        var provider: ProviderState
        var isMuted: Bool
        var pendingToolIDs: [String]
        var terminalReason: TerminalReason?

        var isTerminal: Bool { terminalReason != nil }
    }

    enum Event: Equatable, Sendable {
        enum Kind: String, CaseIterable, Equatable, Sendable {
            case appForegrounded
            case appBackgrounded
            case deviceLocked
            case deviceUnlocked
            case routeLost
            case routeChanged
            case audioInterruptionBegan
            case audioInterruptionEnded
            case callKitReserved
            case callKitActivated
            case callKitDeactivated
            case networkDown
            case networkUp
            case providerDisconnected
            case providerReconnected
            case userMuted
            case userUnmuted
            case userEnded
            case toolPending
            case toolCompleted
        }

        case appForegrounded
        case appBackgrounded
        case deviceLocked
        case deviceUnlocked
        case routeLost
        case routeChanged(Route)
        case audioInterruptionBegan
        case audioInterruptionEnded
        case callKitReserved
        case callKitActivated
        case callKitDeactivated
        case networkDown
        case networkUp
        case providerDisconnected
        case providerReconnected
        case userMuted
        case userUnmuted
        case userEnded
        case toolPending(id: String)
        case toolCompleted(id: String)

        var kind: Kind {
            switch self {
            case .appForegrounded: return .appForegrounded
            case .appBackgrounded: return .appBackgrounded
            case .deviceLocked: return .deviceLocked
            case .deviceUnlocked: return .deviceUnlocked
            case .routeLost: return .routeLost
            case .routeChanged: return .routeChanged
            case .audioInterruptionBegan: return .audioInterruptionBegan
            case .audioInterruptionEnded: return .audioInterruptionEnded
            case .callKitReserved: return .callKitReserved
            case .callKitActivated: return .callKitActivated
            case .callKitDeactivated: return .callKitDeactivated
            case .networkDown: return .networkDown
            case .networkUp: return .networkUp
            case .providerDisconnected: return .providerDisconnected
            case .providerReconnected: return .providerReconnected
            case .userMuted: return .userMuted
            case .userUnmuted: return .userUnmuted
            case .userEnded: return .userEnded
            case .toolPending: return .toolPending
            case .toolCompleted: return .toolCompleted
            }
        }
    }

    struct Input: Equatable, Sendable {
        let generation: UInt64
        let event: Event
    }

    enum IgnoredReason: Equatable, Sendable {
        /// Zero, stale, and future observations all have the same no-side-effect result.
        case generationMismatch
        /// A terminal session is immutable, including for a matching generation.
        case terminal
        /// A recovery signal cannot open a gate that was never explicitly closed.
        case invalidTransition
        case noStateChange
        case invalidToolIdentifier
        case duplicateTool
        case unknownToolCompletion
    }

    enum Outcome: Equatable, Sendable {
        case applied
        case ignored(IgnoredReason)
    }

    enum BlockReason: Equatable, Sendable {
        case terminal
        case networkUnavailable
        case providerDisconnected
        case audioInterrupted
        case waitingForCallKit
        case routeUnavailable
        case deviceLocked
        case background
        case muted
        case toolPending
    }

    enum MicrophonePolicy: Equatable, Sendable {
        case stream
        case stop(BlockReason)
    }

    enum TransportPolicy: Equatable, Sendable {
        /// Keep the already authenticated, generation-bound transport alive.
        case maintain
        /// Do not attempt a socket until the path monitor explicitly reports up.
        case waitForNetwork
        /// Start/resume only the current generation's provider transport.
        case reconnect
        /// Tear down the transport and invalidate every late callback/send.
        case disconnectAndInvalidateGeneration
    }

    enum PlaybackPolicy: Equatable, Sendable {
        case allow
        /// Preserve buffers but do not render until the matching recovery event.
        case pause(BlockReason)
        /// Drop queued/model audio so it cannot resurrect after transport loss/end.
        case stopAndDiscard(BlockReason)
    }

    struct ToolPolicy: Equatable, Sendable {
        enum Execution: Equatable, Sendable {
            /// New accepted work may run; already accepted work may finish.
            case acceptAndContinue
            /// Keep accepted identities but do not start additional backend work.
            case hold
            /// Cancel accepted work and reject every late completion.
            case cancel
        }

        enum ResultDelivery: Equatable, Sendable {
            case deliverInOrder
            case holdInOrder
            case suppress
        }

        let execution: Execution
        let resultDelivery: ResultDelivery
    }

    struct UITruth: Equatable, Sendable {
        enum Session: Equatable, Sendable {
            case ready
            case reconnecting(BlockReason)
            case suspended(BlockReason)
            case ended
        }

        enum Work: Equatable, Sendable {
            case idle
            case pending(count: Int)
        }

        let session: Session
        let work: Work
        let isMuted: Bool
        let isTimerRunning: Bool
    }

    struct Decision: Equatable, Sendable {
        let microphone: MicrophonePolicy
        let transport: TransportPolicy
        let playback: PlaybackPolicy
        let tools: ToolPolicy
        let ui: UITruth
    }

    struct Transition: Equatable, Sendable {
        let input: Input
        let outcome: Outcome
        let previousState: State
        let state: State
        let decision: Decision

        /// Side-effect adapters must ignore rejected observations. `decision`
        /// remains the current steady-state truth for assertions/rendering.
        var mayApplyEffects: Bool { outcome == .applied }
    }

    private(set) var state: State

    /// Zero is reserved as the inactive/pre-session sentinel and can never own
    /// lifecycle callbacks. A new logical call creates a new reducer/generation.
    init?(
        generation: UInt64,
        backgroundContinuation: BackgroundContinuation = .foregroundOnly,
        initialRoute: Route = .builtInSpeaker,
        initialCallKitState: CallKitState = .notManaged
    ) {
        guard generation > 0 else { return nil }
        state = State(
            generation: generation,
            backgroundContinuation: backgroundContinuation,
            appLocation: .foreground,
            isDeviceLocked: false,
            route: .available(initialRoute),
            isAudioInterrupted: false,
            callKit: initialCallKitState,
            network: .up,
            provider: .connected,
            isMuted: false,
            pendingToolIDs: [],
            terminalReason: nil)
    }

    var decision: Decision { Self.decision(for: state) }

    @discardableResult
    mutating func reduce(_ input: Input) -> Transition {
        let previousState = state

        guard input.generation > 0, input.generation == state.generation else {
            return transition(
                input: input,
                outcome: .ignored(.generationMismatch),
                previousState: previousState)
        }
        guard !state.isTerminal else {
            return transition(
                input: input,
                outcome: .ignored(.terminal),
                previousState: previousState)
        }

        let outcome: Outcome
        switch input.event {
        case .appForegrounded:
            outcome = assign(&state.appLocation, .foreground)

        case .appBackgrounded:
            outcome = assign(&state.appLocation, .background)

        case .deviceLocked:
            outcome = assign(&state.isDeviceLocked, true)

        case .deviceUnlocked:
            outcome = assign(&state.isDeviceLocked, false)

        case .routeLost:
            outcome = assign(&state.route, .unavailable)

        case .routeChanged(let route):
            outcome = assign(&state.route, .available(route))

        case .audioInterruptionBegan:
            outcome = assign(&state.isAudioInterrupted, true)

        case .audioInterruptionEnded:
            guard state.isAudioInterrupted else {
                outcome = .ignored(.invalidTransition)
                break
            }
            state.isAudioInterrupted = false
            outcome = .applied

        case .callKitReserved:
            switch state.callKit {
            case .notManaged, .deactivated:
                state.callKit = .reserved
                outcome = .applied
            case .reserved:
                outcome = .ignored(.noStateChange)
            case .active:
                outcome = .ignored(.invalidTransition)
            }

        case .callKitActivated:
            switch state.callKit {
            case .reserved, .deactivated:
                state.callKit = .active
                outcome = .applied
            case .notManaged:
                outcome = .ignored(.invalidTransition)
            case .active:
                outcome = .ignored(.noStateChange)
            }

        case .callKitDeactivated:
            switch state.callKit {
            case .reserved, .active:
                state.callKit = .deactivated
                outcome = .applied
            case .notManaged:
                outcome = .ignored(.invalidTransition)
            case .deactivated:
                outcome = .ignored(.noStateChange)
            }

        case .networkDown:
            guard state.network != .down else {
                outcome = .ignored(.noStateChange)
                break
            }
            state.network = .down
            // Path loss invalidates provider readiness. `networkUp` alone must
            // never reopen audio; an explicit provider reconnect is required.
            state.provider = .disconnected
            outcome = .applied

        case .networkUp:
            guard state.network == .down else {
                outcome = .ignored(.invalidTransition)
                break
            }
            state.network = .up
            outcome = .applied

        case .providerDisconnected:
            outcome = assign(&state.provider, .disconnected)

        case .providerReconnected:
            guard state.network == .up, state.provider == .disconnected else {
                outcome = .ignored(.invalidTransition)
                break
            }
            state.provider = .connected
            outcome = .applied

        case .userMuted:
            outcome = assign(&state.isMuted, true)

        case .userUnmuted:
            outcome = assign(&state.isMuted, false)

        case .userEnded:
            state.terminalReason = .userEnded
            state.pendingToolIDs.removeAll(keepingCapacity: false)
            outcome = .applied

        case .toolPending(let id):
            guard !id.isEmpty else {
                outcome = .ignored(.invalidToolIdentifier)
                break
            }
            guard !state.pendingToolIDs.contains(id) else {
                outcome = .ignored(.duplicateTool)
                break
            }
            // A provider tool event observed after provider invalidation cannot
            // create fresh work, even when its logical generation still matches.
            guard state.network == .up, state.provider == .connected else {
                outcome = .ignored(.invalidTransition)
                break
            }
            state.pendingToolIDs.append(id)
            outcome = .applied

        case .toolCompleted(let id):
            guard !id.isEmpty else {
                outcome = .ignored(.invalidToolIdentifier)
                break
            }
            guard let index = state.pendingToolIDs.firstIndex(of: id) else {
                outcome = .ignored(.unknownToolCompletion)
                break
            }
            state.pendingToolIDs.remove(at: index)
            outcome = .applied
        }

        return transition(
            input: input,
            outcome: outcome,
            previousState: previousState)
    }

    private func transition(
        input: Input,
        outcome: Outcome,
        previousState: State
    ) -> Transition {
        Transition(
            input: input,
            outcome: outcome,
            previousState: previousState,
            state: state,
            decision: Self.decision(for: state))
    }

    private func assign<Value: Equatable>(
        _ value: inout Value,
        _ newValue: Value
    ) -> Outcome {
        guard value != newValue else { return .ignored(.noStateChange) }
        value = newValue
        return .applied
    }

    private static func decision(for state: State) -> Decision {
        if state.isTerminal {
            return Decision(
                microphone: .stop(.terminal),
                transport: .disconnectAndInvalidateGeneration,
                playback: .stopAndDiscard(.terminal),
                tools: ToolPolicy(execution: .cancel, resultDelivery: .suppress),
                ui: UITruth(
                    session: .ended,
                    work: .idle,
                    isMuted: state.isMuted,
                    isTimerRunning: false))
        }

        let transport: TransportPolicy
        if state.network == .down {
            transport = .waitForNetwork
        } else if state.provider == .disconnected {
            transport = .reconnect
        } else {
            transport = .maintain
        }

        let mediaBlocker = mediaBlockReason(for: state)
        let microphone: MicrophonePolicy
        if let blocker = mediaBlocker {
            microphone = .stop(blocker)
        } else if state.isMuted {
            microphone = .stop(.muted)
        } else {
            microphone = .stream
        }

        let playback: PlaybackPolicy
        if state.network == .down {
            playback = .stopAndDiscard(.networkUnavailable)
        } else if state.provider == .disconnected {
            playback = .stopAndDiscard(.providerDisconnected)
        } else if let blocker = mediaBlocker {
            playback = .pause(blocker)
        } else if !state.pendingToolIDs.isEmpty {
            playback = .pause(.toolPending)
        } else {
            playback = .allow
        }

        let toolExecution: ToolPolicy.Execution
        let toolDelivery: ToolPolicy.ResultDelivery
        if state.network == .down {
            toolExecution = .hold
            toolDelivery = .holdInOrder
        } else if state.provider == .disconnected {
            // Already accepted local work may finish. Its exact result identity
            // stays queued for the resumed provider transport.
            toolExecution = .acceptAndContinue
            toolDelivery = .holdInOrder
        } else if mediaBlocker != nil {
            // Do not let a provider advance into inaudible playback while the
            // audio route/session is unavailable.
            toolExecution = .acceptAndContinue
            toolDelivery = .holdInOrder
        } else {
            toolExecution = .acceptAndContinue
            toolDelivery = .deliverInOrder
        }

        let uiSession: UITruth.Session
        if state.network == .down {
            uiSession = .reconnecting(.networkUnavailable)
        } else if state.provider == .disconnected {
            uiSession = .reconnecting(.providerDisconnected)
        } else if let blocker = mediaBlocker {
            uiSession = .suspended(blocker)
        } else {
            uiSession = .ready
        }

        let work: UITruth.Work = state.pendingToolIDs.isEmpty
            ? .idle
            : .pending(count: state.pendingToolIDs.count)

        return Decision(
            microphone: microphone,
            transport: transport,
            playback: playback,
            tools: ToolPolicy(
                execution: toolExecution,
                resultDelivery: toolDelivery),
            ui: UITruth(
                session: uiSession,
                work: work,
                isMuted: state.isMuted,
                isTimerRunning: true))
    }

    private static func mediaBlockReason(for state: State) -> BlockReason? {
        if state.network == .down { return .networkUnavailable }
        if state.provider == .disconnected { return .providerDisconnected }
        if state.isAudioInterrupted { return .audioInterrupted }
        if state.callKit == .reserved || state.callKit == .deactivated {
            return .waitingForCallKit
        }
        if state.route == .unavailable { return .routeUnavailable }

        let backgroundMayContinue = state.backgroundContinuation == .whileCallKitActive
            && state.callKit == .active
        if state.isDeviceLocked, !backgroundMayContinue { return .deviceLocked }
        if state.appLocation == .background, !backgroundMayContinue { return .background }
        return nil
    }
}
