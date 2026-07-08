//
//  AlmaStarburstSpinner.swift
//  ALMA ERP — Claude official organic starburst loader (#d97757).
//
//  LOCKED SPEC: docs/agent-native-ui-LOCKED-SPEC.md §2 + §5 (owner, 2026-07-07)
//  • TWO LAYERS, never mixed:
//    - OUTER rotation: time-based, buttery 60fps linear —
//      thinking 4s/rev · writing 2.5s/rev · searching(dot ring) 1.5s/rev · idle none
//    - INNER line boil: 4 distinct vertex-jittered path variants @ ~11fps steps
//      (hand-drawn stop-motion), zero-mean noise, displacement ≤3 units /100
//  • Haptics: one soft tick per revolution (speed up ⇒ ticks speed up), medium on mode start.
//  Live HTML reference: docs/agent-claude-composition-FINAL-LOCKED.html
//

import SwiftUI
import UIKit

// MARK: - Organic burst path segments (viewBox 0…100)

@available(iOS 17.0, *)
enum AlmaOrganicBurst {
    /// Homogeneous data (op chars + point rows) — keeps the type-checker fast.
    static let ops: [Character] = Array("MLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLCLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLZ")
    static let pts: [[CGFloat]] = [
        [19.60, 66.50], [39.30, 55.50], [39.60, 54.50], [39.30, 54.00], [38.30, 54.00], [35.00, 53.80],
        [23.80, 53.50], [14.00, 53.00], [4.50, 52.50], [2.10, 52.00], [0.00, 49.00], [0.20, 47.50],
        [2.20, 46.20], [5.10, 46.40], [11.40, 46.90], [20.90, 47.50], [27.80, 47.90], [38.00, 49.10],
        [39.60, 49.10], [39.80, 48.40], [39.30, 48.00], [38.90, 47.60], [29.00, 41.00], [18.40, 34.00],
        [12.80, 29.90], [9.80, 27.90], [8.30, 25.90], [7.70, 21.70], [10.40, 18.70], [14.10, 19.00],
        [15.00, 19.20], [18.70, 22.10], [26.70, 28.20], [37.00, 36.00], [38.50, 37.20], [39.10, 36.80],
        [39.20, 36.50], [38.50, 35.40], [33.00, 25.00], [27.00, 14.60], [24.30, 10.30], [23.60, 7.70],
        [23.30, 6.70, 23.20, 5.70, 23.20, 4.70], [26.20, 0.50], [28.00, 0.00], [32.20, 0.60], [33.80, 2.00], [36.40, 8.00],
        [40.50, 17.30], [47.00, 29.90], [49.00, 33.70], [50.00, 37.10], [50.30, 38.10], [51.00, 38.10],
        [51.00, 37.60], [51.50, 30.40], [52.50, 21.70], [53.50, 10.50], [53.80, 7.30], [55.40, 3.50],
        [58.40, 1.50], [61.00, 2.60], [63.00, 5.50], [62.70, 7.30], [61.60, 15.00], [59.00, 27.10],
        [57.50, 35.30], [58.40, 35.30], [59.40, 34.20], [63.50, 28.80], [70.40, 20.20], [73.40, 16.70],
        [77.00, 13.00], [79.30, 11.20], [83.60, 11.20], [86.70, 15.90], [85.30, 20.80], [80.90, 26.40],
        [77.20, 31.10], [71.90, 38.20], [68.70, 43.90], [69.00, 44.30], [69.70, 44.30], [81.70, 41.70],
        [88.10, 40.60], [95.70, 39.30], [99.20, 40.90], [99.60, 42.50], [98.20, 45.90], [90.00, 47.90],
        [80.40, 49.90], [66.10, 53.20], [65.90, 53.30], [66.10, 53.60], [72.50, 54.20], [75.30, 54.40],
        [82.10, 54.40], [94.70, 55.40], [98.00, 57.40], [99.90, 60.10], [99.60, 62.10], [94.50, 64.70],
        [87.70, 63.10], [71.70, 59.30], [66.30, 58.00], [65.50, 58.00], [65.50, 58.40], [70.10, 62.90],
        [78.40, 70.40], [89.00, 80.10], [89.50, 82.50], [88.20, 84.50], [86.80, 84.30], [77.60, 77.30],
        [74.00, 74.30], [66.00, 67.50], [65.50, 67.50], [65.50, 68.20], [67.30, 70.90], [77.10, 85.60],
        [77.60, 90.10], [76.90, 91.50], [74.30, 92.50], [71.60, 91.90], [65.80, 83.90], [59.80, 74.90],
        [55.10, 66.70], [54.60, 67.10], [51.70, 97.30], [50.40, 98.80], [47.40, 100.00], [44.90, 98.00],
        [43.50, 95.00], [44.90, 88.80], [46.50, 80.80], [47.80, 74.40], [49.00, 66.50], [49.70, 63.90],
        [49.70, 63.70], [49.00, 63.70], [43.00, 72.00], [34.00, 84.30], [26.80, 91.90], [25.10, 92.60],
        [22.10, 91.10], [22.40, 88.30], [24.00, 86.00], [34.00, 73.20], [40.00, 65.30], [44.00, 60.70],
        [43.90, 60.20], [43.60, 60.20], [17.20, 77.40], [12.50, 78.00], [10.50, 76.00], [10.70, 73.00],
        [11.70, 72.00], [19.70, 66.50], [],
    ]

