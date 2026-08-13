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
enum AlmaVoiceActivityLifecyclePhasePolicy {
    /// A terminal engine fallback wins even if lifecycle delivery stopped on
    /// an older reconnecting value. Otherwise lifecycle truth outranks the
    /// conversational fallback only when it has a distinct visible meaning.
    static func resolve(
        _ truth: AlmaLiveVoiceLifecycleReducer.UITruth,
        conversationalFallback: String
    ) -> String {
        let fallback = AlmaVoiceActivityPrivacyPolicy.normalizedPhase(
            conversationalFallback)
        if fallback == "ended" { return "ended" }

        switch truth.session {
        case .ended:
            return "ended"
        case .reconnecting:
            // The reducer starts from provider-disconnected. While the engine
            // is actually making its first connection, do not turn that seed
            // into a false reconnecting claim.
            return fallback == "connecting" ? "connecting" : "reconnecting"
        case .suspended:
            return "idle"
        case .ready:
            if case .pending(let count) = truth.work, count > 0 {
                return "working"
            }
            return fallback
        }
    }
}

@available(iOS 17.0, *)
@MainActor
final class VoiceLiveActivityController {
    weak var engine: AlmaVoiceEngine?

    #if canImport(ActivityKit)
    private var activity: Activity<AlmaVoiceActivityAttributes>?
    #endif
    private var expiryTask: Task<Void, Never>?
    private var freshnessTask: Task<Void, Never>?
    private var lastPushedPhase = ""
    private var lastPushedMuted = false
    private var startedAt = Date()
    private var lifecycleTruth: AlmaLiveVoiceLifecycleReducer.UITruth?

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
        lifecycleTruth = nil
        startedAt = Date()
        let state = contentState()
        let existingActivities = Activity<AlmaVoiceActivityAttributes>.activities
        if let existing = existingActivities.first {
            activity = existing
            Task { await existing.update(content(state)) }
            for duplicate in existingActivities.dropFirst() {
                Task { await duplicate.end(nil, dismissalPolicy: .immediate) }
            }
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
            try? await Task.sleep(
                nanoseconds: UInt64(
                    AlmaVoiceActivityPrivacyPolicy.maximumSessionSeconds
                        * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.end()
        }
        freshnessTask?.cancel()
        freshnessTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(
                    nanoseconds: UInt64(
                        AlmaVoiceActivityPrivacyPolicy.freshnessRefreshSeconds
                            * 1_000_000_000))
                guard !Task.isCancelled, let self else { return }
                // This is a low-frequency liveness refresh only. It carries the
                // same privacy-safe state and cannot resemble realtime audio.
                self.push()
            }
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
        guard AlmaLiveVoiceRecoveryFeatures.isEnabled(.privateLiveActivityV1) else {
            end()
            return
        }
        guard activity != nil else { return }
        let phase = currentPhase()
        let muted = currentMuted()
        guard AlmaVoiceActivityPrivacyPolicy.shouldPublish(
            previousPhase: lastPushedPhase,
            previousMuted: lastPushedMuted,
            nextPhase: phase,
            nextMuted: muted) else { return }
        push()
        #endif
    }

    /// Consumes the generation-bound lifecycle reducer's accepted UI truth.
    /// The production adapter calls this for every `.update` plan; no raw
    /// provider, transcript, tool argument/result, or audio value crosses into
    /// ActivityKit.
    func applyLifecycle(_ truth: AlmaLiveVoiceLifecycleReducer.UITruth) {
        lifecycleTruth = truth
        if case .ended = truth.session {
            end()
            return
        }
        stateChanged()
    }

    /// Session over (engine.end / hard timeout) — hand ActivityKit a terminal
    /// state and delayed dismissal in one call. After that system-owned grace
    /// period, restore Business Pulse once the island slot is free.
    func end() {
        expiryTask?.cancel(); expiryTask = nil
        freshnessTask?.cancel(); freshnessTask = nil
        #if canImport(ActivityKit)
        let endedAt = Date()
        let terminalState = AlmaVoiceActivityAttributes.ContentState(
            phase: "ended",
            startedAt: startedAt,
            isMuted: currentMuted())
        let terminalContent = ActivityContent(
            state: terminalState,
            staleDate: endedAt)
        activity = nil
        let leftovers = Activity<AlmaVoiceActivityAttributes>.activities
        guard !leftovers.isEmpty else {
            schedulePulseRestore()
            return
        }
        Task {
            let dismissalDate = endedAt.addingTimeInterval(
                AlmaVoiceActivityPrivacyPolicy.endedDismissalSeconds)
            for a in leftovers {
                await a.end(
                    terminalContent,
                    dismissalPolicy: .after(dismissalDate))
            }
            self.schedulePulseRestore(
                after: AlmaVoiceActivityPrivacyPolicy.endedDismissalSeconds + 1.5)
        }
        #endif
    }

    /// Bring back the Business Pulse island after ~1.5s (lets the voice
    /// activity's dismissal settle so the compact slot is free).
    private func schedulePulseRestore(after delay: TimeInterval = 1.5) {
        #if canImport(ActivityKit)
        Task {
            try? await Task.sleep(
                nanoseconds: UInt64(max(0, delay) * 1_000_000_000))
            PulseRestore.restartFromCache()
        }
        #endif
    }

    private func currentPhase() -> String {
        let conversationalPhase: String
        switch engine?.callConnection {
        case .connecting:
            conversationalPhase = "connecting"
        case .reconnecting:
            conversationalPhase = "reconnecting"
        case .failed:
            conversationalPhase = "ended"
        default:
            switch engine?.state {
            case .listening: conversationalPhase = "listening"
            case .transcribing, .thinking: conversationalPhase = "thinking"
            case .speaking: conversationalPhase = "speaking"
            case .error: conversationalPhase = "reconnecting"
            default: conversationalPhase = "idle"
            }
        }
        guard let lifecycleTruth else {
            return AlmaVoiceActivityPrivacyPolicy.normalizedPhase(
                conversationalPhase)
        }
        return AlmaVoiceActivityLifecyclePhasePolicy.resolve(
            lifecycleTruth,
            conversationalFallback: conversationalPhase)
    }

    private func currentMuted() -> Bool {
        lifecycleTruth?.isMuted ?? engine?.isMuted ?? false
    }

    #if canImport(ActivityKit)
    private func contentState() -> AlmaVoiceActivityAttributes.ContentState {
        AlmaVoiceActivityAttributes.ContentState(
            phase: currentPhase(),
            startedAt: startedAt,
            isMuted: currentMuted()
        )
    }

    private func content(_ state: AlmaVoiceActivityAttributes.ContentState)
        -> ActivityContent<AlmaVoiceActivityAttributes.ContentState> {
        ActivityContent(
            state: state,
            staleDate: AlmaVoiceActivityPrivacyPolicy.staleDate(
                now: Date(),
                startedAt: state.startedAt)
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
