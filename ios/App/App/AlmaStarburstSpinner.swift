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
            // 1600 (was 2100): the owner wants the understanding→thinking cut to
            // feel like a walker breaking into a run — the ~4x jump from the
            // 6.2s/rev intake makes the speed change unmistakable.
            return .init(periodMs: 1600, clusterMs: 270, boilInterval: 0.095, toolLike: false)
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

// MARK: - Loader style preference

@available(iOS 17.0, *)
enum AlmaLoaderStyle: String, CaseIterable, Identifiable {
    case starburst
    case robotPet

    static let defaultsKey = "alma.agent.loader.style"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .starburst: return "বর্তমান Starburst"
        case .robotPet: return "Robot Pet"
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let period: Double = 1.8

    var body: some View {
        Text("ALMA")
            .font(.system(size: size, weight: weight))
            .tracking(tracking)
            .foregroundStyle(
                LinearGradient(
                    colors: AlmaRayBurst.colors,
                    startPoint: .leading,
                    endPoint: .trailing))
            .overlay {
                if !reduceMotion {
                    GeometryReader { g in
                        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                            let phase = context.date.timeIntervalSinceReferenceDate
                                .truncatingRemainder(dividingBy: Self.period) / Self.period
                            let band = max(36, g.size.width * 0.48)
                            let travel = g.size.width + band * 2
                            LinearGradient(
                                colors: [.clear, .white.opacity(0.95), .clear],
                                startPoint: .leading,
                                endPoint: .trailing)
                                .frame(width: band)
                                .offset(x: -band + travel * phase)
                        }
                    }
                    .mask(
                        Text("ALMA")
                            .font(.system(size: size, weight: weight))
                            .tracking(tracking)
                    )
                    .allowsHitTesting(false)
                }
            }
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

    /// Owner-initiated sends should feel immediate even after a long idle period.
    static func ownerSend() {
        medium.prepare()
        medium.impactOccurred(intensity: 0.72)
        medium.prepare()
    }

    static func turnCompleted() {
        settleThud()
    }

    static func settleThud() {
        medium.prepare()
        light.prepare()
        medium.impactOccurred(intensity: 0.65)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) {
            light.impactOccurred(intensity: 0.5)
            light.prepare()
        }
    }
}

// MARK: - Continuous motion state

@available(iOS 17.0, *)
private final class StarburstAnimState {
    private(set) var rotation: Double = 0
    private(set) var elapsed: Double = 0
    private(set) var boilFrame = 0
    /// Shown scale — chases the per-mode target (see tick), easing every
    /// mode change instead of cutting. Starts small so a first appearance
    /// blooms in rather than popping.
    private(set) var grow: Double = 0.34
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

        // Scale target: understanding breathes small→big→small (cosine from the
        // trough, so every entry starts small); every other mode is full size.
        // The SHOWN scale chases the target exactly like velocity does — that
        // one ease IS the mode-change fade (owner ask 2026-07-16: no hard cut),
        // and in-mode it tracks the slow breath imperceptibly closely.
        let growTarget: Double
        if mode == .understanding {
            let breathe = 0.5 - 0.5 * cos((elapsed / 2.4) * .pi * 2)
            growTarget = 0.34 + 0.66 * breathe
        } else {
            growTarget = 1
        }
        grow += (growTarget - grow) * (1 - exp(-dt * 8.5))

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
        layer.scaleBy(x: unit * grow, y: unit * grow)

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
            } else {
                // Understanding no longer retracts rays — the whole-star bloom
                // (grow-in above) IS the intake gesture now; retracting while
                // tiny read as noise.
                retract = 0
            }

            let starInner = 5.5
            let targetOuter = Double(AlmaRayBurst.collapsed[index])
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
    var body: some View { AlmaLoaderArtwork(mode: mode, size: size) }
}

@available(iOS 17.0, *)
struct AlmaPageLoader: View {
    var body: some View { Color.clear.frame(height: 1) }
}

// MARK: - Robot Pet loader