    /// 4 boil frames — deterministic zero-mean wavy noise, per coordinate.
    private static func noiseValue(_ f: Int, _ si: Int, _ pi: Int) -> CGFloat {
        let a: Double = sin(Double(f) * 2.1 + Double(si) * 1.37 + Double(pi) * 2.9) * 0.85
        let b: Double = sin(Double(f) * 4.3 + Double(si) * 0.53 + Double(pi) * 1.1) * 0.45
        return CGFloat(a + b)
    }
    static let noise: [[[CGFloat]]] = {
        var out: [[[CGFloat]]] = []
        for f in 0..<4 {
            var frame: [[CGFloat]] = []
            for si in pts.indices {
                var row: [CGFloat] = []
                for pi in pts[si].indices { row.append(noiseValue(f, si, pi)) }
                frame.append(row)
            }
            out.append(frame)
        }
        return out
    }()

    private static var cache: [String: Path] = [:]

    /// The burst with every vertex displaced by frame-noise × amp — the hand-drawn boil.
    static func boiled(frame: Int, amp: CGFloat) -> Path {
        let key = "\(frame):\(Int(amp * 100))"
        if let p = cache[key] { return p }
        var p = Path()
        let nf = noise[frame]
        for si in ops.indices where true {
            let row = pts[si]
            let o = nf[si]
            switch ops[si] {
            case "M": p.move(to: CGPoint(x: row[0] + o[0] * amp, y: row[1] + o[1] * amp))
            case "L": p.addLine(to: CGPoint(x: row[0] + o[0] * amp, y: row[1] + o[1] * amp))
            case "C": p.addCurve(to: CGPoint(x: row[4] + o[4] * amp, y: row[5] + o[5] * amp),
                                 control1: CGPoint(x: row[0] + o[0] * amp, y: row[1] + o[1] * amp),
                                 control2: CGPoint(x: row[2] + o[2] * amp, y: row[3] + o[3] * amp))
            default: p.closeSubpath()
            }
        }
        cache[key] = p
        return p
    }
}

// MARK: - Mode config (LOCKED tempo)

@available(iOS 17.0, *)
enum AlmaStarburstMode: String, CaseIterable, Identifiable {
    case thinking, researching, searching, writing, idle
    var id: String { rawValue }

    struct Config {
        let periodMs: Double            // one full revolution (outer layer)
        let breatheAmp, breatheSpeed: Double
        let boilAmp: CGFloat            // vertex displacement (units /100)
        let boilInterval: TimeInterval  // ~11fps steps
        let dotMix: CGFloat
    }

    var config: Config {
        switch self {
        case .thinking, .researching:
            return .init(periodMs: 4000, breatheAmp: 0.20, breatheSpeed: 0.055,
                         boilAmp: 2.0, boilInterval: 0.090, dotMix: 0)
        case .searching:
            return .init(periodMs: 1500, breatheAmp: 0.06, breatheSpeed: 0.075,
                         boilAmp: 0.6, boilInterval: 0.085, dotMix: 1)
        case .writing:
            return .init(periodMs: 2500, breatheAmp: 0.24, breatheSpeed: 0.130,
                         boilAmp: 2.4, boilInterval: 0.085, dotMix: 0)
        case .idle:   // footer wordmark — no rotation, gentle living boil
            return .init(periodMs: 1e12, breatheAmp: 0, breatheSpeed: 0,
                         boilAmp: 1.1, boilInterval: 0.120, dotMix: 0)
        }
    }

