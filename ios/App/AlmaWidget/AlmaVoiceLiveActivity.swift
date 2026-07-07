//
//  AlmaVoiceLiveActivity.swift
//  AlmaWidget extension target only.
//
//  ALMA voice-session Dynamic Island + Lock Screen UI.
//  docs/alma-live-activity-PLAN.md §0/§1 — compact: starburst + mini waveform;
//  expanded: ✳ ALMA + Bangla status, big waveform, caption tail, End + timer;
//  minimal: phase-tinted starburst dot; lock screen: aurora-tinted banner.
//
//  The starburst is the LOCKED-spec organic burst path (AlmaOrganicBurst from
//  AlmaStarburstSpinner.swift, compiled into this target too). Extensions
//  can't run per-frame Canvas animation, so compact/minimal show a static
//  frame and expanded slow-cycles the 4 boil frames via TimelineView — the
//  waveform gets its life from spring-animating between ~1/s level snapshots.
//

#if canImport(ActivityKit)
import ActivityKit
import WidgetKit
import SwiftUI

// MARK: - Palette + Bangla status

@available(iOS 17.0, *)
private enum VoicePalette {
    /// Brand near-black (matches AlmaWidget.swift / PulseLiveActivity.swift).
    static let background = Color(red: 0x0c / 255.0, green: 0x0b / 255.0, blue: 0x12 / 255.0)
    /// Claude-burst orange #d97757 — the LOCKED wordmark color.
    static let burst = Color(red: 0.851, green: 0.467, blue: 0.341)
    static let textSecondary = Color(red: 0.72, green: 0.72, blue: 0.78)

    static func tint(_ phase: String) -> Color {
        switch phase {
        case "listening": return Color(red: 0.20, green: 0.83, blue: 0.60)  // emerald — শুনছি
        case "thinking":  return Color(red: 0.65, green: 0.55, blue: 0.98)  // violet — ভাবছি
        case "speaking":  return Color(red: 0.98, green: 0.57, blue: 0.24)  // orange — বলছি
        default:          return Color(red: 0.55, green: 0.55, blue: 0.62)
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
}

// MARK: - Starburst (static frame / slow boil)

@available(iOS 17.0, *)
private struct AlmaBurstShape: Shape {
    var frame: Int = 0
    func path(in rect: CGRect) -> Path {
        AlmaOrganicBurst.boiled(frame: frame & 3, amp: 1.1)
            .applying(CGAffineTransform(scaleX: rect.width / 100, y: rect.height / 100))
    }
}

@available(iOS 17.0, *)
private struct BurstIcon: View {
    var size: CGFloat
    var color: Color = VoicePalette.burst
    var boil: Bool = false

    var body: some View {
        if boil {
            TimelineView(.periodic(from: .now, by: 0.5)) { tl in
                AlmaBurstShape(frame: Int(tl.date.timeIntervalSinceReferenceDate * 2))
                    .fill(color)
                    .frame(width: size, height: size)
            }
        } else {
            AlmaBurstShape()
                .fill(color)
                .frame(width: size, height: size)
        }
    }
}

// MARK: - Waveform (spring-interpolated level snapshots)

@available(iOS 17.0, *)
private struct VoiceWaveform: View {
    var levels: [Double]
    var tint: Color
    var maxHeight: CGFloat = 24
    var barWidth: CGFloat = 3

    var body: some View {
        HStack(alignment: .center, spacing: barWidth * 0.9) {
            ForEach(levels.indices, id: \.self) { i in
                Capsule()
                    .fill(tint.opacity(0.5 + 0.5 * levels[i]))
                    .frame(width: barWidth,
                           height: max(barWidth, maxHeight * CGFloat(levels[i])))
            }
        }
        .frame(height: maxHeight)
        .animation(.spring(response: 0.55, dampingFraction: 0.75), value: levels)
    }
}

// MARK: - Shared bits

@available(iOS 17.0, *)
private struct EndButton: View {
    var body: some View {
        Button(intent: AlmaVoiceEndIntent()) {
            HStack(spacing: 4) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                Text("শেষ")
                    .font(.system(size: 13, weight: .semibold))
            }
            .foregroundColor(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().fill(Color(red: 0.86, green: 0.27, blue: 0.27).opacity(0.85)))
        }
        .buttonStyle(.plain)
    }
}

@available(iOS 17.0, *)
private struct ElapsedTimer: View {
    let startedAt: Date
    var body: some View {
        Text(startedAt, style: .timer)
            .font(.system(size: 13, weight: .semibold, design: .monospaced))
            .foregroundColor(VoicePalette.textSecondary)
            .monospacedDigit()
            .multilineTextAlignment(.trailing)
            .frame(width: 56)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
    }
}

// MARK: - Lock screen banner (aurora tint card)

@available(iOS 17.0, *)
private struct VoiceLockScreenView: View {
    let context: ActivityViewContext<AlmaVoiceActivityAttributes>

    var body: some View {
        let tint = VoicePalette.tint(context.state.phase)
        HStack(alignment: .center, spacing: 14) {
            BurstIcon(size: 40, boil: true)

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text("ALMA")
                        .font(.system(size: 13, weight: .heavy, design: .rounded))
                        .kerning(2.5)
                        .foregroundColor(VoicePalette.burst)
                    Text(VoicePalette.status(context.state.phase))
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(tint)
                        .lineLimit(1)
                }
                VoiceWaveform(levels: context.state.levels, tint: tint, maxHeight: 18)
                if !context.state.captionTail.isEmpty {
                    Text(context.state.captionTail)
                        .font(.system(size: 12))
                        .foregroundColor(VoicePalette.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 8) {
                ElapsedTimer(startedAt: context.state.startedAt)
                EndButton()
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            ZStack {
                VoicePalette.background
                LinearGradient(
                    colors: [tint.opacity(0.28), .clear, VoicePalette.burst.opacity(0.14)],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                )
                Rectangle().fill(.ultraThinMaterial).opacity(0.22)
            }
        )
        .activityBackgroundTint(VoicePalette.background.opacity(0.9))
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
            let tint = VoicePalette.tint(context.state.phase)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    BurstIcon(size: 30, boil: true)
                        .padding(.leading, 4)
                        .padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ElapsedTimer(startedAt: context.state.startedAt)
                        .padding(.trailing, 4)
                        .padding(.top, 6)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 5) {
                        Text(VoicePalette.status(context.state.phase))
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(tint)
                            .lineLimit(1)
                        VoiceWaveform(levels: context.state.levels, tint: tint, maxHeight: 26)
                    }
                    .frame(maxWidth: .infinity)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack(alignment: .center, spacing: 10) {
                        Text(context.state.captionTail.isEmpty ? "ভয়েস কথোপকথন" : context.state.captionTail)
                            .font(.system(size: 12))
                            .foregroundColor(VoicePalette.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                        Spacer(minLength: 8)
                        EndButton()
                    }
                    .padding(.top, 4)
                }
            } compactLeading: {
                BurstIcon(size: 20)
                    .padding(.leading, 2)
            } compactTrailing: {
                VoiceWaveform(
                    levels: Array(context.state.levels.suffix(5)),
                    tint: tint, maxHeight: 14, barWidth: 2.5
                )
                .padding(.trailing, 2)
            } minimal: {
                BurstIcon(size: 18, color: tint)
            }
            .widgetURL(URL(string: "almaerp://agent"))
            .keylineTint(tint)
        }
    }
}
#endif