@available(iOS 17.0, *)
private struct AlmaRobotPetConfig {
    let row: Int
    let columns: [Int]
    let durations: [TimeInterval]

    var totalDuration: TimeInterval {
        max(0.001, durations.reduce(0, +))
    }

    func column(at elapsed: TimeInterval) -> Int {
        guard !columns.isEmpty, columns.count == durations.count else { return 0 }
        var cursor = elapsed.truncatingRemainder(dividingBy: totalDuration)
        for (index, duration) in durations.enumerated() {
            if cursor < duration { return columns[index] }
            cursor -= duration
        }
        return columns.last ?? 0
    }
}

@available(iOS 17.0, *)
private extension AlmaStarburstMode {
    var robotPetConfig: AlmaRobotPetConfig {
        switch self {
        case .understanding:
            return .init(
                row: 3,
                columns: [0, 1, 2, 3, 2, 1],
                durations: [0.43, 0.17, 0.19, 0.31, 0.18, 0.22])
        case .thinking:
            return .init(
                row: 6,
                columns: [0, 1, 2, 3, 4, 5],
                durations: [0.64, 0.42, 0.52, 0.52, 0.44, 0.60])
        case .researching:
            return .init(
                row: 7,
                columns: [0, 1, 2, 3, 4, 5],
                durations: [0.58, 0.52, 0.64, 0.52, 0.58, 0.68])
        case .searching:
            return .init(
                row: 9,
                columns: [0, 1, 2, 3, 4, 5, 6, 7],
                durations: [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.19])
        case .writing:
            // Owner-approved: keep the original laptop frames untouched; only
            // play the baked hand movement faster and add a slightly stronger bob.
            return .init(
                row: 7,
                columns: [0, 1, 2, 3, 4, 5],
                durations: [0.105, 0.095, 0.105, 0.095, 0.105, 0.120])
        case .idle:
            return .init(
                row: 8,
                columns: [0, 1, 2, 3, 4, 5],
                durations: [0.72, 0.42, 0.52, 0.62, 0.52, 0.76])
        }
    }
}

@available(iOS 17.0, *)
private enum AlmaRobotPetFrameStore {
    private static let sheetColumns = 8
    private static let sheetRows = 11
    private static let requiredFrames: [(row: Int, columns: Range<Int>)] = [
        (3, 0..<4),
        (6, 0..<6),
        (7, 0..<6),
        (8, 0..<6),
        (9, 0..<8),
    ]

    // Crop the source sheet once. Timeline updates then draw only a 192×208
    // frame instead of resizing the full 1536×2288 texture on every tick.
    static let frames: [Int: UIImage] = {
        guard let source = UIImage(named: "AlmaRobotPetSprite")?.cgImage else { return [:] }
        let frameWidth = source.width / sheetColumns
        let frameHeight = source.height / sheetRows
        var result: [Int: UIImage] = [:]

        for required in requiredFrames {
            for column in required.columns {
                let rect = CGRect(
                    x: CGFloat(column * frameWidth),
                    y: CGFloat(required.row * frameHeight),
                    width: CGFloat(frameWidth),
                    height: CGFloat(frameHeight))
                guard let crop = source.cropping(to: rect) else { continue }
                result[required.row * sheetColumns + column] = UIImage(cgImage: crop)
            }
        }
        return result
    }()

    static func image(row: Int, column: Int) -> UIImage? {
        frames[row * sheetColumns + column]
    }
}

@available(iOS 17.0, *)
private struct AlmaRobotPetSpriteFrame: View {
    let row: Int
    let column: Int
    let width: CGFloat

    private var height: CGFloat { width * 208 / 192 }

    @ViewBuilder
    var body: some View {
        if let frame = AlmaRobotPetFrameStore.image(row: row, column: column) {
            Image(uiImage: frame)
                .resizable()
                .interpolation(.high)
                .frame(width: width, height: height)
        } else {
            Color.clear.frame(width: width, height: height)
        }
    }
}