    static func from(_ raw: String) -> AlmaStarburstMode {
        switch raw {
        case "researching": return .researching
        case "searching", "tool_search": return .searching
        case "writing": return .writing
        case "idle": return .idle
        default: return .thinking
        }
    }

    var verbs: [String] {
        switch self {
        case .writing:
            return ["লিখছি", "সাজাচ্ছি", "তৈরি করছি", "গুছিয়ে লিখছি", "উত্তর লিখছি", "বাক্য সাজাচ্ছি", "শেষ করছি"]
        case .searching:
            return ["খুঁজছি", "দেখছি", "পড়ছি", "তথ্য আনছি", "যাচাই করছি", "খুঁজে দেখছি", "মিলিয়ে দেখছি", "সংগ্রহ করছি"]
        case .researching:
            return ["গবেষণা করছি", "তথ্য খুঁজছি", "উৎস দেখছি", "রিসার্চ করছি", "যাচাই করছি", "তুলনা করছি"]
        case .thinking:
            return ["ভাবছি", "চিন্তা করছি", "বুঝছি", "মনে করছি", "বিবেচনা করছি", "বিশ্লেষণ করছি", "মিলিয়ে দেখছি", "হিসাব করছি", "খেয়াল করছি"]
        case .idle:
            return ["ALMA"]
        }
    }

    var verbIntervalMs: UInt64 {
        switch self {
        case .writing: return 1500
        case .searching: return 1400
        case .researching: return 1800
        case .thinking: return 2000
        case .idle: return 60_000
        }
    }
}

// MARK: - Haptics (LOCKED: revolution-synced soft tick + medium mode start + settle thud)

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
        medium.impactOccurred(intensity: 0.72)
        medium.prepare()
    }

    /// One per revolution — synced to the outer rotation layer.
    static func tick() {
        soft.impactOccurred(intensity: 0.55)
        soft.prepare()
    }

    /// Reply settled + ALMA wordmark reveal.
    static func settleThud() {
        medium.impactOccurred(intensity: 0.65)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.09) {
            light.impactOccurred(intensity: 0.5)
        }
    }
}

// MARK: - Animation state (outer rotation ⟂ inner boil — never mixed)

@available(iOS 17.0, *)
private final class StarburstAnimState {
    var rotation: Double = 0
    var phase: Double = 0
    var dotMix: CGFloat = 0
    var boilFrame = 0
    private var boilAccum: TimeInterval = 0
    private var lastTick: TimeInterval?

    private static let fill = Color(red: 0.851, green: 0.467, blue: 0.341) // #d97757

    func tick(mode: AlmaStarburstMode, now: TimeInterval) {
        let dt: TimeInterval
        if let last = lastTick { dt = min(0.05, now - last) } else { dt = 1 / 60 }
        lastTick = now

        let t = mode.config
        dotMix += (t.dotMix - dotMix) * 0.1
        rotation += (.pi * 2) * dt / (t.periodMs / 1000)   // time-based → buttery at any fps
        phase += t.breatheSpeed

        boilAccum += dt
        if boilAccum >= t.boilInterval {
            boilAccum = 0
            boilFrame = (boilFrame + 1) % 4
        }
    }

    func draw(ctx: GraphicsContext, size: CGSize, mode: AlmaStarburstMode) {
        let t = mode.config
        let unit = size.width / 100
        let breathe = 1 + sin(phase) * t.breatheAmp

        var layer = ctx
        layer.translateBy(x: size.width / 2, y: size.height / 2)
        layer.rotate(by: .radians(rotation))
        layer.scaleBy(x: breathe, y: breathe)
        layer.scaleBy(x: unit, y: unit)
        layer.translateBy(x: -50, y: -50)

        let burstOpacity = 1 - dotMix * 0.92
        layer.fill(AlmaOrganicBurst.boiled(frame: boilFrame, amp: t.boilAmp),
                   with: .color(Self.fill.opacity(burstOpacity)))

        if dotMix > 0.02 {
            for i in 0..<12 {
                let a = (Double(i) / 12) * .pi * 2 - .pi / 2
                let dx = 50 + 35 * CGFloat(cos(a))
                let dy = 50 + 35 * CGFloat(sin(a))
                let r: CGFloat = 3.1
                let rect = CGRect(x: dx - r, y: dy - r, width: r * 2, height: r * 2)
                layer.fill(Path(ellipseIn: rect), with: .color(Self.fill.opacity(dotMix)))
            }
        }
    }
}

