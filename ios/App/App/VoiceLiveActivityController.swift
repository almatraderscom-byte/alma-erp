//
//  VoiceLiveActivityController.swift
//  App target only.
//
//  Drives the ALMA voice-session Live Activity (Dynamic Island + Lock Screen)
//  from AlmaVoiceEngine state. docs/alma-live-activity-PLAN.md §2.
//
//  Update-budget strategy: ActivityKit has no per-frame updates, so we sample
//  the engine's mic/TTS level at 80ms into a rolling 12-bar buffer and push a
//  snapshot roughly every 0.9s (phase flips may push after 0.35s). The widget
//  side spring-animates between snapshots — alive but budget-safe.
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
    private var loop: Task<Void, Never>?
    private var levels: [Double] = VoiceLiveActivityController.flatLevels
    private var lastPush = Date.distantPast
    private var lastPushedPhase = ""
    private var startedAt = Date()

    private static let flatLevels = [Double](repeating: 0.08, count: 12)
    private static let maxSession: TimeInterval = 30 * 60

    // MARK: - Lifecycle

    /// Console opened (engine.begin) — request one activity, or adopt a
    /// leftover one from a previous session, then start the sampler loop.
    func start() {
        #if canImport(ActivityKit)
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // Voice owns the island while a session runs: a live "Business Pulse"
        // activity would win the compact slot and hide the voice UI — end it.
        // (The web layer restarts Pulse on its next tick after the session.)
        for pulse in Activity<PulseActivityAttributes>.activities {
            Task { await pulse.end(nil, dismissalPolicy: .immediate) }
        }
        startedAt = Date()
        levels = Self.flatLevels
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
        lastPush = Date()
        lastPushedPhase = state.phase
        loop?.cancel()
        loop = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 80_000_000)
                guard let self, !Task.isCancelled else { return }
                self.sampleLevel()
                if Date().timeIntervalSince(self.startedAt) > Self.maxSession {
                    self.end()
                    return
                }
                if Date().timeIntervalSince(self.lastPush) >= 0.9 { self.push() }
            }
        }
        #endif
    }

    /// Engine state flipped (listening/thinking/speaking) — refresh the island
    /// sooner than the regular tick, still throttled.
    func phaseChanged() {
        #if canImport(ActivityKit)
        guard activity != nil, currentPhase() != lastPushedPhase,
              Date().timeIntervalSince(lastPush) >= 0.35 else { return }
        push()
        #endif
    }

    /// Session over (engine.end / stale timeout) — island disappears at once.
    /// After the voice activity is gone, the Business Pulse activity is
    /// restored from its cached last state (~1.5s later, once the island slot
    /// is free) — start() ended it, and the web layer can't restart it while
    /// the app is backgrounded.
    func end() {
        loop?.cancel(); loop = nil
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

    // MARK: - Sampling + snapshot

    /// 80ms tick: roll the engine's live audio level (TTS metering while
    /// speaking, mic RMS otherwise) into the 12-bar history.
    private func sampleLevel() {
        guard let e = engine else { return }
        let raw: Double
        switch e.state {
        case .speaking: raw = e.ttsLevel
        case .listening: raw = e.micLevel
        case .transcribing, .thinking:
            // gentle synthetic pulse — "ভাবছি" has no audio to meter
            raw = 0.18 + 0.14 * (0.5 + 0.5 * sin(Date().timeIntervalSinceReferenceDate * 2.4))
        default:
            // idle: soft traveling wave so the island ribbon never lies dead
            // (LOCKED demo behavior — quiet braid keeps breathing)
            raw = 0.10 + 0.06 * (0.5 + 0.5 * sin(Date().timeIntervalSinceReferenceDate * 1.7))
        }
        levels.removeFirst()
        levels.append(min(1, max(0.08, raw)))
    }

    private func currentPhase() -> String {
        switch engine?.state {
        case .listening: return "listening"
        case .transcribing, .thinking: return "thinking"
        case .speaking: return "speaking"
        default: return "idle"
        }
    }

    /// Last ~60 chars, head-truncated (tail visible), emoji-free — the same
    /// caption rule the in-app voice console follows.
    private func captionTail() -> String {
        guard let e = engine else { return "" }
        let raw: String
        switch e.state {
        case .speaking: raw = e.nowLine.isEmpty ? e.replyText : e.nowLine
        case .listening: raw = e.transcript
        default: raw = e.transcript
        }
        let scalars = raw.unicodeScalars.filter {
            !($0.properties.isEmojiPresentation || $0.value >= 0x1F000)
        }
        var s = String(String.UnicodeScalarView(scalars))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if s.count > 60 { s = "…" + s.suffix(60) }
        return s
    }

    #if canImport(ActivityKit)
    private func contentState() -> AlmaVoiceActivityAttributes.ContentState {
        AlmaVoiceActivityAttributes.ContentState(
            phase: currentPhase(),
            captionTail: captionTail(),
            levels: levels,
            startedAt: startedAt
        )
    }

    private func content(_ state: AlmaVoiceActivityAttributes.ContentState)
        -> ActivityContent<AlmaVoiceActivityAttributes.ContentState> {
        ActivityContent(state: state, staleDate: Date().addingTimeInterval(90))
    }

    private func push() {
        guard let activity else { return }
        lastPush = Date()
        let state = contentState()
        lastPushedPhase = state.phase
        Task { await activity.update(content(state)) }
    }
    #else
    private func push() {}
    #endif
}
