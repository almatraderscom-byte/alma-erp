//
//  PulseLiveActivity.swift
//  AlmaWidget
//
//  "Business Pulse" Live Activity UI — ONLY compiled into the widget extension
//  target. Renders the lock-screen banner + Dynamic Island for the
//  PulseActivityAttributes activity that the App target drives via ActivityKit.
//
//  Style matches AlmaWidget.swift: background #0c0b12, gold accent #C9A84C.
//  ActivityKit is iOS 16.1+, so the whole configuration is gated behind
//  `@available(iOS 16.1, *)` and `#if canImport(ActivityKit)`.
//
//  NOTE: this type is NOT added to AlmaWidgetBundle here — see
//  AlmaWidget/INTEGRATION.md ("Live Activity additions") for the exact bundle
//  and project.pbxproj wiring the parent session performs.
//

#if canImport(ActivityKit)
import ActivityKit
import WidgetKit
import SwiftUI

// MARK: - Palette (mirrors AlmaWidget.swift)

private enum PulsePalette {
    /// Background #0c0b12
    static let background = Color(red: 0x0c / 255.0, green: 0x0b / 255.0, blue: 0x12 / 255.0)
    /// Gold accent #C9A84C
    static let gold = Color(red: 0xC9 / 255.0, green: 0xA8 / 255.0, blue: 0x4C / 255.0)
    /// Muted tile surface, slightly lifted off the background.
    static let tile = Color(red: 0x1a / 255.0, green: 0x18 / 255.0, blue: 0x24 / 255.0)
    static let textPrimary = Color.white
    static let textSecondary = Color(red: 0.72, green: 0.72, blue: 0.78)
}

// MARK: - Shared pieces

@available(iOS 16.1, *)
private struct GoldATile: View {
    var size: CGFloat = 34

    var body: some View {
        Text("A")
            .font(.system(size: size * 0.6, weight: .heavy, design: .rounded))
            .foregroundColor(PulsePalette.background)
            .frame(width: size, height: size)
            .background(PulsePalette.gold)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
    }
}

@available(iOS 16.1, *)
private func pulseTimeString(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "h:mm a"
    return formatter.string(from: date)
}

/// Bangla (Bengali) digits for the owner-facing numbers — ২৪ not 24.
private func banglaDigits(_ n: Int) -> String {
    let map: [Character: Character] = [
        "0": "০", "1": "১", "2": "২", "3": "৩", "4": "৪",
        "5": "৫", "6": "৬", "7": "৭", "8": "৮", "9": "৯"
    ]
    return String(String(n).map { map[$0] ?? $0 })
}

// MARK: - Hub summary row (approvals + tasks)

/// Compact second row: `অনুমোদন বাকি ২ · কাজ বাকি ১` — only the nonzero parts,
/// with a small gold dot before each part. Renders nothing when both are zero.
@available(iOS 16.1, *)
private struct PulseHubSummaryRow: View {
    let pendingApprovals: Int
    let openTasks: Int

    var body: some View {
        HStack(spacing: 6) {
            if pendingApprovals > 0 {
                part("অনুমোদন বাকি \(banglaDigits(pendingApprovals))")
            }
            if pendingApprovals > 0 && openTasks > 0 {
                Text("·")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(PulsePalette.textSecondary)
            }
            if openTasks > 0 {
                part("কাজ বাকি \(banglaDigits(openTasks))")
            }
        }
    }

    private func part(_ text: String) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(PulsePalette.gold)
                .frame(width: 4, height: 4)
            Text(text)
                .font(.system(size: 11, weight: .regular))
                .foregroundColor(PulsePalette.textSecondary)
                .lineLimit(1)
        }
    }
}

// MARK: - Lock screen banner

@available(iOS 16.1, *)
private struct PulseLockScreenView: View {
    let context: ActivityViewContext<PulseActivityAttributes>

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            GoldATile(size: 44)

