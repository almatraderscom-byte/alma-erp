//
//  AlmaVoiceActivityAttributes.swift
//  Shared between the App target and the AlmaWidgetExtension target.
//
//  ALMA voice-session Live Activity model (Dynamic Island + Lock Screen).
//  The App target drives it (VoiceLiveActivityController inside the voice
//  engine); the widget extension renders it (AlmaVoiceLiveActivity). This one
//  file is compiled into BOTH targets — keep it dependency-free, it is the
//  shared contract. See docs/alma-live-activity-PLAN.md.
//
//  ActivityKit is iOS 16.1+, but the voice engine itself is iOS 17+, so the
//  activity types are annotated 17.0 (matches AlmaVoiceEngine / the widget).
//

#if canImport(ActivityKit)
import ActivityKit
import Foundation

@available(iOS 17.0, *)
struct AlmaVoiceActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// listening | thinking | speaking | idle — drives island tint + Bangla status.
        var phase: String
        /// Last ~60 chars of the live caption, head-truncated + emoji-free
        /// (tail always visible — same rule as the in-app voice caption).
        var captionTail: String
        /// 12-bar waveform snapshot (0…1). Updated ~1/s; the island view
        /// spring-interpolates between snapshots so it reads as alive while
        /// staying inside the ActivityKit update budget.
        var levels: [Double]
        /// Session start — renders the elapsed timer without further updates.
        var startedAt: Date
    }

    var sessionTitle: String
}
#endif

// MARK: - End intent (island/lock-screen "শেষ" button → stop the voice session)

/// Posted by AlmaVoiceEndIntent; the live AlmaVoiceEngine observes this and
/// runs its normal end() teardown (mic, TTS, wake word, live activity).
extension Notification.Name {
    static let almaVoiceEndRequested = Notification.Name("alma.voice.end.requested")
    /// Island orb button → start listening without opening the app.
    static let almaVoiceListenRequested = Notification.Name("alma.voice.listen.requested")
}

#if canImport(AppIntents)
import AppIntents

/// LiveActivityIntent → perform() runs in the APP process (not the extension),
/// so it can reach the running voice engine via NotificationCenter. Ending the
/// activities directly here is the belt-and-braces fallback for the case where
/// the engine is already gone but the island somehow lingers.
@available(iOS 17.0, *)
struct AlmaVoiceEndIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "ভয়েস শেষ করুন"
    static var isDiscoverable: Bool = false

    func perform() async throws -> some IntentResult {
        await MainActor.run {
            NotificationCenter.default.post(name: .almaVoiceEndRequested, object: nil)
        }
        #if canImport(ActivityKit)
        for activity in Activity<AlmaVoiceActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        #endif
        return .result()
    }
}

/// Expanded-island orb button → the live engine starts a listen in the
/// BACKGROUND app process (no app foregrounding). Owner ask 2026-07-08:
/// "বাইরে থেকে দরকারমতো voice" without the tap bouncing him into the app.
@available(iOS 17.0, *)
struct AlmaVoiceListenIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "ALMA শুনুক"
    static var isDiscoverable: Bool = false

    func perform() async throws -> some IntentResult {
        await MainActor.run {
            NotificationCenter.default.post(name: .almaVoiceListenRequested, object: nil)
        }
        return .result()
    }
}
#endif
