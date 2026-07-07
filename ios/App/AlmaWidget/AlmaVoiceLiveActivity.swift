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
//  Motion budget: ActivityKit gives ~1 snapshot/s; TimelineView(.periodic) steps
//  the ribbon phase + orb fluids between snapshots, .animation springs the rest.
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
        case "listening": return 145
        case "thinking":  return 265
        case "speaking":  return 210
        default:          return 168
        }
    }
    static func status(_ phase: String) -> String {
        switch phase {
        case "listening": return "শুনছি Boss…"
        case "thinking":  return "ভাবছি…"
        case "speaking":  return "বলছি…"
        default:          return "প্রস্তুত"
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
    var size: CGFloat
    var hue: Double
    /// Fluids rotate in TimelineView steps; false = fully static (minimal slot).
    var animated: Bool = true

    var body: some View {
        Group {
            if animated {
                TimelineView(.periodic(from: .now, by: 0.5)) { tl in
                    layers(t: tl.date.timeIntervalSinceReferenceDate)
                }
            } else {
                layers(t: 0)
            }
        }
        .frame(width: size, height: size)
        .animation(.easeInOut(duration: 0.6), value: hue)
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

// MARK: - Iridescent ribbon wave (owner's reference: braided silk strands)

@available(iOS 17.0, *)
private struct RibbonWave: View {
    var levels: [Double]
    var hue: Double

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.4)) { tl in
            Canvas { ctx, sz in
                draw(ctx: &ctx, sz: sz, t: tl.date.timeIntervalSinceReferenceDate)
            }
        }
    }

    private func draw(ctx: inout GraphicsContext, sz: CGSize, t: Double) {
        let mid = sz.height / 2
        let energy = levels.suffix(6).max() ?? 0.1
        // demo parity: the braid stays clearly visible even at idle
        let A = (0.38 + energy * 0.62) * (sz.height / 2 - 1)
        ctx.blendMode = .plusLighter

        // faint center axis the strands melt into at both ends
        var axis = Path()
        axis.move(to: CGPoint(x: 0, y: mid)); axis.addLine(to: CGPoint(x: sz.width, y: mid))
        ctx.stroke(axis, with: .color(hcol(hue, 0.8, 0.75, 0.28)), lineWidth: 0.6)

        for s in 0..<6 {
            let pair: Double = s % 2 == 0 ? -1 : 1
            let hs = hue + (Double(s) / 5.0 - 0.5) * 200          // রামধনু, state-রঙ কেন্দ্রে
            let f = 1.5 + Double(s % 3) * 0.8
            let ph = t * (1.0 + Double(s) * 0.17) * pair + Double(s) * 1.9
            let n = 40
            var top: [CGPoint] = []; var bot: [CGPoint] = []
            top.reserveCapacity(n + 1); bot.reserveCapacity(n + 1)
            for i in 0...n {
                let k = Double(i) / Double(n)
                let x = k * sz.width
                let env = pow(sin(k * .pi), 1.2)
                let li = min(levels.count - 1, Int(k * Double(levels.count - 1)))
                let shape = 0.72 + levels[li] * 0.7               // waveform snapshot bends the braid
                let y = mid + env * A * sin(k * f * 6.283 + ph) * cos(k * 2.6 + t * 0.8 * pair) * shape
                let th = 0.7 + env * (1.4 + energy * 3.0) * (1 + 0.55 * sin(k * 9 + t * 2.2 + Double(s) * 1.3))
                top.append(CGPoint(x: x, y: y - th))
                bot.append(CGPoint(x: x, y: y + th))
            }
            var ribbon = Path()
            ribbon.move(to: top[0])
            for p in top.dropFirst() { ribbon.addLine(to: p) }
            for p in bot.reversed() { ribbon.addLine(to: p) }
            ribbon.closeSubpath()
            ctx.fill(ribbon, with: .color(hcol(hs, 0.92, 0.65, 0.42)))

            var core = Path()
            core.move(to: CGPoint(x: top[0].x, y: (top[0].y + bot[0].y) / 2))
            for i in 1...n {
                core.addLine(to: CGPoint(x: top[i].x, y: (top[i].y + bot[i].y) / 2))
            }
            ctx.stroke(core, with: .color(hcol(hs, 1.0, 0.85, 0.65)), lineWidth: 1.0)
        }
        ctx.blendMode = .normal
    }
}

