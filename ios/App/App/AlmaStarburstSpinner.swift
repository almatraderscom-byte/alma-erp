//
//  AlmaStarburstSpinner.swift
//  ALMA ERP — 12-ray Claude-style agent loader tuned to the ALMA aurora.
//
//  Owner-approved 2026-07-12:
//  • understanding: one smooth inward intake, then hands off without a jump
//  • thinking/writing: adjacent 2–3-ray clusters retract and reopen
//  • researching/tool: starburst morphs into the 12-dot tool ring
//  • idle: quiet organic rest beside the ALMA wordmark
//  • multi-colour rays use the native AgentAuroraBackground palette
//

import SwiftUI
import UIKit

// MARK: - Shared mode contract

@available(iOS 17.0, *)
enum AlmaStarburstMode: String, CaseIterable, Identifiable {
    case understanding, thinking, researching, searching, writing, idle
    var id: String { rawValue }

    struct Config {
        let periodMs: Double
        let clusterMs: Double
        let boilInterval: TimeInterval
        let toolLike: Bool
    }

    var config: Config {
        switch self {
        case .understanding:
            return .init(periodMs: 6200, clusterMs: .infinity, boilInterval: 0.095, toolLike: false)
        case .thinking:
            return .init(periodMs: 2100, clusterMs: 270, boilInterval: 0.095, toolLike: false)
        case .writing:
            return .init(periodMs: 2200, clusterMs: 290, boilInterval: 0.090, toolLike: false)
        case .researching, .searching:
            return .init(periodMs: 1500, clusterMs: .infinity, boilInterval: 0.095, toolLike: true)
        case .idle:
            return .init(periodMs: .infinity, clusterMs: .infinity, boilInterval: 0.145, toolLike: false)
        }
    }

    static func from(_ raw: String) -> AlmaStarburstMode {
        switch raw {
        case "understanding": return .understanding
        case "researching": return .researching
        case "searching", "tool_search": return .searching
        case "writing": return .writing
        case "idle": return .idle
        default: return .thinking
        }
    }

    var verbs: [String] {
        switch self {
        case .understanding:
            return ["বার্তাটি বুঝে নিচ্ছি", "বুঝে নিচ্ছি"]
        case .thinking:
            return ["ভাবছি", "বিশ্লেষণ করছি", "মিলিয়ে দেখছি", "হিসাব করছি"]
        case .writing:
            return ["উত্তর লিখছি", "সাজাচ্ছি", "গুছিয়ে লিখছি", "শেষ করছি"]
        case .researching:
            return ["গবেষণা করছি", "উৎস দেখছি", "তথ্য আনছি", "যাচাই করছি"]
        case .searching:
            return ["টুল ব্যবহার করছি", "তথ্য আনছি", "যাচাই করছি", "খুঁজে দেখছি"]
        case .idle:
            return ["প্রস্তুত"]
        }
    }

    var verbIntervalMs: UInt64 {
        switch self {
        case .understanding: return 2100
        case .thinking: return 1500
        case .writing: return 1350
        case .researching, .searching: return 1400
        case .idle: return 60_000
        }
    }
}

// MARK: - Palette + organic ray data

@available(iOS 17.0, *)
// Internal (was private): the settled chat wordmark reuses the aura palette so
// idle "ALMA" matches the loader colours (owner ask 2026-07-12).
enum AlmaRayBurst {
    static let outer: [CGFloat] = [43, 38, 45, 40, 46, 39, 44, 37, 45, 40, 47, 38]
    static let widths: [CGFloat] = [7.8, 6.4, 7.3, 6.2, 8, 6.6, 7.5, 6.3, 7.8, 6.5, 7.4, 6.4]
    static let collapsed: [CGFloat] = [15, 13, 16, 14, 15, 13, 16, 14, 15, 13, 16, 14]
    static let clusters = [[0, 1, 2], [3, 4], [5, 6, 7], [8, 9], [10, 11, 0]]
    static let boil: [[Double]] = [
        [0, -0.55, 0.45, -0.25, 0.35, -0.4, 0.2, -0.5, 0.4, -0.2, 0.5, -0.35],
        [0.4, -0.15, 0.05, -0.55, 0.15, -0.05, 0.55, -0.2, 0.1, -0.5, 0.25, -0.1],
        [-0.25, 0.35, -0.4, 0.1, -0.15, 0.5, -0.35, 0.3, -0.5, 0.2, -0.05, 0.45],
        [0.15, -0.4, 0.25, -0.05, 0.5, -0.3, 0.05, -0.45, 0.2, -0.1, 0.4, -0.55],
    ]