@available(iOS 17.0, *)
private struct AlmaRobotPetLoader: View {
    let mode: AlmaStarburstMode
    var size: CGFloat = 22
    var animated = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var modeStartedAt = Date()

    private var spriteWidth: CGFloat { size * 1.35 }
    private var boxWidth: CGFloat { size * 2.05 }
    private var boxHeight: CGFloat { size * 1.72 }

    var body: some View {
        let playbackPaused = reduceMotion || !animated
        TimelineView(.animation(minimumInterval: 1 / 30, paused: playbackPaused)) { timeline in
            let elapsed = playbackPaused
                ? 0
                : max(0, timeline.date.timeIntervalSince(modeStartedAt))
            let config = mode.robotPetConfig
            let motion = bodyMotion(elapsed: elapsed)

            ZStack {
                Ellipse()
                    .fill(Color.primary.opacity(mode == .idle ? 0.10 : 0.16))
                    .frame(width: spriteWidth * 0.54, height: max(2, spriteWidth * 0.065))
                    .blur(radius: max(1, size * 0.045))
                    .scaleEffect(x: 1 - abs(motion.y) / max(1, size) * 2.4)
                    .offset(y: size * 0.64)

                AlmaRobotPetSpriteFrame(
                    row: config.row,
                    column: config.column(at: reduceMotion ? 0 : elapsed),
                    width: spriteWidth)
                    .offset(x: motion.x, y: motion.y)
                    .rotationEffect(.degrees(motion.rotation))
                    .shadow(
                        color: AlmaRayBurst.colors[1].opacity(mode == .idle ? 0.15 : 0.28),
                        radius: size > 40 ? size * 0.08 : 2,
                        y: size > 40 ? size * 0.04 : 1)

                if size >= 20 {
                    modeDecoration(elapsed: reduceMotion ? 0 : elapsed)
                }
            }
            .frame(width: boxWidth, height: boxHeight)
        }
        .onChange(of: mode) { _, _ in modeStartedAt = Date() }
        .accessibilityLabel(mode.verbs.first ?? "ALMA")
    }

    private func bodyMotion(elapsed: TimeInterval)
        -> (x: CGFloat, y: CGFloat, rotation: Double) {
        guard !reduceMotion else { return (0, 0, 0) }

        let period: Double
        let xAmount: CGFloat
        let yAmount: CGFloat
        let rotation: Double
        switch mode {
        case .understanding:
            period = 1.75; xAmount = size * 0.075; yAmount = size * 0.055; rotation = 3.2
        case .thinking:
            period = 2.55; xAmount = size * 0.035; yAmount = size * 0.075; rotation = 2.6
        case .researching:
            period = 2.20; xAmount = size * 0.018; yAmount = size * 0.026; rotation = 0.7
        case .searching:
            period = 0.90; xAmount = size * 0.055; yAmount = size * 0.032; rotation = 1.8
        case .writing:
            period = 0.44; xAmount = size * 0.040; yAmount = size * 0.038; rotation = 0.8
        case .idle:
            period = 1.20; xAmount = size * 0.010; yAmount = size * 0.060; rotation = 0.5
        }

        let wave = sin(elapsed / period * .pi * 2)
        let lift = -abs(sin(elapsed / period * .pi))
        return (
            x: CGFloat(wave) * xAmount,
            y: CGFloat(lift) * yAmount,
            rotation: wave * rotation)
    }

