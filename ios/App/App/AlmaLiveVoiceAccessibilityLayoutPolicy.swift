//
//  AlmaLiveVoiceAccessibilityLayoutPolicy.swift
//  App
//
//  Pure accessibility and layout policy for the Live Voice surface.
//

import Foundation

/// Produces deterministic accessibility metadata and presentation tokens without
/// depending on SwiftUI, UIKit, device globals, or mutable session state. The
/// Live Voice view can map its environment into `Environment` and render this
/// decision without duplicating accessibility breakpoints across controls.
struct AlmaLiveVoiceAccessibilityLayoutPolicy: Sendable {
    enum SessionPhase: Equatable, Sendable {
        case connecting
        case listening
        case working
        case speaking
        case reconnecting
        case ended

        fileprivate var accessibilityValue: String {
            switch self {
            case .connecting: return "সংযোগ হচ্ছে"
            case .listening: return "শুনছি"
            case .working: return "কাজ করছি"
            case .speaking: return "বলছি"
            case .reconnecting: return "সংযোগ ফিরে আনা হচ্ছে"
            case .ended: return "কল শেষ হয়েছে"
            }
        }
    }

    /// Every interactive or changing element on the foreground Live Voice and
    /// voice-selection surfaces has one source for its spoken metadata.
    enum Element: Equatable, Sendable {
        case sessionStatus(phase: SessionPhase, isMuted: Bool)
        case microphone(isMuted: Bool)
        case voiceSettings(selectedVoice: String)
        case voicePreview(voiceName: String, isPlaying: Bool)
        case applyToCurrentCall(isEnabled: Bool)
        case saveForNextCall
        case endCall
    }

    struct VoiceOverDescriptor: Equatable, Sendable {
        let label: String
        let hint: String
        let value: String?
        /// Ascending rank for a stable status -> controls -> destructive-action
        /// reading order. The UI remains responsible for applying the rank.
        let readingOrder: Int
    }

    /// Mirrors every Dynamic Type category the Live Voice surface supports while
    /// keeping this policy independent from SwiftUI's `DynamicTypeSize`.
    enum TextSize: Int, CaseIterable, Equatable, Sendable {
        case extraSmall
        case small
        case medium
        case large
        case extraLarge
        case extraExtraLarge
        case extraExtraExtraLarge
        case accessibility1
        case accessibility2
        case accessibility3
        case accessibility4
        case accessibility5

        var isAccessibilitySize: Bool { rawValue >= TextSize.accessibility1.rawValue }
    }

    enum Orientation: Equatable, Sendable {
        case portrait
        case landscape
    }

    struct Viewport: Equatable, Sendable {
        let width: Double
        let height: Double

        init(width: Double, height: Double) {
            self.width = width.isFinite ? max(0, width) : 0
            self.height = height.isFinite ? max(0, height) : 0
        }

        var orientation: Orientation {
            width > height ? .landscape : .portrait
        }

        fileprivate var shortEdge: Double { min(width, height) }
    }

    struct Environment: Equatable, Sendable {
        let viewport: Viewport
        let textSize: TextSize
        let isBoldTextEnabled: Bool
        let isReduceMotionEnabled: Bool
        let isReduceTransparencyEnabled: Bool
        let isIncreaseContrastEnabled: Bool
    }

    enum LayoutMode: Equatable, Sendable {
        case regularPortrait
        case smallPortrait
        case compactLandscape
        case accessibilityStacked
    }

    enum Axis: Equatable, Sendable {
        case horizontal
        case vertical
    }

    struct Geometry: Equatable, Sendable {
        let mode: LayoutMode
        let orientation: Orientation
        let controlAxis: Axis
        let minimumHitTargetPoints: Double
        let preferredControlDiameterPoints: Double
        let controlSpacingPoints: Double
        let outerPaddingPoints: Double
        let maximumContentWidthPoints: Double
        let maximumOrbDiameterPoints: Double
        /// `nil` means the status may use as many lines as its Dynamic Type size
        /// requires. This is mandatory for accessibility sizes.
        let statusLineLimit: Int?
        let showsPersistentControlTitles: Bool
        let scrollsVertically: Bool
    }

    enum FontEmphasis: Equatable, Sendable {
        case systemDefault
        case boldTextEnabled
    }

    struct Typography: Equatable, Sendable {
        let textSize: TextSize
        let emphasis: FontEmphasis
        let usesSystemMetrics: Bool
        let allowsMultilineControlTitles: Bool
        let allowsTextCompression: Bool
    }

    enum MotionStyle: Equatable, Sendable {
        /// Motion may follow measured model-output PCM only; it must never use a
        /// synthetic oscillator or the owner's microphone level.
        case outputPCMReactive
        /// State/color changes remain visible, but scale, pulse, sweep, and
        /// perpetual motion are disabled.
        case staticStateChanges
    }

    enum SurfaceStyle: Equatable, Sendable {
        /// A material may be used only with a contrast backing/scrim. Bare text
        /// over arbitrary content is not an allowed policy output.
        case contrastBackedMaterial
        /// Opaque adaptive background and foreground tokens for Reduce
        /// Transparency or Increase Contrast.
        case opaqueHighContrast

        var usesTransparency: Bool { self == .contrastBackedMaterial }
        var isContrastSafe: Bool { true }
        var minimumTextContrastRatio: Double { 4.5 }
    }

    struct Presentation: Equatable, Sendable {
        let geometry: Geometry
        let typography: Typography
        let motion: MotionStyle
        let surface: SurfaceStyle
    }