// MARK: - Shared loaders (replace legacy Alma / ProgressView spinners app-wide)

@available(iOS 17.0, *)
struct AlmaMiniLoader: View {
    var mode: AlmaStarburstMode = .searching
    var size: CGFloat = 13
    var body: some View { AlmaStarburstLoader(mode: mode, size: size) }
}

@available(iOS 17.0, *)
struct AlmaPageLoader: View {
    /// History fetch — no centered flash; Claude opens straight into the chat canvas.
    var body: some View {
        Color.clear.frame(height: 1)
    }
}

// MARK: - Organic burst loader (canvas box 46/28× — breathe/boil never clips)

@available(iOS 17.0, *)
struct AlmaStarburstLoader: View {
    let mode: AlmaStarburstMode
    var size: CGFloat = 22

    @State private var anim = StarburstAnimState()

    private var box: CGFloat { (size * 46 / 28).rounded() }

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: false)) { timeline in
            Canvas { ctx, sz in
                anim.tick(mode: mode, now: timeline.date.timeIntervalSinceReferenceDate)
                // draw the VISUAL size centered inside the larger box
                var inner = ctx
                inner.translateBy(x: (sz.width - size) / 2, y: (sz.height - size) / 2)
                anim.draw(ctx: inner, size: CGSize(width: size, height: size), mode: mode)
            }
        }
        .frame(width: box, height: box)
    }
}

// MARK: - Spinner row (glyph + Bangla verb + revolution-synced haptics)

@available(iOS 17.0, *)
struct AlmaSpinnerView: View {
    let mode: String
    var size: CGFloat = 18
    var showVerb: Bool = true
    var haptics: Bool = true

    @State private var verbIdx = 0

    private var starburstMode: AlmaStarburstMode { AlmaStarburstMode.from(mode) }
    private static let verbColor = Color(red: 0.851, green: 0.467, blue: 0.341)

    var body: some View {
        HStack(spacing: 10) {
            AlmaStarburstLoader(mode: starburstMode, size: size)
            if showVerb {
                Text("\(starburstMode.verbs[verbIdx % max(1, starburstMode.verbs.count)])…")
                    .font(.system(size: size * 0.62 + 2, weight: .medium))
                    .foregroundStyle(Self.verbColor)
            }
        }
        .task(id: mode) {
            verbIdx = 0
            var ticks: UInt64 = 0
            let verbMs = starburstMode.verbIntervalMs
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
                ticks += 100
                if ticks >= verbMs {
                    verbIdx += 1
                    ticks = 0
                }
            }
        }
        .task(id: "\(mode)-haptics-\(haptics)") {
            guard haptics, starburstMode != .idle else { return }
            AlmaAgentTickHaptic.prepare()
            AlmaAgentTickHaptic.modeStart()
            // LOCKED: one soft tick per revolution — 4s thinking · 2.5s writing · 1.5s tool.
            let gap = UInt64(starburstMode.config.periodMs)
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: gap * 1_000_000)
                AlmaAgentTickHaptic.tick()
            }
        }
    }
}

// MARK: - Preview screen (More → Loader Preview, DEBUG)

// App target only: uses AgentPalette / AgentThinkingRow / AgentAuroraBackground.
// This file is ALSO compiled into AlmaWidgetExtension (the island needs
// AlmaOrganicBurst), and the appex links no Pods — so canImport(Capacitor) is
// a clean app-vs-appex compile gate for the app-only tail of the file.
#if canImport(Capacitor)
@available(iOS 17.0, *)
struct AlmaSpinnerPreviewScreen: View {
    @State private var mode: AlmaStarburstMode = .thinking
    @State private var autoCycle = true
    @State private var seconds = 0
    @Environment(\.colorScheme) private var scheme

