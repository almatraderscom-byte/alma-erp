//
//  PulseLiveActivity.swift
//  AlmaWidget
//
//  "Business Pulse" Dynamic Panel UI — ONLY compiled into the widget extension
//  target. Renders the lock-screen card + Dynamic Island for the
//  PulseActivityAttributes activity that the App target drives via ActivityKit
//  and that the server drives via remote ActivityKit push.
//
//  Design contract (see docs/alma-erp-ios-live-activity-spec.md):
//    §7  lock screen  — header · three metrics · ≤3 priority rows · callout
//    §8  island       — compact stays useful even if expanded never appears
//    §9  colour       — one semantic tint per mode; aura clipped to the card
//    §10 motion       — explains state change only; Reduce Motion honoured
//    §17 a11y         — never colour alone; every icon+count has a Bangla label
//
//  The ALMA card stays on the brand near-black glass (#0c0b12 + gold #C9A84C):
//  that is the shipped, owner-approved identity. What varies per mode is the
//  TINT, and every tint is chosen to clear contrast on that surface in both
//  appearances and under increased contrast.
//
//  ActivityKit is iOS 16.1+, so the whole configuration is gated behind
//  `@available(iOS 16.1, *)` and `#if canImport(ActivityKit)`.
//

#if canImport(ActivityKit)
import ActivityKit
import WidgetKit
import SwiftUI

// MARK: - Palette

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

// MARK: - Theme per mode (spec §9)

@available(iOS 16.1, *)
private enum PulseTheme {
    /// The one semantic tint for a mode. System colours adapt to appearance and
    /// increased contrast automatically; gold is the ALMA brand accent.
    static func tint(for mode: PulseMode) -> Color {
        switch mode {
        case .urgent: return .red
        case .approval: return PulsePalette.gold
        case .orders: return .cyan
        case .working: return .indigo
        case .success: return .green
        case .stale, .offline: return .gray
        case .overview: return .blue
        }
    }

    /// Priority is never communicated by colour alone (spec §17) — every mode
    /// also carries a distinct glyph and a Bangla label.
    static func icon(for mode: PulseMode) -> String {
        switch mode {
        case .urgent: return "exclamationmark.triangle.fill"
        case .approval: return "hand.raised.fill"
        case .orders: return "shippingbox.fill"
        case .working: return "arrow.triangle.2.circlepath"
        case .success: return "checkmark.circle.fill"
        case .stale: return "clock.fill"
        case .offline: return "wifi.slash"
        case .overview: return "chart.bar.fill"
        }
    }

    static func label(for mode: PulseMode) -> String {
        switch mode {
        case .urgent: return "জরুরি"
        case .approval: return "অনুমোদন দরকার"
        case .orders: return "অর্ডার চলছে"
        case .working: return "কাজ চলছে"
        case .success: return "সম্পন্ন"
        case .stale: return "পুরনো তথ্য"
        case .offline: return "অফলাইন"
        case .overview: return "লাইভ"
        }
    }

    static func icon(forItemKind kind: String?) -> String {
        switch kind ?? "" {
        case "approval": return "hand.raised.fill"
        case "orderProgress": return "shippingbox.fill"
        case "pendingTask": return "list.bullet"
        case "stockAlert": return "exclamationmark.triangle.fill"
        case "paymentAlert": return "creditcard.fill"
        case "deliveryAlert": return "box.truck.fill"
        default: return "gearshape.fill"
        }
    }

    static func tint(for severity: PulseSeverity) -> Color {
        switch severity {
        case .urgent: return .red
        case .attention: return PulsePalette.gold
        case .normal: return PulsePalette.textSecondary
        }
    }
}

// MARK: - Small pieces

/// 24 → "২৪". Owner-facing numbers are always Bangla (owner rule).
private func banglaDigits(_ n: Int) -> String {
    let map: [Character: Character] = [
        "0": "০", "1": "১", "2": "২", "3": "৩", "4": "৪",
        "5": "৫", "6": "৬", "7": "৭", "8": "৮", "9": "৯"
    ]
    return String(String(n).map { map[$0] ?? $0 })
}

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
            .accessibilityHidden(true)
    }
}

/// The state accent — a subtle top glow, NOT a neon background (spec §9).
/// Clipped to the card and non-interactive.
@available(iOS 16.1, *)
private struct PulseAura: View {
    let tint: Color