    // Same blue → violet → magenta → pink → coral family as AgentAuroraBackground.
    static let colors: [Color] = [
        Color(red: 0.220, green: 0.502, blue: 1.000),
        Color(red: 0.486, green: 0.302, blue: 1.000),
        Color(red: 0.839, green: 0.200, blue: 1.000),
        Color(red: 1.000, green: 0.180, blue: 0.525),
        Color(red: 1.000, green: 0.431, blue: 0.314),
    ]

    static func smoothstep(_ value: Double) -> Double {
        let x = min(1, max(0, value))
        return x * x * (3 - 2 * x)
    }

    static func toolStarAmount(elapsed: Double) -> Double {
        let cycle = elapsed.truncatingRemainder(dividingBy: 1.5) / 1.5
        if cycle < 0.16 { return 1 }
        if cycle < 0.34 { return 1 - smoothstep((cycle - 0.16) / 0.18) }
        if cycle < 0.72 { return 0 }
        if cycle < 0.90 { return smoothstep((cycle - 0.72) / 0.18) }
        return 1
    }

    static func clusterRetraction(index: Int, elapsed: Double, durationMs: Double) -> Double {
        guard durationMs.isFinite else { return 0 }
        let position = elapsed / (durationMs / 1000)
        let clusterIndex = positiveModulo(Int(floor(position)), clusters.count)
        guard let member = clusters[clusterIndex].firstIndex(of: index) else { return 0 }
        let local = position - floor(position)
        let stagger = Double(member) * 0.045
        let adjusted = min(1, max(0, (local - stagger) / (1 - stagger * 1.4)))
        return sin(.pi * smoothstep(adjusted))
    }

    static func understandingRetraction(index: Int, elapsed: Double) -> Double {
        let shifted = min(1, max(0, (elapsed - Double(index % 3) * 0.022) / 2.040))
        if shifted < 0.46 { return smoothstep(shifted / 0.46) }
        return 1 - smoothstep((shifted - 0.46) / 0.54)
    }

    static func positiveModulo(_ value: Int, _ divisor: Int) -> Int {
        ((value % divisor) + divisor) % divisor
    }
}

// MARK: - Animated ALMA wordmark

/// Aura-colour shimmer used only while ALMA is actively working. The moving white
/// highlight keeps the wordmark readable while the surrounding blue/violet/coral
/// colours tie it to the loader instead of looking like plain system text.
@available(iOS 17.0, *)
struct AlmaShimmerWordmark: View {
    var size: CGFloat = 13
    var weight: Font.Weight = .semibold
    var tracking: CGFloat = 2.1

    var body: some View {
        // A static aura wordmark keeps the premium colour identity without
        // creating a second display-link beside the one active loader.
        Text("ALMA")
            .font(.system(size: size, weight: weight))
            .tracking(tracking)
            .foregroundStyle(
                LinearGradient(
                    colors: AlmaRayBurst.colors,
                    startPoint: .leading,
                    endPoint: .trailing))
            .shadow(color: AlmaRayBurst.colors[2].opacity(0.20),
                    radius: max(1.5, size * 0.16))
        .accessibilityLabel("ALMA")
    }
}

// MARK: - Haptics

@available(iOS 17.0, *)
enum AlmaAgentTickHaptic {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let medium = UIImpactFeedbackGenerator(style: .medium)
    private static let soft = UIImpactFeedbackGenerator(style: .soft)

    static func prepare() {
        light.prepare()
        medium.prepare()
        soft.prepare()
    }

    static func modeStart() {
        medium.impactOccurred(intensity: 0.52)
        medium.prepare()
    }

    static func tick(intensity: CGFloat = 0.3) {
        soft.impactOccurred(intensity: intensity)
        soft.prepare()
    }

    static func settleThud() {
        medium.impactOccurred(intensity: 0.65)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) {
            light.impactOccurred(intensity: 0.5)
        }
    }
}

// MARK: - Continuous motion state

@available(iOS 17.0, *)
private final class StarburstAnimState {
    private(set) var rotation: Double = 0
    private(set) var elapsed: Double = 0
    private(set) var boilFrame = 0
    private var velocity: Double = 0
    private var lastTick: TimeInterval?
    private var lastMode: AlmaStarburstMode?