    private var cream: Color { Color(red: 0.929, green: 0.890, blue: 0.855) }

    // Self-contained colors — this file also compiles in the widget extension,
    // where AgentPalette/AgentAuroraBackground don't exist.
    private var ink: Color { scheme == .dark ? Color(red: 0.969, green: 0.973, blue: 0.988) : Color(red: 0.102, green: 0.102, blue: 0.180) }
    private var muted: Color { Color(red: 0.682, green: 0.698, blue: 0.753) }
    private var cardBg: Color { scheme == .dark ? Color(red: 0.125, green: 0.125, blue: 0.153) : .white }
    private var coral: Color { Color(red: 0.878, green: 0.478, blue: 0.373) }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                Text("Organic starburst")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(ink)
                Text("দুই layer: smooth rotation (৪s/২.৫s/১.৫s per rev) + ৪-frame hand-drawn boil")
                    .font(.system(size: 13))
                    .foregroundStyle(muted)
                    .multilineTextAlignment(.center)

                ZStack {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(cream)
                        .frame(width: 260, height: 260)
                    AlmaStarburstLoader(mode: mode, size: 150)
                }
                Text(statusLine)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(muted)

                HStack(spacing: 10) {
                    AlmaStarburstLoader(mode: mode, size: 32)
                    AlmaSpinnerView(mode: mode.rawValue, size: 18, showVerb: true, haptics: true)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(cardBg.opacity(0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.08), lineWidth: 1))

                HStack(spacing: 8) {
                    ForEach(AlmaStarburstMode.allCases) { m in
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            mode = m
                            seconds = 0
                        } label: {
                            Text(label(for: m))
                                .font(.system(size: 11.5, weight: .semibold))
                                .foregroundStyle(mode == m ? .white : ink)
                                .padding(.horizontal, 10).padding(.vertical, 8)
                                .background(mode == m ? coral : cardBg.opacity(0.6),
                                            in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }

                Toggle("Auto-cycle every 8s", isOn: $autoCycle)
                    .font(.system(size: 14))
                    .tint(coral)
                    .padding(.horizontal, 4)

                HStack { AlmaSpinnerView(mode: mode.rawValue, size: 28, showVerb: false, haptics: false); Spacer() }
                    .padding(.top, 8)
            }
            .padding(20)
        }
        .background(
            LinearGradient(colors: [Color(red: 0.078, green: 0.078, blue: 0.094),
                                    Color(red: 0.13, green: 0.10, blue: 0.18)],
                           startPoint: .top, endPoint: .bottom).ignoresSafeArea())
        .navigationTitle("Loader Preview")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { AlmaAgentTickHaptic.prepare() }
        .task(id: mode) {
            seconds = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                seconds += 1
            }
        }
        .task(id: autoCycle) {
            guard autoCycle else { return }
            let order = AlmaStarburstMode.allCases
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                if let idx = order.firstIndex(of: mode) {
                    mode = order[(idx + 1) % order.count]
                    seconds = 0
                }
            }
        }
    }

    private func label(for m: AlmaStarburstMode) -> String {
        switch m {
        case .thinking: return "Thinking"
        case .researching: return "Research"
        case .searching: return "Tool"
        case .writing: return "Writing"
        case .idle: return "Idle"
        }
    }

    private var statusLine: String {
        switch mode {
        case .thinking: return "Thinking… 4s/rev · \(seconds)s"
        case .researching: return "Researching… · \(seconds)s"
        case .searching: return "Tool… 1.5s/rev"
        case .writing: return "Writing… 2.5s/rev"
        case .idle: return "Idle — wordmark rest"
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Organic — Thinking") {
    AlmaStarburstLoader(mode: .thinking, size: 120)
        .padding(40)
        .background(Color(red: 0.929, green: 0.890, blue: 0.855))
}

@available(iOS 17.0, *)
#Preview("Spinner row") {
    AlmaSpinnerView(mode: "thinking", size: 22, showVerb: true, haptics: false)
        .padding()
}

@available(iOS 17.0, *)
#Preview("Preview screen") {
    NavigationStack { AlmaSpinnerPreviewScreen() }
}
#endif
#endif