    var body: some View {
        RadialGradient(
            colors: [tint.opacity(0.18), .clear],
            center: .top,
            startRadius: 0,
            endRadius: 180
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// "Glass-ready" lock-screen backdrop: a faint material over the brand
/// near-black, plus the mode aura. Swap the material for `.glassEffect(...)` on
/// the iOS 26 SDK to adopt true Liquid Glass — see ios/App/FEATURES.md.
@available(iOS 16.1, *)
private struct PulseGlassBackground: View {
    let tint: Color

    var body: some View {
        ZStack {
            PulsePalette.background
            Rectangle().fill(.ultraThinMaterial).opacity(0.28)
            PulseAura(tint: tint)
        }
    }
}

// MARK: - Header (spec §7)

@available(iOS 16.1, *)
private struct PulseHeader: View {
    let title: String
    let state: PulseActivityAttributes.ContentState
    let mode: PulseMode

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            GoldATile(size: 42)

            VStack(alignment: .leading, spacing: 2) {
                Text("\(title) · LIVE")
                    .font(.system(size: 10, weight: .heavy, design: .rounded))
                    .kerning(1.1)
                    .foregroundColor(PulsePalette.gold)
                    .lineLimit(1)
                Text(state.displayHeadline)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(PulsePalette.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(state.displaySubtitle)
                    .font(.system(size: 12))
                    .foregroundColor(PulsePalette.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .accessibilityElement(children: .combine)

            Spacer(minLength: 6)

            PulseStatePill(mode: mode)
        }
    }
}

/// The right-side state label. Icon + text, so the state is never colour-only.
@available(iOS 16.1, *)
private struct PulseStatePill: View {
    let mode: PulseMode

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: PulseTheme.icon(for: mode))
                .font(.system(size: 9, weight: .bold))
            Text(PulseTheme.label(for: mode))
                .font(.system(size: 10, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundColor(PulseTheme.tint(for: mode))
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            Capsule().fill(PulseTheme.tint(for: mode).opacity(0.15))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(PulseTheme.label(for: mode))
    }
}

// MARK: - Metrics row (spec §7)

@available(iOS 16.1, *)
private struct PulseMetricsRow: View {
    let state: PulseActivityAttributes.ContentState
    let mode: PulseMode

    var body: some View {
        HStack(spacing: 8) {
            PulseMetric(
                value: state.pendingTasks,
                label: "বাকি কাজ",
                accessibilityText: "\(banglaDigits(state.pendingTasks))টি কাজ বাকি",
                highlighted: mode == .working,
                tint: PulseTheme.tint(for: mode)
            )
            PulseMetric(
                value: state.approvals,
                label: "অনুমোদন",
                accessibilityText: "\(banglaDigits(state.approvals))টি অনুমোদন অপেক্ষায়",
                highlighted: mode == .approval,
                tint: PulseTheme.tint(for: mode)
            )
            PulseMetric(
                value: state.runningOrders,
                label: "চলমান অর্ডার",
                accessibilityText: "\(banglaDigits(state.runningOrders))টি অর্ডার চলছে",
                highlighted: mode == .orders,
                tint: PulseTheme.tint(for: mode)
            )
        }
    }
}

/// One metric block. Only the block belonging to the active mode is tinted —
/// colouring every block would mean colouring nothing (spec §7).
@available(iOS 16.1, *)
private struct PulseMetric: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let value: Int
    let label: String
    let accessibilityText: String
    let highlighted: Bool
    let tint: Color

    var body: some View {
        VStack(spacing: 1) {
            Text(banglaDigits(value))
                .font(.system(size: 19, weight: .semibold, design: .rounded))
                .foregroundColor(highlighted ? tint : PulsePalette.textPrimary)
                .contentTransition(.numericText())
                .animation(reduceMotion ? nil : .snappy(duration: 0.35), value: value)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label)
                .font(.system(size: 9))
                .foregroundColor(PulsePalette.textSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(highlighted ? tint.opacity(0.14) : PulsePalette.tile.opacity(0.7))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }
}

// MARK: - Priority feed (spec §7)

@available(iOS 16.1, *)
private struct PulseFeedRow: View {
    let item: PulseItem
    let focused: Bool

    private var tint: Color { PulseTheme.tint(for: item.level) }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: PulseTheme.icon(forItemKind: item.kind))
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(focused ? tint : PulsePalette.textSecondary)
                .frame(width: 16)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(item.title)
                    .font(.system(size: 12, weight: focused ? .semibold : .regular))
                    .foregroundColor(PulsePalette.textPrimary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if let subtitle = item.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: 10))
                        .foregroundColor(PulsePalette.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
                if let progress = item.clampedProgress {
                    ProgressView(value: progress)
                        .progressViewStyle(.linear)
                        .tint(tint)
                        .frame(height: 2)
                        .padding(.top, 2)
                        .accessibilityHidden(true)
                }
            }

            Spacer(minLength: 4)

            if let value = item.valueText, !value.isEmpty {
                // Money may appear here — iOS redacts it while locked.
                Text(value)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .foregroundColor(focused ? tint : PulsePalette.textSecondary)
                    .lineLimit(1)
                    .privacySensitive()
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(focused ? tint.opacity(0.12) : PulsePalette.tile.opacity(0.5))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    /// VoiceOver reads severity as a word, never as a colour (spec §17).
    private var accessibilityLabel: String {
        var parts: [String] = []
        switch item.level {
        case .urgent: parts.append("জরুরি")
        case .attention: parts.append("অনুমোদন দরকার")
        case .normal: break
        }
        parts.append(item.title)
        if let s = item.subtitle, !s.isEmpty { parts.append(s) }
        if let v = item.valueText, !v.isEmpty { parts.append(v) }
        if let p = item.clampedProgress { parts.append("\(banglaDigits(Int(p * 100))) শতাংশ") }
        return parts.joined(separator: ", ")
    }
}

// MARK: - Bottom callout (spec §7)

/// A premium, system-like callout for approval / urgent / success. One icon,
/// one headline, one supporting line, no oversized CTA — and nothing that fakes
/// a notification outside the ActivityKit boundary.
@available(iOS 16.1, *)
private struct PulseCallout: View {
    let icon: String
    let title: String
    let detail: String
    let tint: Color
    /// Set for money — redacted while the phone is locked.
    var sensitiveValue: String?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(tint)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(PulsePalette.textPrimary)
                    .lineLimit(1)
                Text(detail)
                    .font(.system(size: 10))
                    .foregroundColor(PulsePalette.textSecondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            if let value = sensitiveValue, !value.isEmpty {
                Text(value)
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .foregroundColor(tint)
                    .lineLimit(1)
                    .privacySensitive()
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .fill(.ultraThinMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(tint.opacity(0.35), lineWidth: 0.5)
        )
        .accessibilityElement(children: .combine)
    }
}

@available(iOS 16.1, *)
private func callout(for state: PulseActivityAttributes.ContentState, mode: PulseMode) -> PulseCallout? {
    switch mode {
    case .urgent:
        guard let title = state.alertTitle else { return nil }
        return PulseCallout(
            icon: "exclamationmark.triangle.fill",
            title: title,
            detail: state.alertDetail ?? "",
            tint: .red
        )
    case .approval:
        guard let title = state.approvalTitle else { return nil }
        return PulseCallout(
            icon: "hand.raised.fill",
            title: title,
            detail: state.approvalCounterparty ?? "",
            tint: PulsePalette.gold,
            sensitiveValue: state.approvalAmountText
        )
    case .success:
        guard let title = state.successTitle else { return nil }
        return PulseCallout(
            icon: "checkmark.circle.fill",
            title: title,
            detail: state.successDetail ?? "",
            tint: .green
        )
    default:
        return nil
    }
}

// MARK: - Lock screen

/// The mode to actually render: stale always wins, because we never present
/// stale counts as current (spec §2 rule 9).
///
/// `context.isStale` is iOS 16.2+, and the app's deployment target is 16.0 — so
/// on 16.1 we fall back to comparing the server's own `staleAfter` against the
/// clock. That fallback is best-effort: without ActivityKit's staleDate the
/// system won't re-render the widget at the moment it expires, so the panel
/// turns stale on its next update rather than exactly on time. On 16.2+ both
/// agree, and the check also covers a state written without a staleDate.
@available(iOS 16.1, *)
private func resolvedMode(_ context: ActivityViewContext<PulseActivityAttributes>) -> PulseMode {
    if #available(iOS 16.2, *), context.isStale { return .stale }
    if let staleAfter = context.state.staleAfterDate, Date() > staleAfter { return .stale }
    return context.state.activeMode
}

/// The lock-screen card.
///
/// Takes a plain `(title, state, mode)` rather than an `ActivityViewContext` on
/// purpose: `ActivityViewContext` has no public initialiser, so a context-bound
/// view can only ever be rendered by a live activity on a real device. Plain
/// inputs make every state renderable offscreen, which is what lets
/// `ios/App/AlmaWidget/__snapshots__` exist at all (spec §20 snapshot tests).
/// `resolvedMode(context)` is applied by the ActivityConfiguration above it.
@available(iOS 16.1, *)
struct PulseLockScreenView: View {
    let title: String
    let state: PulseActivityAttributes.ContentState
    let mode: PulseMode

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PulseHeader(title: title, state: state, mode: mode)

            PulseMetricsRow(state: state, mode: mode)

            let items = state.feedItems
            if !items.isEmpty {
                VStack(spacing: 4) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        PulseFeedRow(item: item, focused: index == 0)
                    }
                }
            }

            if let callout = callout(for: state, mode: mode) {
                callout
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PulseGlassBackground(tint: PulseTheme.tint(for: mode)))
    }
}

// MARK: - Dynamic Island

/// Compact trailing: ONE primary value plus a state dot — never three
/// competing metrics (spec §3.2/§8).
@available(iOS 16.1, *)
private struct PulseCompactPriority: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let state: PulseActivityAttributes.ContentState
    let mode: PulseMode