    func tick(mode: AlmaStarburstMode, now: TimeInterval) {
        let dt: Double
        if let lastTick { dt = min(0.05, max(0, now - lastTick)) } else { dt = 1 / 60 }
        self.lastTick = now

        if lastMode != mode {
            lastMode = mode
            elapsed = 0
        } else {
            elapsed += dt
        }

        let targetVelocity = mode.config.periodMs.isFinite
            ? (.pi * 2) / (mode.config.periodMs / 1000)
            : 0
        let blend = 1 - exp(-dt * 4.8)
        velocity += (targetVelocity - velocity) * blend
        rotation = (rotation + velocity * dt).truncatingRemainder(dividingBy: .pi * 2)
        boilFrame = AlmaRayBurst.positiveModulo(
            Int(floor(elapsed / mode.config.boilInterval)),
            AlmaRayBurst.boil.count)
    }

    func draw(ctx: GraphicsContext, size: CGSize, mode: AlmaStarburstMode) {
        let unit = size.width / 100
        let config = mode.config
        let toolAmount = config.toolLike ? AlmaRayBurst.toolStarAmount(elapsed: elapsed) : 1
        let boilRow = AlmaRayBurst.boil[boilFrame]

        var layer = ctx
        layer.translateBy(x: size.width / 2, y: size.height / 2)
        layer.rotate(by: .radians(rotation))
        layer.scaleBy(x: unit, y: unit)

        for index in 0..<12 {
            let boilScale: Double = mode == .idle ? 0.45 : config.toolLike ? 0.28 : 1
            let boilDegrees = boilRow[index] * boilScale
            let angle = Double(index) / 12 * .pi * 2 - .pi / 2 + boilDegrees * .pi / 180
            let transitionSpread = 4 * toolAmount * (1 - toolAmount)
            let rayAmount = config.toolLike
                ? min(1, max(0, toolAmount + sin(Double(index) * 1.71 + elapsed / 0.210) * 0.11 * transitionSpread))
                : 1

            let retract: Double
            if mode == .thinking || mode == .writing {
                retract = AlmaRayBurst.clusterRetraction(
                    index: index, elapsed: elapsed, durationMs: config.clusterMs)
                    * AlmaRayBurst.smoothstep(elapsed / 0.520)
            } else if mode == .understanding {
                retract = AlmaRayBurst.understandingRetraction(index: index, elapsed: elapsed)
            } else {
                retract = 0
            }

            let starInner = 5.5
            let targetOuter = mode == .understanding ? 18 : Double(AlmaRayBurst.collapsed[index])
            let fixedOuter = Double(AlmaRayBurst.outer[index])
            let starOuter = fixedOuter + (targetOuter - fixedOuter) * retract
            let ringRadius = 31.5
            let innerRadius = ringRadius + (starInner - ringRadius) * rayAmount
            let outerRadius = ringRadius + (starOuter - ringRadius) * rayAmount
            let baseWidth = Double(AlmaRayBurst.widths[index])
            let width = baseWidth + (7.2 - baseWidth) * (1 - rayAmount)
            let colorIndex = min(AlmaRayBurst.colors.count - 1,
                                 index * AlmaRayBurst.colors.count / 12)
            let color = AlmaRayBurst.colors[colorIndex]
            let alpha = 0.76 + 0.24 * rayAmount

            let start = CGPoint(x: cos(angle) * innerRadius, y: sin(angle) * innerRadius)
            let end = CGPoint(x: cos(angle) * outerRadius, y: sin(angle) * outerRadius)
            var ray = Path()
            ray.move(to: start)
            ray.addLine(to: end)

            var rayLayer = layer
            rayLayer.addFilter(.shadow(color: color.opacity(0.48), radius: size.width > 40 ? 4 : 1))
            rayLayer.stroke(ray, with: .color(color.opacity(alpha)),
                            style: StrokeStyle(lineWidth: width, lineCap: .round))

            if rayAmount < 0.04 {
                let radius = width / 2
                let center = CGPoint(x: cos(angle) * ringRadius, y: sin(angle) * ringRadius)
                let dot = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius,
                                                 width: radius * 2, height: radius * 2))
                rayLayer.fill(dot, with: .color(color.opacity(alpha)))
            }
        }
    }
}

// MARK: - Shared loaders

@available(iOS 17.0, *)
struct AlmaMiniLoader: View {
    var mode: AlmaStarburstMode = .searching
    var size: CGFloat = 13
    var body: some View { AlmaStarburstLoader(mode: mode, size: size) }
}