    @ViewBuilder
    private func modeDecoration(elapsed: TimeInterval) -> some View {
        switch mode {
        case .understanding:
            ZStack {
                Capsule()
                    .fill(.ultraThinMaterial)
                    .overlay(Capsule().strokeBorder(Color.primary.opacity(0.13), lineWidth: 0.8))
                HStack(spacing: max(1.5, size * 0.055)) {
                    ForEach(0..<3, id: \.self) { index in
                        Circle()
                            .fill(AlmaRayBurst.colors[4])
                            .frame(width: max(2.2, size * 0.085),
                                   height: max(2.2, size * 0.085))
                            .offset(y: -sin(elapsed * 7 + Double(index) * 0.8) * size * 0.035)
                    }
                }
            }
            .frame(width: size * 0.72, height: size * 0.40)
            .scaleEffect(0.96 + sin(elapsed * 4.2) * 0.045)
            .offset(x: -size * 0.67, y: -size * 0.52)

        case .thinking:
            ZStack {
                Capsule()
                    .fill(.ultraThinMaterial)
                    .overlay(Capsule().strokeBorder(Color.primary.opacity(0.13), lineWidth: 0.8))
                HStack(spacing: max(1.5, size * 0.055)) {
                    ForEach(0..<3, id: \.self) { index in
                        Circle()
                            .fill(AlmaRayBurst.colors[2])
                            .frame(width: max(2.2, size * 0.085),
                                   height: max(2.2, size * 0.085))
                            .scaleEffect(0.72 + 0.28 * sin(elapsed * 5 + Double(index) * 0.8))
                    }
                }
                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: size * 0.13, height: size * 0.13)
                    .offset(x: -size * 0.25, y: size * 0.27)
                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: size * 0.075, height: size * 0.075)
                    .offset(x: -size * 0.34, y: size * 0.37)
            }
            .frame(width: size * 0.76, height: size * 0.43)
            .scaleEffect(0.95 + sin(elapsed * 3.1) * 0.05)
            .offset(x: size * 0.66, y: -size * 0.55)

        case .researching:
            ZStack(alignment: .top) {
                RoundedRectangle(cornerRadius: max(3, size * 0.11), style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay(
                        RoundedRectangle(cornerRadius: max(3, size * 0.11), style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.13), lineWidth: 0.8))
                VStack(spacing: max(2, size * 0.055)) {
                    ForEach(0..<3, id: \.self) { _ in
                        Capsule()
                            .fill(Color.secondary.opacity(0.68))
                            .frame(width: size * 0.34, height: max(1.5, size * 0.035))
                    }
                }
                .padding(.top, size * 0.13)
                Capsule()
                    .fill(AlmaRayBurst.colors[0].opacity(0.58))
                    .frame(width: size * 0.42, height: max(2, size * 0.07))
                    .offset(y: size * (0.12 + 0.28 * (0.5 + 0.5 * sin(elapsed * 3.8))))
            }
            .frame(width: size * 0.58, height: size * 0.70)
            .offset(x: size * 0.69, y: -size * 0.48)

        case .searching:
            ZStack {
                Circle()
                    .stroke(
                        AlmaRayBurst.colors[0].opacity(0.72),
                        style: StrokeStyle(
                            lineWidth: max(1.2, size * 0.045),
                            lineCap: .round,
                            dash: [size * 0.10, size * 0.18]))
                    .rotationEffect(.degrees(elapsed * 150))
                Image(systemName: "magnifyingglass")
                    .font(.system(size: size * 0.34, weight: .semibold))
                    .foregroundStyle(AlmaRayBurst.colors[0])
                    .offset(x: size * 0.44, y: -size * 0.39)
            }
            .frame(width: size * 1.30, height: size * 1.30)

        case .writing:
            // The approved laptop artwork already contains the complete typing
            // scene. Never draw a second laptop, keyboard, or synthetic arms here.
            EmptyView()

        case .idle:
            Image(systemName: "sparkles")
                .font(.system(size: size * 0.30, weight: .medium))
                .foregroundStyle(AlmaRayBurst.colors[4])
                .opacity(0.55 + 0.35 * sin(elapsed * 4.2))
                .offset(x: size * 0.65, y: -size * 0.42)
        }
    }
}

@available(iOS 17.0, *)
struct AlmaLoaderArtwork: View {
    let mode: AlmaStarburstMode
    var size: CGFloat = 22
    var animated = true

    @AppStorage(AlmaLoaderStyle.defaultsKey)
    private var loaderStyleRaw = AlmaLoaderStyle.starburst.rawValue