            VStack(alignment: .leading, spacing: 3) {
                Text(context.attributes.title)
                    .font(.system(size: 13, weight: .heavy, design: .rounded))
                    .kerning(1.2)
                    .foregroundColor(PulsePalette.gold)
                    .lineLimit(1)
                Text(context.state.statusLine)
                    .font(.system(size: 12, weight: .regular))
                    .foregroundColor(PulsePalette.textSecondary)
                    .lineLimit(2)
                    .minimumScaleFactor(0.85)
                if (context.state.pendingApprovals ?? 0) > 0 || (context.state.openTasks ?? 0) > 0 {
                    PulseHubSummaryRow(
                        pendingApprovals: context.state.pendingApprovals ?? 0,
                        openTasks: context.state.openTasks ?? 0
                    )
                }
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 2) {
                Text(banglaDigits(context.state.ordersToday))
                    .font(.system(size: 30, weight: .heavy, design: .rounded))
                    .foregroundColor(PulsePalette.textPrimary)
                Text(pulseTimeString(context.state.updatedAt))
                    .font(.system(size: 10, weight: .regular))
                    .foregroundColor(PulsePalette.textSecondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PulseGlassBackground())
    }
}

/// Phase N5 — "glass-ready" lock-screen backdrop. On iOS 16.1+ a faint material is
/// layered over the near-black brand background for subtle depth (a step toward
/// Liquid Glass); the flat fill remains the base. Swap the material for
/// `.glassEffect(...)` on the iOS 26 SDK to adopt true Liquid Glass — see
/// ios/App/FEATURES.md. Material keeps this compiling on any modern SDK.
@available(iOS 16.1, *)
private struct PulseGlassBackground: View {
    var body: some View {
        ZStack {
            PulsePalette.background
            Rectangle()
                .fill(.ultraThinMaterial)
                .opacity(0.28)
        }
    }
}

// MARK: - Live Activity configuration

@available(iOS 16.1, *)
struct PulseLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PulseActivityAttributes.self) { context in
            // Lock screen / banner presentation.
            PulseLockScreenView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                // Expanded presentation.
                DynamicIslandExpandedRegion(.leading) {
                    GoldATile(size: 34)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(pulseTimeString(context.state.updatedAt))
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(PulsePalette.textSecondary)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text(banglaDigits(context.state.ordersToday))
                            .font(.system(size: 26, weight: .heavy, design: .rounded))
                            .foregroundColor(PulsePalette.textPrimary)
                        Text(context.state.statusLine)
                            .font(.system(size: 11, weight: .regular))
                            .foregroundColor(PulsePalette.textSecondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if (context.state.pendingApprovals ?? 0) > 0 || (context.state.openTasks ?? 0) > 0 {
                        PulseHubSummaryRow(
                            pendingApprovals: context.state.pendingApprovals ?? 0,
                            openTasks: context.state.openTasks ?? 0
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.top, 2)
                    }
                }
            } compactLeading: {
                Text("A")
                    .font(.system(size: 14, weight: .heavy, design: .rounded))
                    .foregroundColor(PulsePalette.gold)
            } compactTrailing: {
                // Tiny gold dot = approvals waiting (attention hint).
                HStack(spacing: 3) {
                    Text(banglaDigits(context.state.ordersToday))
                        .font(.system(size: 14, weight: .bold, design: .rounded))
                        .foregroundColor(PulsePalette.textPrimary)
                    if (context.state.pendingApprovals ?? 0) > 0 {
                        Circle()
                            .fill(PulsePalette.gold)
                            .frame(width: 5, height: 5)
                    }
                }
            } minimal: {
                Text("A")
                    .font(.system(size: 14, weight: .heavy, design: .rounded))
                    .foregroundColor(PulsePalette.gold)
            }
            .widgetURL(URL(string: "almaerp://agent"))
            .keylineTint(PulsePalette.gold)
        }
    }
}
#endif
