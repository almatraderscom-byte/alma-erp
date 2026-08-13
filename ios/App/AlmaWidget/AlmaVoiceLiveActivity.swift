//
//  AlmaVoiceLiveActivity.swift
//  AlmaWidget extension target only.
//
//  ALMA voice-session Dynamic Island + Lock Screen — OWNER-LOCKED design
//  (2026-07-08, iterated live in the HTML demo alma-island-demo.html):
//  • 3D glass orb (the voice page's fluid orb, SwiftUI twin) — NOT the starburst
//  • 6-strand iridescent ribbon wave (braided, additive glow, tapers to a line)
//  • aurora glow inside the expanded card (pill stays black — Apple's rule)
//  • lock screen = translucent Liquid-Glass banner (wallpaper shows through)
//  • thin iOS-clock timer, gold "Boss", glass-red ✕ শেষ button
//  • state hues = the app's AlmaVoiceState.hue EXACTLY:
//    idle 168 (cyan) · listening 145 (emerald) · thinking 265 (violet) · speaking 210 (azure)
//
//  Privacy/truth contract: ActivityKit renders a static phase-specific pose.
//  Realtime/synthetic speech animation stays inside the foreground app.
//

#if canImport(ActivityKit)
import ActivityKit
import WidgetKit
import SwiftUI

// MARK: - Palette (voice-page parity)

@available(iOS 17.0, *)
private enum VoiceHue {
    static func hue(_ phase: String) -> Double {
        switch phase {
        case "connecting": return 168
        case "listening": return 145
        case "thinking":  return 265
        case "working":   return 36
        case "speaking":  return 210
        case "reconnecting": return 24
        case "ended":     return 150
        default:          return 168
        }
    }
    static let gold  = Color(red: 0.851, green: 0.659, blue: 0.298)  // #d9a84c
    static let coral = Color(red: 0.851, green: 0.467, blue: 0.341)  // #d97757
    static let textSecondary = Color(red: 0.68, green: 0.71, blue: 0.76)
}

/// Hue-wrapping color helper (hue may exceed 0…360 from ribbon spreads).
@available(iOS 17.0, *)
private func hcol(_ h: Double, _ s: Double, _ b: Double, _ o: Double = 1) -> Color {
    let hh = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 360
    return Color(hue: hh, saturation: s, brightness: b, opacity: o)
}

// MARK: - The orb — SwiftUI twin of the voice page's glass fluid sphere

@available(iOS 17.0, *)
private struct AlmaIslandOrb: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var size: CGFloat
    var hue: Double
    /// Voice activities are static by default. The parameter remains only for
    /// previewing a decorative transition without changing the product contract.
    var animated: Bool = false

    var body: some View {
        Group {
            if animated && !reduceMotion {
                TimelineView(.periodic(from: .now, by: 0.5)) { tl in
                    layers(t: tl.date.timeIntervalSinceReferenceDate)
                }
            } else {
                layers(t: 0)
            }
        }
        .frame(width: size, height: size)
        .animation(
            reduceMotion ? nil : .easeInOut(duration: 0.6),
            value: hue)
    }

    @ViewBuilder private func layers(t: Double) -> some View {
        ZStack {
            // outer halo — tight so region clipping never shows a square edge
            Circle()
                .fill(RadialGradient(
                    colors: [hcol(hue, 0.9, 0.68, 0.35), hcol(hue, 0.9, 0.6, 0)],
                    center: .center, startRadius: size * 0.42, endRadius: size * 0.62))
                .frame(width: size * 1.25, height: size * 1.25)
            // volumetric core — bright key light, DEEP dark rim (the 3D read)
            Circle()
                .fill(RadialGradient(
                    stops: [
                        .init(color: hcol(hue, 0.35, 1.00), location: 0),
                        .init(color: hcol(hue, 0.80, 0.85), location: 0.24),
                        .init(color: hcol(hue, 0.90, 0.46), location: 0.58),
                        .init(color: hcol(hue, 0.92, 0.10), location: 1),
                    ],
                    center: UnitPoint(x: 0.33, y: 0.27),
                    startRadius: 0, endRadius: size * 0.70))
            // two counter-rotating iridescent fluids — crisp visible streaks
            if size >= 22 {
                fluid(t: t, speed: 0.55, offset: 45, inset: 0.08, alpha: 0.65)
                fluid(t: t, speed: -0.38, offset: -30, inset: 0.18, alpha: 0.55)
            }
            // glass gloss
            Ellipse()
                .fill(LinearGradient(colors: [.white.opacity(0.85), .clear],
                                     startPoint: .top, endPoint: .bottom))
                .frame(width: size * 0.46, height: size * 0.27)
                .offset(x: -size * 0.15, y: -size * 0.30)
                .blur(radius: max(0.5, size * 0.02))
            // fresnel rim — brighter, sells the glass edge
            Circle()
                .strokeBorder(hcol(hue, 0.85, 0.95, 0.55), lineWidth: max(0.8, size * 0.022))
                .blur(radius: max(0.3, size * 0.008))
        }
        .frame(width: size, height: size)
    }

    private func fluid(t: Double, speed: Double, offset: Double, inset: CGFloat, alpha: Double) -> some View {
        Circle()
            .fill(AngularGradient(
                stops: [
                    .init(color: .clear, location: 0),
                    .init(color: hcol(hue + offset, 0.95, 0.85, alpha), location: 0.20),
                    .init(color: .clear, location: 0.42),
                    .init(color: hcol(hue - offset * 0.7, 0.9, 0.75, alpha * 0.85), location: 0.68),
                    .init(color: .clear, location: 0.95),
                ], center: .center))
            .padding(size * inset)
            .blur(radius: max(0.6, size * 0.03))
            .rotationEffect(.radians(t * speed))
            .mask(Circle().padding(size * inset))
    }
}