@available(iOS 17.0, *)
struct AlmaPageLoader: View {
    var body: some View { Color.clear.frame(height: 1) }
}

@available(iOS 17.0, *)
struct AlmaStarburstLoader: View {
    let mode: AlmaStarburstMode
    var size: CGFloat = 22
    @State private var anim = StarburstAnimState()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var box: CGFloat { (size * 1.48).rounded() }

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            AlmaRayBurst.colors[2].opacity(mode == .idle ? 0.12 : 0.22),
                            AlmaRayBurst.colors[1].opacity(mode == .idle ? 0.07 : 0.13),
                            .clear,
                        ],
                        center: .center,
                        startRadius: 0,
                        endRadius: size * 0.56))
                .frame(width: size * 1.08, height: size * 1.08)
                .blur(radius: max(1.5, size * 0.12))

            // Idle means truly idle: SwiftUI's TimelineView used to run this
            // canvas at 60 FPS even for `.idle`, keeping every visible ALMA
            // footer alive forever. One 24 FPS display link exists only while an
            // explicit loader mode is active and the app is foregrounded.
            TimelineView(.animation(
                minimumInterval: 1 / 24,
                paused: mode == .idle || reduceMotion || scenePhase != .active
            )) { timeline in
                Canvas { ctx, canvasSize in
                    anim.tick(mode: mode, now: timeline.date.timeIntervalSinceReferenceDate)
                    var inner = ctx
                    inner.translateBy(x: (canvasSize.width - size) / 2,
                                      y: (canvasSize.height - size) / 2)
                    anim.draw(ctx: inner, size: CGSize(width: size, height: size), mode: mode)
                }
            }
        }
        .frame(width: box, height: box)
        .shadow(color: AlmaRayBurst.colors[2].opacity(mode == .idle ? 0.12 : 0.22),
                radius: size > 40 ? size * 0.10 : 2)
        .shadow(color: AlmaRayBurst.colors[4].opacity(mode == .idle ? 0.08 : 0.15),
                radius: size > 40 ? size * 0.16 : 2.5)
        .accessibilityLabel(mode.verbs.first ?? "ALMA")
    }
}

@available(iOS 17.0, *)
struct AlmaSpinnerView: View {
    let mode: String
    var size: CGFloat = 18
    var showVerb: Bool = true
    var haptics: Bool = true
    @State private var verbIdx = 0

    private var starburstMode: AlmaStarburstMode { AlmaStarburstMode.from(mode) }

    var body: some View {
        HStack(spacing: 10) {
            AlmaStarburstLoader(mode: starburstMode, size: size)
            if showVerb {
                Text("\(starburstMode.verbs[verbIdx % max(1, starburstMode.verbs.count)])…")
                    .font(.system(size: size * 0.62 + 2, weight: .medium))
                    .foregroundStyle(.secondary)
            }
        }
        .task(id: mode) {
            verbIdx = 0
            var elapsedMs: UInt64 = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
                elapsedMs += 100
                if elapsedMs >= starburstMode.verbIntervalMs {
                    verbIdx += 1
                    elapsedMs = 0
                }
            }
        }
        .task(id: "\(mode)-haptics-\(haptics)") {
            guard haptics, starburstMode != .idle else { return }
            AlmaAgentTickHaptic.prepare()
            AlmaAgentTickHaptic.modeStart()

            switch starburstMode {
            case .understanding:
                // The rays reach their deepest intake at ~46% of the 2.04s gesture.
                try? await Task.sleep(nanoseconds: 940_000_000)
                guard !Task.isCancelled else { return }
                AlmaAgentTickHaptic.tick(intensity: 0.34)

            case .thinking, .writing:
                // Each adjacent ray cluster is maximally retracted halfway through
                // its cycle, so the micro-tick lands on the visible squeeze—not rotation.
                let clusterMs = UInt64(starburstMode.config.clusterMs)
                try? await Task.sleep(nanoseconds: clusterMs * 500_000)
                while !Task.isCancelled {
                    AlmaAgentTickHaptic.tick(
                        intensity: starburstMode == .thinking ? 0.24 : 0.27)
                    try? await Task.sleep(nanoseconds: clusterMs * 1_000_000)
                }

            case .researching, .searching:
                // 1.5s tool morph: ring settles at 34%, star reopens at 90%.
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 510_000_000)
                    guard !Task.isCancelled else { return }
                    AlmaAgentTickHaptic.tick(intensity: 0.32)
                    try? await Task.sleep(nanoseconds: 840_000_000)
                    guard !Task.isCancelled else { return }
                    AlmaAgentTickHaptic.tick(intensity: 0.23)
                    try? await Task.sleep(nanoseconds: 150_000_000)
                }

