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

/// Pure, dependency-free policy shared by the app, widget and tests. ActivityKit
/// is a low-frequency status surface: it never receives transcript text, PCM or
/// an audio-derived/synthetic level. Unknown phases fail closed to `idle`.
@available(iOS 17.0, *)
enum AlmaVoiceActivityPrivacyPolicy {
    static let staleAfterSeconds: TimeInterval = 90
    static let maximumSessionSeconds: TimeInterval = 30 * 60
    static let phases: Set<String> = [
        "idle", "connecting", "listening", "thinking", "working",
        "speaking", "reconnecting", "ended",
    ]

    static func normalizedPhase(_ value: String) -> String {
        phases.contains(value) ? value : "idle"
    }

    static func staleDate(now: Date) -> Date {
        now.addingTimeInterval(staleAfterSeconds)
    }

    static func hardExpiry(startedAt: Date) -> Date {
        startedAt.addingTimeInterval(maximumSessionSeconds)
    }

    static func shouldPublish(
        previousPhase: String,
        previousMuted: Bool,
        nextPhase: String,
        nextMuted: Bool
    ) -> Bool {
        normalizedPhase(previousPhase) != normalizedPhase(nextPhase)
            || previousMuted != nextMuted
    }

    static func status(
        phase: String,
        isMuted: Bool,
        isStale: Bool = false
    ) -> String {
        if isStale { return "সেশন আপডেট বন্ধ" }
        if isMuted { return "মাইক বন্ধ" }
        switch normalizedPhase(phase) {
        case "connecting": return "সংযোগ হচ্ছে"
        case "listening": return "শুনছি"
        case "thinking": return "ভাবছি"
        case "working": return "কাজ করছি"
        case "speaking": return "বলছি"
        case "reconnecting": return "আবার সংযোগ হচ্ছে"
        case "ended": return "শেষ হয়েছে"
        default: return "প্রস্তুত"
        }
    }
}

@available(iOS 17.0, *)
struct AlmaVoiceActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// listening | thinking | speaking | idle — drives island tint + Bangla status.
        var phase: String
        /// Session start — renders the elapsed timer without further updates.
        var startedAt: Date
        /// Truthful microphone state. No transcript, audio sample, or synthetic
        /// level ever leaves the foreground voice surface.
        var isMuted: Bool
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