// MARK: - Privacy-safe state line

@available(iOS 17.0, *)
private struct VoiceStateLine: View {
    let presentation: AlmaVoiceActivityPresentationPolicy.Presentation

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: presentation.systemImage)
                .foregroundStyle(
                    presentation.phase == "ended"
                        || presentation.systemImage == "mic.slash.fill"
                        ? VoiceHue.coral
                        : hcol(VoiceHue.hue(presentation.phase), 0.8, 0.95))
            Text(presentation.status)
                .font(.caption.weight(.semibold))
                .foregroundStyle(VoiceHue.textSecondary)
                .lineLimit(presentation.statusLineLimit)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(presentation.accessibilityLabel)
        .accessibilityValue(presentation.accessibilityValue)
        .accessibilityHint(presentation.accessibilityHint)
    }
}

// MARK: - Shared bits

@available(iOS 17.0, *)
private struct EndButton: View {
    var body: some View {
        Button(intent: AlmaVoiceEndIntent()) {
            HStack(spacing: 5) {
                Image(systemName: "xmark").font(.caption.weight(.bold))
                Text("শেষ").font(.caption.weight(.semibold))
            }
            .foregroundColor(Color(red: 1.0, green: 0.85, blue: 0.85))
            .padding(.horizontal, 13)
            .padding(.vertical, 6)
            .background(
                Capsule()
                    .fill(LinearGradient(
                        colors: [Color(red: 0.85, green: 0.28, blue: 0.28).opacity(0.78),
                                 Color(red: 0.59, green: 0.14, blue: 0.14).opacity(0.58)],
                        startPoint: .topLeading, endPoint: .bottomTrailing))
                    .overlay(Capsule().strokeBorder(.white.opacity(0.28), lineWidth: 0.5))
            )
        }
        .buttonStyle(.plain)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
        .accessibilityLabel("ভয়েস সেশন শেষ করুন")
        .accessibilityHint("ALMA-এর চলমান ভয়েস সেশন বন্ধ করবে")
    }
}

@available(iOS 17.0, *)
private struct ElapsedTimer: View {
    let startedAt: Date
    var font: Font = .title3
    var body: some View {
        Text(startedAt, style: .timer)
            .font(font.weight(.thin))
            .foregroundColor(Color(red: 0.87, green: 0.90, blue: 0.93))
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityLabel("কলের সময়")
    }
}

@available(iOS 17.0, *)
private struct Wordmark: View {
    var size: CGFloat = 11.5
    var body: some View {
        HStack(spacing: 7) {
            (Text("ALMA").foregroundColor(.white) + Text(".").foregroundColor(VoiceHue.coral))
                .font(.system(size: size, weight: .heavy))
                .kerning(3)
            Circle().fill(Color(red: 0.21, green: 0.88, blue: 0.56))
                .frame(width: 5, height: 5)
                .shadow(color: Color(red: 0.21, green: 0.88, blue: 0.56), radius: 4)
        }
        .accessibilityHidden(true)
    }
}