            case .idle:
                return
            }
        }
    }
}

// MARK: - In-app preview (More → Loader Preview)

#if canImport(Capacitor)
@available(iOS 17.0, *)
struct AlmaSpinnerPreviewScreen: View {
    @State private var mode: AlmaStarburstMode = .idle
    @State private var autoCycle = true
    @State private var flowTask: Task<Void, Never>?
    @Environment(\.colorScheme) private var scheme

    private var ink: Color {
        scheme == .dark ? Color(red: 0.969, green: 0.973, blue: 0.988)
            : Color(red: 0.102, green: 0.102, blue: 0.180)
    }

    var body: some View {
        ZStack {
            AgentAuroraBackground()
            ScrollView {
                VStack(spacing: 24) {
                    HStack(spacing: 12) {
                        AlmaStarburstLoader(mode: mode, size: 118)
                        AlmaShimmerWordmark(size: 24, weight: .bold, tracking: 4.8)
                    }
                    .frame(minHeight: 180)

                    Text(statusLine)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(ink.opacity(0.72))

                    HStack(spacing: 8) {
                        AlmaSpinnerView(mode: mode.rawValue, size: 28,
                                        showVerb: false, haptics: true)
                        AlmaShimmerWordmark(size: 13, weight: .semibold, tracking: 2.2)
                        Text("· \(mode.verbs.first ?? "প্রস্তুত")")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(ink.opacity(0.64))
                        Spacer()
                    }
                    .padding(14)
                    .background(.ultraThinMaterial,
                                in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 8)], spacing: 8) {
                        ForEach(AlmaStarburstMode.allCases) { item in
                            Button(label(for: item)) {
                                flowTask?.cancel()
                                autoCycle = false
                                mode = item
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(mode == item ? AlmaRayBurst.colors.last : Color.secondary.opacity(0.35))
                        }
                    }

                    Button("Run full flow") { runFlow() }
                        .buttonStyle(.borderedProminent)
                        .tint(AlmaRayBurst.colors.last)

                    Toggle("Auto flow", isOn: $autoCycle)
                        .onChange(of: autoCycle) { _, enabled in
                            if enabled { runFlow() } else { flowTask?.cancel() }
                        }
                }
                .padding(20)
            }
        }
        .navigationTitle("Loader Preview")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { runFlow() }
        .onDisappear { flowTask?.cancel() }
    }

    private func runFlow() {
        flowTask?.cancel()
        flowTask = Task { @MainActor in
            mode = .understanding
            try? await Task.sleep(nanoseconds: 2_080_000_000)
            guard !Task.isCancelled else { return }
            mode = .thinking
            try? await Task.sleep(nanoseconds: 3_600_000_000)
            guard !Task.isCancelled else { return }
            mode = .researching
            try? await Task.sleep(nanoseconds: 3_300_000_000)
            guard !Task.isCancelled else { return }
            mode = .writing
            try? await Task.sleep(nanoseconds: 3_200_000_000)
            guard !Task.isCancelled else { return }
            mode = .searching
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            mode = .idle
            if autoCycle {
                try? await Task.sleep(nanoseconds: 1_800_000_000)
                guard !Task.isCancelled else { return }
                runFlow()
            }
        }
    }

    private func label(for mode: AlmaStarburstMode) -> String {
        switch mode {
        case .understanding: return "Understand"
        case .thinking: return "Thinking"
        case .researching: return "Research"
        case .searching: return "Tool"
        case .writing: return "Writing"
        case .idle: return "Idle"
        }
    }

    private var statusLine: String {
        switch mode {
        case .understanding: return "Understanding → smooth handoff"
        case .thinking: return "Thinking · clustered rays · 2.1s/rev"
        case .researching: return "Research · tool ring · 1.5s/rev"
        case .searching: return "Using tool · dot ring · 1.5s/rev"
        case .writing: return "Writing · clustered rays · 2.2s/rev"
        case .idle: return "Idle · ALMA ready"
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("ALMA loader flow") {
    NavigationStack { AlmaSpinnerPreviewScreen() }
}
#endif
#endif