// MARK: - Shared bits

@available(iOS 17.0, *)
private struct EndButton: View {
    var body: some View {
        Button(intent: AlmaVoiceEndIntent()) {
            HStack(spacing: 5) {
                Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
                Text("শেষ").font(.system(size: 13, weight: .semibold))
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
    }
}

@available(iOS 17.0, *)
private struct ElapsedTimer: View {
    let startedAt: Date
    var fontSize: CGFloat = 20
    var body: some View {
        Text(startedAt, style: .timer)
            .font(.system(size: fontSize, weight: .thin))
            .foregroundColor(Color(red: 0.87, green: 0.90, blue: 0.93))
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
            .frame(width: fontSize * 3)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
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
        .animation(.easeInOut(duration: 0.6), value: hue)
    }
}

// MARK: - Lock screen — translucent Liquid-Glass banner

@available(iOS 17.0, *)
private struct VoiceLockScreenView: View {
    let context: ActivityViewContext<AlmaVoiceActivityAttributes>

    var body: some View {
        let phase = context.state.phase
        let hue = VoiceHue.hue(phase)
        VStack(spacing: 9) {
            HStack(spacing: 9) {
                AlmaIslandOrb(size: 24, hue: hue)
                Wordmark()
                Text(VoiceHue.status(phase))
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(hcol(hue, 0.78, 0.9))
                    .lineLimit(1)
                Spacer(minLength: 6)
                ElapsedTimer(startedAt: context.state.startedAt, fontSize: 16)
            }
            RibbonWave(levels: context.state.levels, hue: hue)
                .frame(height: 26)
            HStack(spacing: 10) {
                goldCaption(context.state.captionTail.isEmpty ? "ভয়েস কথোপকথন" : context.state.captionTail)
                    .font(.system(size: 12))
                    .foregroundColor(VoiceHue.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 8)
                EndButton()
            }
        }
        .padding(14)
        .background(AuroraGlow(hue: hue))
        // glassy: low-alpha tint lets the wallpaper melt through (owner: "transparent")
        .activityBackgroundTint(Color.black.opacity(0.28))
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
            let phase = context.state.phase
            let hue = VoiceHue.hue(phase)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    AlmaIslandOrb(size: 46, hue: hue)
                        .frame(maxHeight: .infinity, alignment: .center)
                        .padding(.leading, 8)
                        .padding(.top, 6)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ElapsedTimer(startedAt: context.state.startedAt)
                        .padding(.trailing, 4)
                        .padding(.top, 8)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 6) {
                        HStack(spacing: 8) {
                            Wordmark(size: 10.5)
                            Text(VoiceHue.status(phase))
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(hcol(hue, 0.8, 0.9))
                                .lineLimit(1)
                        }
                        RibbonWave(levels: context.state.levels, hue: hue)
                            .frame(height: 30)
                            .frame(maxWidth: .infinity)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(alignment: .center, spacing: 10) {
                        goldCaption(context.state.captionTail.isEmpty ? "ভয়েস কথোপকথন" : context.state.captionTail)
                            .font(.system(size: 12))
                            .foregroundColor(VoiceHue.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                        Spacer(minLength: 8)
                        EndButton()
                    }
                    .padding(.top, 4)
                }
            } compactLeading: {
                AlmaIslandOrb(size: 19, hue: hue)
                    .padding(.leading, 3)
            } compactTrailing: {
                RibbonWave(levels: Array(context.state.levels.suffix(8)), hue: hue)
                    .frame(width: 34, height: 20)
                    .padding(.trailing, 2)
            } minimal: {
                AlmaIslandOrb(size: 17, hue: hue, animated: false)
            }
            .widgetURL(URL(string: "almaerp://agent"))
            .keylineTint(hcol(hue, 0.8, 0.9))
        }
    }
}
#endif