/// Caption with "Boss"/"বস" in gold — voice-console parity.
@available(iOS 17.0, *)
private func goldCaption(_ text: String) -> Text {
    var out = Text("")
    var rest = Substring(text)
    while true {
        let hits = ["Boss", "বস"].compactMap { rest.range(of: $0) }
        guard let r = hits.min(by: { $0.lowerBound < $1.lowerBound }) else { break }
        out = out + Text(String(rest[..<r.lowerBound]))
        out = out + Text(String(rest[r])).foregroundColor(VoiceHue.gold).fontWeight(.bold)
        rest = rest[r.upperBound...]
    }
    return out + Text(String(rest))
}

/// Aurora glow behind expanded-card / banner content (state hue + neighbors).
@available(iOS 17.0, *)
private struct AuroraGlow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var hue: Double
    var body: some View {
        ZStack {
            RadialGradient(colors: [hcol(hue, 0.75, 0.42, 0.28), .clear],
                           center: UnitPoint(x: 0.1, y: 0.05), startRadius: 0, endRadius: 150)
            RadialGradient(colors: [hcol(hue + 60, 0.7, 0.38, 0.20), .clear],
                           center: UnitPoint(x: 0.95, y: 1.0), startRadius: 0, endRadius: 170)
            RadialGradient(colors: [hcol(hue - 40, 0.65, 0.3, 0.14), .clear],
                           center: UnitPoint(x: 0.5, y: 1.15), startRadius: 0, endRadius: 200)
        }
        .animation(
            reduceMotion ? nil : .easeInOut(duration: 0.6),
            value: hue)
    }
}

// MARK: - Lock screen — translucent Liquid-Glass banner

@available(iOS 17.0, *)
private struct VoiceLockScreenView: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let context: ActivityViewContext<AlmaVoiceActivityAttributes>

    var body: some View {
        let presentation = AlmaVoiceActivityPresentationPolicy.presentation(
            phase: context.state.phase,
            isMuted: context.state.isMuted,
            startedAt: context.state.startedAt,
            isStale: context.isStale,
            now: Date(),
            surface: .lockScreen,
            environment: .init(
                isAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
                reduceTransparency: reduceTransparency,
                increaseContrast: colorSchemeContrast == .increased))
        let hue = VoiceHue.hue(presentation.phase)
        VStack(spacing: 9) {
            if presentation.usesStackedLayout {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 9) {
                        AlmaIslandOrb(size: 24, hue: hue)
                            .accessibilityHidden(true)
                        Wordmark()
                    }
                    VoiceStateLine(presentation: presentation)
                    if presentation.showsElapsedTimer {
                        ElapsedTimer(
                            startedAt: context.state.startedAt,
                            font: .body)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 9) {
                    AlmaIslandOrb(size: 24, hue: hue)
                        .accessibilityHidden(true)
                    Wordmark()
                    VoiceStateLine(presentation: presentation)
                    Spacer(minLength: 6)
                    if presentation.showsElapsedTimer {
                        ElapsedTimer(
                            startedAt: context.state.startedAt,
                            font: .callout)
                    }
                }
            }
            HStack(spacing: 10) {
                Text("কথোপকথনের লেখা ও অডিও এই Activity-তে রাখা হয় না")
                    .font(.caption2)
                    .foregroundStyle(VoiceHue.textSecondary)
                    .lineLimit(presentation.statusLineLimit)
                    .accessibilityLabel("গোপনীয়তা")
                    .accessibilityValue("কথোপকথনের লেখা ও অডিও লক স্ক্রিনে রাখা হয় না")
                if presentation.showsEndAction {
                    Spacer(minLength: 8)
                    EndButton()
                }
            }
        }
        .padding(14)
        .background(AuroraGlow(hue: hue))
        .activityBackgroundTint(
            Color.black.opacity(presentation.backgroundOpacity))
        .activitySystemActionForegroundColor(.white)
    }
}

// MARK: - Live Activity configuration