    var body: some View {
        HStack(spacing: 3) {
            Text(banglaDigits(state.compactValue))
                .font(.system(size: 14, weight: .bold, design: .rounded))
                .foregroundColor(PulsePalette.textPrimary)
                .contentTransition(.numericText())
                .animation(reduceMotion ? nil : .snappy(duration: 0.35), value: state.compactValue)
            if mode == .approval || mode == .urgent {
                Circle()
                    .fill(PulseTheme.tint(for: mode))
                    .frame(width: 5, height: 5)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(PulseTheme.label(for: mode)), \(banglaDigits(state.compactValue))")
    }
}

@available(iOS 16.1, *)
private struct PulseExpandedStatus: View {
    let state: PulseActivityAttributes.ContentState
    let mode: PulseMode

    var body: some View {
        if let item = state.feedItems.first {
            HStack(spacing: 6) {
                Image(systemName: PulseTheme.icon(forItemKind: item.kind))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(PulseTheme.tint(for: item.level))
                    .accessibilityHidden(true)
                Text(item.subtitle ?? item.title)
                    .font(.system(size: 11))
                    .foregroundColor(PulsePalette.textSecondary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let progress = item.clampedProgress {
                    ProgressView(value: progress)
                        .progressViewStyle(.linear)
                        .tint(PulseTheme.tint(for: mode))
                        .frame(width: 64, height: 2)
                        .accessibilityHidden(true)
                }
            }
            .padding(.top, 2)
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: - Live Activity configuration

@available(iOS 16.1, *)
struct PulseLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PulseActivityAttributes.self) { context in
            PulseLockScreenView(
                title: context.attributes.title,
                state: context.state,
                mode: resolvedMode(context)
            )
        } dynamicIsland: { context in
            let mode = resolvedMode(context)
            let tint = PulseTheme.tint(for: mode)

            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 5) {
                        Image(systemName: PulseTheme.icon(for: mode))
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(tint)
                        GoldATile(size: 22)
                    }
                    .accessibilityLabel(PulseTheme.label(for: mode))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    // The single most important value — an amount when there is
                    // one, otherwise the priority count.
                    Group {
                        if let amount = context.state.approvalAmountText, mode == .approval {
                            Text(amount)
                                .font(.system(size: 13, weight: .bold, design: .rounded))
                                .foregroundColor(tint)
                                .privacySensitive()
                        } else {
                            Text(banglaDigits(context.state.compactValue))
                                .font(.system(size: 15, weight: .heavy, design: .rounded))
                                .foregroundColor(PulsePalette.textPrimary)
                                .contentTransition(.numericText())
                        }
                    }
                    .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.displayHeadline)
                            .font(.caption.weight(.semibold))
                            .foregroundColor(PulsePalette.textPrimary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        Text(context.state.displaySubtitle)
                            .font(.caption2)
                            .foregroundColor(PulsePalette.textSecondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityElement(children: .combine)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    PulseExpandedStatus(state: context.state, mode: mode)
                }
            } compactLeading: {
                Image(systemName: PulseTheme.icon(for: mode))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(tint)
                    .accessibilityLabel(PulseTheme.label(for: mode))
            } compactTrailing: {
                PulseCompactPriority(state: context.state, mode: mode)
            } minimal: {
                Image(systemName: PulseTheme.icon(for: mode))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(tint)
                    .accessibilityLabel(PulseTheme.label(for: mode))
            }
            .widgetURL(deepLink(for: context.state, mode: mode))
            .keylineTint(tint)
        }
    }

    /// Every event resolves to a precise destination (spec §16): the focused
    /// row's own link, else the agent hub.
    private func deepLink(for state: PulseActivityAttributes.ContentState, mode: PulseMode) -> URL? {
        if let link = state.feedItems.first?.link, let url = URL(string: link) { return url }
        return URL(string: "almaerp://agent")
    }
}
#endif