    static func voiceOverDescriptor(for element: Element) -> VoiceOverDescriptor {
        switch element {
        case .sessionStatus(let phase, let isMuted):
            let mutedSuffix = isMuted && phase != .ended
                ? ", মাইক্রোফোন বন্ধ"
                : ""
            return VoiceOverDescriptor(
                label: "লাইভ ভয়েস অবস্থা",
                hint: "কলের বর্তমান সংযোগ ও কথোপকথনের অবস্থা",
                value: phase.accessibilityValue + mutedSuffix,
                readingOrder: 0)

        case .microphone(let isMuted):
            return VoiceOverDescriptor(
                label: "মাইক্রোফোন",
                hint: isMuted
                    ? "মাইক্রোফোন চালু হবে"
                    : "মাইক্রোফোন বন্ধ হবে",
                value: isMuted ? "বন্ধ" : "চালু",
                readingOrder: 10)

        case .voiceSettings(let selectedVoice):
            return VoiceOverDescriptor(
                label: "ভয়েস সেটিংস",
                hint: "মডেল ও ভয়েস বেছে নিন",
                value: displayName(selectedVoice),
                readingOrder: 20)

        case .voicePreview(let voiceName, let isPlaying):
            return VoiceOverDescriptor(
                label: "\(displayName(voiceName)) ভয়েস প্রিভিউ",
                hint: isPlaying
                    ? "ভয়েস নমুনা বন্ধ হবে"
                    : "ভয়েস নমুনা চালু হবে",
                value: isPlaying ? "চলছে" : "বন্ধ",
                readingOrder: 30)

        case .applyToCurrentCall(let isEnabled):
            return VoiceOverDescriptor(
                label: "বর্তমান কলে প্রয়োগ করুন",
                hint: isEnabled
                    ? "নির্বাচিত মডেল ও ভয়েস এই সক্রিয় কলে প্রয়োগ হবে"
                    : "সক্রিয় কল প্রস্তুত হলে প্রয়োগ করা যাবে",
                value: isEnabled ? "উপলব্ধ" : "অনুপলব্ধ",
                readingOrder: 40)

        case .saveForNextCall:
            return VoiceOverDescriptor(
                label: "পরবর্তী কলের জন্য সংরক্ষণ করুন",
                hint: "নির্বাচিত মডেল ও ভয়েস পরবর্তী নতুন কলে ব্যবহার হবে",
                value: nil,
                readingOrder: 50)

        case .endCall:
            return VoiceOverDescriptor(
                label: "কল শেষ করুন",
                hint: "লাইভ ভয়েস সেশন শেষ হবে",
                value: nil,
                readingOrder: 60)
        }
    }

    static func presentation(for environment: Environment) -> Presentation {
        let viewport = environment.viewport
        let isAccessibilitySize = environment.textSize.isAccessibilitySize
        let isSmallScreen = viewport.shortEdge <= 375 || (
            viewport.orientation == .portrait && viewport.height <= 667)

        let mode: LayoutMode
        if isAccessibilitySize {
            mode = .accessibilityStacked
        } else if viewport.orientation == .landscape {
            mode = .compactLandscape
        } else if isSmallScreen {
            mode = .smallPortrait
        } else {
            mode = .regularPortrait
        }

        let outerPadding: Double
        switch mode {
        case .regularPortrait: outerPadding = 20
        case .smallPortrait, .compactLandscape: outerPadding = 12
        case .accessibilityStacked:
            outerPadding = isSmallScreen || viewport.orientation == .landscape ? 12 : 16
        }

        let widthInsidePadding = max(0, viewport.width - (outerPadding * 2))
        let orbCandidate: Double
        let heightFraction: Double
        switch mode {
        case .regularPortrait:
            orbCandidate = 220
            heightFraction = 0.30
        case .smallPortrait:
            orbCandidate = 160
            heightFraction = 0.30
        case .compactLandscape:
            orbCandidate = 132
            heightFraction = 0.36
        case .accessibilityStacked:
            orbCandidate = 128
            heightFraction = 0.22
        }
        let orbDiameter = min(
            orbCandidate,
            widthInsidePadding,
            max(0, viewport.height * heightFraction))

        let geometry = Geometry(
            mode: mode,
            orientation: viewport.orientation,
            controlAxis: isAccessibilitySize ? .vertical : .horizontal,
            minimumHitTargetPoints: 44,
            preferredControlDiameterPoints: isAccessibilitySize
                ? 56
                : (mode == .regularPortrait ? 60 : 52),
            controlSpacingPoints: mode == .regularPortrait ? 16 : 12,
            outerPaddingPoints: outerPadding,
            maximumContentWidthPoints: min(560, widthInsidePadding),
            maximumOrbDiameterPoints: orbDiameter,
            statusLineLimit: isAccessibilitySize
                ? nil
                : (mode == .smallPortrait ? 3 : 2),
            showsPersistentControlTitles: isAccessibilitySize,
            scrollsVertically: isAccessibilitySize
                || (viewport.orientation == .landscape && viewport.height < 375)
                || (viewport.orientation == .portrait && viewport.height < 600))

        let typography = Typography(
            textSize: environment.textSize,
            emphasis: environment.isBoldTextEnabled
                ? .boldTextEnabled
                : .systemDefault,
            usesSystemMetrics: true,
            allowsMultilineControlTitles: isAccessibilitySize,
            allowsTextCompression: false)

        let surface: SurfaceStyle = environment.isReduceTransparencyEnabled
            || environment.isIncreaseContrastEnabled
            ? .opaqueHighContrast
            : .contrastBackedMaterial

        return Presentation(
            geometry: geometry,
            typography: typography,
            motion: environment.isReduceMotionEnabled
                ? .staticStateChanges
                : .outputPCMReactive,
            surface: surface)
    }

    private static func displayName(_ rawName: String) -> String {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "নির্বাচিত ভয়েস" : name
    }
}