@available(iOS 17.0, *)
struct AlmaVoiceLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AlmaVoiceActivityAttributes.self) { context in
            VoiceLockScreenView(context: context)
        } dynamicIsland: { context in
            let environment = AlmaVoiceActivityPresentationPolicy.Environment(
                isAccessibilitySize: false,
                reduceTransparency: false,
                increaseContrast: false)
            let expanded = AlmaVoiceActivityPresentationPolicy.presentation(
                phase: context.state.phase,
                isMuted: context.state.isMuted,
                startedAt: context.state.startedAt,
                isStale: context.isStale,
                now: Date(),
                surface: .expanded,
                environment: environment)
            let compact = AlmaVoiceActivityPresentationPolicy.presentation(
                phase: context.state.phase,
                isMuted: context.state.isMuted,
                startedAt: context.state.startedAt,
                isStale: context.isStale,
                now: Date(),
                surface: .compact,
                environment: environment)
            let minimal = AlmaVoiceActivityPresentationPolicy.presentation(
                phase: context.state.phase,
                isMuted: context.state.isMuted,
                startedAt: context.state.startedAt,
                isStale: context.isStale,
                now: Date(),
                surface: .minimal,
                environment: environment)
            let hue = VoiceHue.hue(expanded.phase)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Group {
                        if expanded.showsListenAction {
                            Button(intent: AlmaVoiceListenIntent()) {
                                AlmaIslandOrb(size: 44, hue: hue)
                            }
                            .buttonStyle(.plain)
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                            .accessibilityLabel("ALMA শুনুক")
                            .accessibilityHint("চলমান ভয়েস সেশনে শোনা শুরু করবে")
                        } else {
                            AlmaIslandOrb(size: 44, hue: hue)
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(maxHeight: .infinity, alignment: .center)
                    .padding(.leading, 8)
                    .padding(.top, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Group {
                        if expanded.showsElapsedTimer {
                            ElapsedTimer(startedAt: context.state.startedAt)
                        } else {
                            Image(systemName: expanded.systemImage)
                                .foregroundStyle(VoiceHue.coral)
                                .accessibilityHidden(true)
                        }
                    }
                    .padding(.trailing, 4)
                    .padding(.top, 8)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 6) {
                        Wordmark(size: 10.5)
                        VoiceStateLine(presentation: expanded)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(alignment: .center, spacing: 10) {
                        Text("কথোপকথনের লেখা শুধু অ্যাপের ভেতরে")
                            .font(.caption2)
                            .foregroundColor(VoiceHue.textSecondary)
                            .lineLimit(expanded.statusLineLimit)
                            .accessibilityLabel("গোপনীয়তা")
                            .accessibilityValue("কথোপকথনের লেখা Dynamic Island-এ রাখা হয় না")
                        if expanded.showsEndAction {
                            Spacer(minLength: 8)
                            EndButton()
                        }
                    }
                    .padding(.top, 4)
                }
            } compactLeading: {
                OfficeRobotLiveGlyph(
                    context: .voice(phase: compact.phase),
                    size: 23,
                    animated: false
                )
                    .padding(.leading, 1)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(compact.accessibilityLabel)
                    .accessibilityValue(compact.accessibilityValue)
                    .accessibilityHint(compact.accessibilityHint)
            } compactTrailing: {
                Image(systemName: compact.systemImage)
                    .foregroundStyle(
                        compact.phase == "ended" || context.state.isMuted
                            ? VoiceHue.coral
                            : hcol(hue, 0.8, 0.95))
                    .frame(width: 28, height: 20)
                    .accessibilityLabel(compact.accessibilityLabel)
                    .accessibilityValue(compact.accessibilityValue)
                    .accessibilityHint(compact.accessibilityHint)
            } minimal: {
                OfficeRobotLiveGlyph(
                    context: .voice(phase: minimal.phase),
                    size: 20,
                    animated: false,
                    cadenceMultiplier: 1.30
                )
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(minimal.accessibilityLabel)
                    .accessibilityValue(minimal.accessibilityValue)
                    .accessibilityHint(minimal.accessibilityHint)
            }
            .widgetURL(URL(string: "almaerp://office-robot?target=almaerp%3A%2F%2Fagent"))
            .keylineTint(hcol(hue, 0.8, 0.9))
        }
    }
}
#endif