    private var style: AlmaLoaderStyle {
        AlmaLoaderStyle(rawValue: loaderStyleRaw) ?? .starburst
    }

    @ViewBuilder
    var body: some View {
        switch style {
        case .starburst:
            AlmaStarburstLoader(mode: mode, size: size)
        case .robotPet:
            AlmaRobotPetLoader(mode: mode, size: size, animated: animated)
        }
    }
}

@available(iOS 17.0, *)
struct AlmaStarburstLoader: View {
    let mode: AlmaStarburstMode
    var size: CGFloat = 22
    @State private var anim = StarburstAnimState()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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

            // Build-73 behavior restored (owner-verified static loader 2026-07-16):
            // NEVER pause this schedule on mode — a `paused:` flip is exactly the
            // SwiftUI path that fails to re-arm after backgrounding/mode churn in
            // this UIKit-hosted chat, which froze the active starburst while the
            // neighbouring pause-less shimmer kept moving. Idle stillness comes
            // from the physics (target velocity 0), like the shipped build 73 —
            // an idle canvas redraws an identical frame at trivial cost. The only
            // legitimate pause input is Reduce Motion.
            TimelineView(.animation(
                minimumInterval: 1 / 30,
                paused: reduceMotion
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
        // The aura circle + glow opacities are SwiftUI-side `mode` reads — fade
        // them with the same feel as the canvas's own scale ease, so a mode
        // change never hard-cuts any layer (owner ask 2026-07-16).
        .animation(.easeInOut(duration: 0.35), value: mode)
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
            AlmaLoaderArtwork(mode: starburstMode, size: size)
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
    @AppStorage(AlmaLoaderStyle.defaultsKey)
    private var loaderStyleRaw = AlmaLoaderStyle.starburst.rawValue
    @Environment(\.colorScheme) private var scheme

    private var ink: Color {
        scheme == .dark ? Color(red: 0.969, green: 0.973, blue: 0.988)
            : Color(red: 0.102, green: 0.102, blue: 0.180)
    }

    private var loaderStyle: AlmaLoaderStyle {
        AlmaLoaderStyle(rawValue: loaderStyleRaw) ?? .starburst
    }

    var body: some View {
        ZStack {
            AgentAuroraBackground()
            ScrollView {
                VStack(spacing: 24) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Agent loader")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(ink.opacity(0.72))
                        HStack(spacing: 4) {
                            ForEach(AlmaLoaderStyle.allCases) { style in
                                Button {
                                    loaderStyleRaw = style.rawValue
                                } label: {
                                    Text(style.label)
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(
                                            loaderStyleRaw == style.rawValue
                                                ? ink
                                                : ink.opacity(0.62)
                                        )
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 8)
                                        .background {
                                            if loaderStyleRaw == style.rawValue {
                                                RoundedRectangle(cornerRadius: 9, style: .continuous)
                                                    .fill(.ultraThinMaterial)
                                                    .shadow(color: .black.opacity(0.10),
                                                            radius: 3, y: 1)
                                            }
                                        }
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(style.label)
                                .accessibilityValue(
                                    loaderStyleRaw == style.rawValue ? "Selected" : ""
                                )
                            }
                        }
                        .padding(3)
                        .background(
                            ink.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                        )
                    }
                    .padding(14)
                    .background(.ultraThinMaterial,
                                in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                    HStack(spacing: 12) {
                        AlmaLoaderArtwork(mode: mode, size: 118)
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
        .navigationTitle("Agent Loader")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: loaderStyleRaw) { _, _ in
            UISelectionFeedbackGenerator().selectionChanged()
        }
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
        if loaderStyle == .robotPet {
            switch mode {
            case .understanding: return "Understanding · playful handoff"
            case .thinking: return "Thinking · animated thought bubble"
            case .researching: return "Research · calm reading + page scan"
            case .searching: return "Using tool · quick search orbit"
            case .writing: return "Writing · fast original laptop typing"
            case .idle: return "Idle · cheerful ALMA ready"
            }
        }

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
