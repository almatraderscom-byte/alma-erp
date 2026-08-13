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
    static let freshnessRefreshSeconds: TimeInterval = 60
    static let maximumSessionSeconds: TimeInterval = 30 * 60
    /// A clean local end publishes a terminal state briefly, then asks the
    /// system to remove it. The dismissal is owned by ActivityKit after the
    /// request, so it is not lost if the app is suspended immediately after.
    static let endedDismissalSeconds: TimeInterval = 4
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

    /// `staleDate` is the only ActivityKit deadline that survives process
    /// termination without a remote push. Bound every update by both the
    /// freshness window and the session hard limit. Once it fires, the widget
    /// renders terminal UI (no timer, listen action, or waveform implication).
    static func staleDate(now: Date, startedAt: Date) -> Date {
        min(staleDate(now: now), hardExpiry(startedAt: startedAt))
    }

    static func hardExpiry(startedAt: Date) -> Date {
        startedAt.addingTimeInterval(maximumSessionSeconds)
    }

    static func isTerminal(
        phase: String,
        startedAt: Date,
        isStale: Bool,
        now: Date
    ) -> Bool {
        isStale
            || normalizedPhase(phase) == "ended"
            || now >= hardExpiry(startedAt: startedAt)
    }

    static func effectivePhase(
        phase: String,
        startedAt: Date,
        isStale: Bool,
        now: Date
    ) -> String {
        isTerminal(
            phase: phase,
            startedAt: startedAt,
            isStale: isStale,
            now: now)
            ? "ended"
            : normalizedPhase(phase)
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
        return phaseStatus(phase)
    }

    static func phaseStatus(_ phase: String) -> String {
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

/// Pure rendering policy for every Live Activity family. Keeping layout and
/// accessibility decisions here makes the constrained Dynamic Island variants
/// testable without claiming that a simulator exercised ActivityKit itself.
@available(iOS 17.0, *)
enum AlmaVoiceActivityPresentationPolicy {
    enum Surface: CaseIterable, Equatable, Sendable {
        case lockScreen
        case expanded
        case compact
        case minimal
    }

    struct Environment: Equatable, Sendable {
        let isAccessibilitySize: Bool
        let reduceTransparency: Bool
        let increaseContrast: Bool
    }

    struct Presentation: Equatable, Sendable {
        let phase: String
        let status: String
        let systemImage: String
        let accessibilityLabel: String
        let accessibilityValue: String
        let accessibilityHint: String
        let showsElapsedTimer: Bool
        let showsListenAction: Bool
        let showsEndAction: Bool
        let usesStackedLayout: Bool
        let statusLineLimit: Int?
        let minimumInteractiveTarget: Double
        let backgroundOpacity: Double
        let minimumTextContrastRatio: Double
    }

    static func presentation(
        phase rawPhase: String,
        isMuted: Bool,
        startedAt: Date,
        isStale: Bool,
        now: Date,
        surface: Surface,
        environment: Environment
    ) -> Presentation {
        let terminal = AlmaVoiceActivityPrivacyPolicy.isTerminal(
            phase: rawPhase,
            startedAt: startedAt,
            isStale: isStale,
            now: now)
        let phase = terminal
            ? "ended"
            : AlmaVoiceActivityPrivacyPolicy.normalizedPhase(rawPhase)
        let status = isStale
            ? "সেশন শেষ—আপডেট বন্ধ"
            : AlmaVoiceActivityPrivacyPolicy.phaseStatus(phase)
        let microphoneSuffix = isMuted && !terminal ? ", মাইক্রোফোন বন্ধ" : ""
        let hasFullControls = surface == .lockScreen || surface == .expanded
        let needsOpaqueBacking = environment.reduceTransparency
            || environment.increaseContrast
        let backgroundOpacity = needsOpaqueBacking ? 0.96 : 0.86

        return Presentation(
            phase: phase,
            status: status,
            systemImage: systemImage(
                phase: phase,
                isMuted: isMuted,
                isStale: isStale),
            accessibilityLabel: "ALMA লাইভ ভয়েস",
            accessibilityValue: status + microphoneSuffix,
            accessibilityHint: terminal
                ? "সেশনটি আর চলছে না"
                : "চলমান ভয়েস সেশনের বর্তমান অবস্থা",
            showsElapsedTimer: hasFullControls && !terminal,
            showsListenAction: surface == .expanded && !terminal,
            showsEndAction: hasFullControls && !terminal,
            usesStackedLayout: environment.isAccessibilitySize && hasFullControls,
            statusLineLimit: environment.isAccessibilitySize && hasFullControls ? nil : 1,
            minimumInteractiveTarget: 44,
            // Worst-case wallpaper is white. An 86% black scrim keeps the
            // secondary text token above 7:1; accessibility contrast raises
            // the backing to 96%, where that token remains above 9.5:1.
            backgroundOpacity: backgroundOpacity,
            minimumTextContrastRatio: secondaryTextContrastRatio(
                blackBackingOpacity: backgroundOpacity))
    }

    private static func systemImage(
        phase: String,
        isMuted: Bool,
        isStale: Bool
    ) -> String {
        if isStale { return "clock.badge.exclamationmark" }
        if phase == "ended" { return "checkmark.circle.fill" }
        if isMuted { return "mic.slash.fill" }
        switch phase {
        case "connecting": return "antenna.radiowaves.left.and.right"
        case "listening": return "waveform"
        case "thinking": return "brain.head.profile"
        case "working": return "gearshape.2.fill"
        case "speaking": return "speaker.wave.2.fill"
        case "reconnecting": return "arrow.triangle.2.circlepath"
        default: return "circle.fill"
        }
    }

    /// WCAG relative-luminance contrast for the widget's secondary text token
    /// (#ADB5C2, represented below by its source RGB) over the worst-case white
    /// wallpaper after applying a black backing at `blackBackingOpacity`.
    private static func secondaryTextContrastRatio(
        blackBackingOpacity: Double
    ) -> Double {
        let textLuminance = relativeLuminance(red: 0.68, green: 0.71, blue: 0.76)
        let backgroundChannel = 1 - blackBackingOpacity
        let backgroundLuminance = relativeLuminance(
            red: backgroundChannel,
            green: backgroundChannel,
            blue: backgroundChannel)
        return (max(textLuminance, backgroundLuminance) + 0.05)
            / (min(textLuminance, backgroundLuminance) + 0.05)
    }

    private static func relativeLuminance(
        red: Double,
        green: Double,
        blue: Double
    ) -> Double {
        0.2126 * linearized(red)
            + 0.7152 * linearized(green)
            + 0.0722 * linearized(blue)
    }

    private static func linearized(_ component: Double) -> Double {
        component <= 0.04045
            ? component / 12.92
            : pow((component + 0.055) / 1.055, 2.4)
    }
}

@available(iOS 17.0, *)
struct AlmaVoiceActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Privacy-safe low-frequency phase. Never transcript/reply text.
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
            let current = activity.content.state
            let ended = AlmaVoiceActivityAttributes.ContentState(
                phase: "ended",
                startedAt: current.startedAt,
                isMuted: current.isMuted)
            let endedAt = Date()
            await activity.end(
                ActivityContent(state: ended, staleDate: endedAt),
                dismissalPolicy: .after(endedAt.addingTimeInterval(
                    AlmaVoiceActivityPrivacyPolicy.endedDismissalSeconds)))
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
