//
//  VoiceLiveActivityController.swift
//  App target only.
//
//  Drives the ALMA voice-session Live Activity (Dynamic Island + Lock Screen)
//  from AlmaVoiceEngine state. docs/alma-live-activity-PLAN.md §2.
//
//  Privacy contract: the activity receives only phase, mute state, and the
//  session start time. Transcript tails and audio-derived/synthetic levels stay
//  in the foreground voice surface and are never serialized to ActivityKit.
//
//  Stale guards: 30-min hard timeout (forgotten session ≠ battery drain), and
//  every push carries staleDate = now+90s so the island dims quickly if the
//  app is killed without a clean end().
//

import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

@available(iOS 17.0, *)
@MainActor
final class VoiceLiveActivityController {
    weak var engine: AlmaVoiceEngine?

    #if canImport(ActivityKit)
    private var activity: Activity<AlmaVoiceActivityAttributes>?
    #endif
    private var expiryTask: Task<Void, Never>?
    private var lastPushedPhase = ""
    private var lastPushedMuted = false
    private var startedAt = Date()

    private static let maxSession: TimeInterval = 30 * 60

    // MARK: - Lifecycle

    /// Console opened (engine.begin) — request one activity, or adopt a
    /// leftover one from a previous session, then start the sampler loop.
    func start() {
        #if canImport(ActivityKit)
        guard AlmaLiveVoiceRecoveryFeatures.isEnabled(.privateLiveActivityV1) else {
            end()
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // Voice owns the island while a session runs: a live "Business Pulse"
        // activity would win the compact slot and hide the voice UI — end it.
        // (The web layer restarts Pulse on its next tick after the session.)
        for pulse in Activity<PulseActivityAttributes>.activities {
            Task { await pulse.end(nil, dismissalPolicy: .immediate) }
        }
        startedAt = Date()
        let state = contentState()
        if let existing = Activity<AlmaVoiceActivityAttributes>.activities.first {
            activity = existing
            Task { await existing.update(content(state)) }
        } else {
            activity = try? Activity.request(
                attributes: AlmaVoiceActivityAttributes(sessionTitle: "ভয়েস কথোপকথন"),
                content: content(state),
                pushType: nil
            )
        }
        lastPushedPhase = state.phase
        lastPushedMuted = state.isMuted
        expiryTask?.cancel()
        expiryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.maxSession * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.end()
        }
        #endif
    }

    /// Engine state flipped (listening/thinking/speaking) — publish only when
    /// the privacy-safe phase or mute value actually changed.
    func phaseChanged() {
        stateChanged()
    }

    func stateChanged() {
        #if canImport(ActivityKit)
        guard activity != nil else { return }
        let phase = currentPhase()
        let muted = engine?.isMuted ?? false
        guard phase != lastPushedPhase || muted != lastPushedMuted else { return }
        push()
        #endif
    }

    /// Session over (engine.end / stale timeout) — island disappears at once.
    /// After the voice activity is gone, the Business Pulse activity is
    /// restored from its cached last state (~1.5s later, once the island slot
    /// is free) — start() ended it, and the web layer can't restart it while
    /// the app is backgrounded.
    func end() {
        expiryTask?.cancel(); expiryTask = nil
        #if canImport(ActivityKit)
        activity = nil
        let leftovers = Activity<AlmaVoiceActivityAttributes>.activities
        guard !leftovers.isEmpty else {
            schedulePulseRestore()
            return
        }
        Task {
            for a in leftovers { await a.end(nil, dismissalPolicy: .immediate) }
            self.schedulePulseRestore()
        }
        #endif
    }

    /// Bring back the Business Pulse island after ~1.5s (lets the voice
    /// activity's dismissal settle so the compact slot is free).
    private func schedulePulseRestore() {
        #if canImport(ActivityKit)
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            PulseRestore.restartFromCache()
        }
        #endif
    }

    private func currentPhase() -> String {
        switch engine?.state {
        case .listening: return "listening"
        case .transcribing, .thinking: return "thinking"
        case .speaking: return "speaking"
        default: return "idle"
        }
    }

    #if canImport(ActivityKit)
    private func contentState() -> AlmaVoiceActivityAttributes.ContentState {
        AlmaVoiceActivityAttributes.ContentState(
            phase: currentPhase(),
            startedAt: startedAt,
            isMuted: engine?.isMuted ?? false
        )
    }

    private func content(_ state: AlmaVoiceActivityAttributes.ContentState)
        -> ActivityContent<AlmaVoiceActivityAttributes.ContentState> {
        ActivityContent(
            state: state,
            staleDate: startedAt.addingTimeInterval(Self.maxSession)
        )
    }

    private func push() {
        guard let activity else { return }
        let state = contentState()
        lastPushedPhase = state.phase
        lastPushedMuted = state.isMuted
        Task { await activity.update(content(state)) }
    }
    #else
    private func push() {}
    #endif
}
