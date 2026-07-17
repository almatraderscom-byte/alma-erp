//
//  AgentAnimations.swift
//  ALMA ERP — native agent animations (spec: ALMA_NATIVE_IOS_AGENT_ANIMATIONS_SPEC.md).
//
//  Two confirmed experiences, both additive layers over the EXISTING agent screen:
//    A. Session-opening "awakening" — a small glass agent character performs an
//       8-phase Bangla dialogue while the real conversation restores; success is
//       gated on REAL readiness (never invented progress).
//    B. Hidden pull-to-refresh — at rest the layer is EXACTLY 0pt (pixel-identical
//       idle screen); a top-edge overscroll reveals an interactive, finger-scrubbed
//       stage; release above threshold runs the REAL refresh exactly once.
//
//  House rules honoured: single new file (pbxproj objectVersion 48 — one file ref),
//  no web view, no rasters, no Claude assets, Reduce Motion + VoiceOver paths,
//  DEBUG env-gated selftests (this repo's test convention; no XCTest target exists).
//  Pull internals require the iOS 18 scroll-geometry/phase APIs — on iOS 17 the
//  modifier is inert, which IS the spec's idle contract (nothing visible at rest).
//

import SwiftUI
import UIKit

// MARK: - Shared identity tokens

enum AgentMotionColor {
    static let violet  = Color(red: 0.56, green: 0.45, blue: 1.00)
    static let mint    = Color(red: 0.43, green: 0.96, blue: 0.86)
    static let gold    = Color(red: 0.94, green: 0.70, blue: 0.35)
    static let success = Color(red: 0.42, green: 0.93, blue: 0.68)
}

// MARK: - Haptics (prepared, edge-triggered only)

@available(iOS 17.0, *)
@MainActor
final class AgentAnimHaptics {
    static let shared = AgentAnimHaptics()
    private let soft = UIImpactFeedbackGenerator(style: .soft)
    private let light = UIImpactFeedbackGenerator(style: .light)
    private let medium = UIImpactFeedbackGenerator(style: .medium)
    private let notify = UINotificationFeedbackGenerator()
    private let select = UISelectionFeedbackGenerator()

    func prepareAll() { soft.prepare(); light.prepare(); medium.prepare(); notify.prepare(); select.prepare() }
    private var foreground: Bool { UIApplication.shared.applicationState == .active }

    func apologetic()   { guard foreground else { return }; soft.impactOccurred(intensity: 0.45) }
    func discovered()   { guard foreground else { return }; light.impactOccurred(intensity: 0.75) }
    func successMain()  { guard foreground else { return }; notify.notificationOccurred(.success) }
    func successBounce(){ guard foreground else { return }; soft.impactOccurred(intensity: 0.4) }
    func armed()        { guard foreground else { return }; light.impactOccurred(intensity: 0.8) }
    func disarmed()     { guard foreground else { return }; select.selectionChanged() }
    func releaseKick()  { guard foreground else { return }; medium.impactOccurred() }
    func failure()      { guard foreground else { return }; notify.notificationOccurred(.error) }
}

// MARK: - The character
// One compact glass agent reused by both animations: rounded glass body, dark
// face panel, two mint eyes, small mouth, violet antenna, two stub arms, aura +
// orbit rings + soft shadow. Pure shapes — no rasters, no mascot copy.

@available(iOS 17.0, *)
struct AgentCharacterPose: Equatable {
    var scale: CGFloat = 1            // body scale multiplier
    var eyeLook: CGFloat = 0          // -1 left … +1 right
    var eyeHappy: Bool = false        // arcs instead of dots
    var eyeWorried: Bool = false      // tilted lids
    var winkRight: Bool = false
    var mouth: Mouth = .smile
    var armLift: CGFloat = 0          // 0 rest … 1 both arms up
    var pointUp: Bool = false         // right arm points up (discovery)
    var auraSpeed: Double = 1         // orbit angular velocity multiplier
    var auraColor: Color = AgentMotionColor.violet
    var glowBoost: CGFloat = 0        // 0…1 extra aura brightness
    var braced: Bool = false          // pull "prepare": tightened silhouette
    enum Mouth: Equatable { case smile, oh, focused, grin }
}

@available(iOS 17.0, *)
struct LivingAgentCharacter: View {
    var pose: AgentCharacterPose
    var size: CGFloat = 96
    /// Drives idle breathing + orbit rotation. Callers pass a shared start date.
    var clockStart: Date
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: reduceMotion ? 0.25 : 1.0 / 60.0)) { ctx in
            let t = ctx.date.timeIntervalSince(clockStart)
            let breathe = reduceMotion ? 0 : sin(t * 2 * .pi / 3.4) // 3.4 s cycle
            let bob = CGFloat(breathe) * size * 0.03
            let orbitA = reduceMotion ? 0 : t * 1.6 * pose.auraSpeed
            let orbitB = reduceMotion ? 0 : -t * 1.1 * pose.auraSpeed

            ZStack {
                // Soft ground shadow (small, never full-screen).
                Ellipse()
                    .fill(Color.black.opacity(0.35))
                    .frame(width: size * 0.72, height: size * 0.16)
                    .blur(radius: 6)
                    .offset(y: size * 0.62 - bob * 0.4)

                // Aura
                Circle()
                    .fill(RadialGradient(colors: [pose.auraColor.opacity(0.34 + 0.3 * pose.glowBoost),
                                                  pose.auraColor.opacity(0)],
                                         center: .center,
                                         startRadius: size * 0.18, endRadius: size * 0.78))
                    .frame(width: size * 1.6, height: size * 1.6)
                    .offset(y: bob)

                // Orbit rings + riders (skipped under Reduce Motion)
                if !reduceMotion {
                    orbit(radius: size * 0.62, tilt: 0.42, angle: orbitA, dot: AgentMotionColor.mint)
                    orbit(radius: size * 0.72, tilt: -0.30, angle: orbitB, dot: pose.auraColor)
                }

                // Body group
                ZStack {
                    // Glass body — slightly organic: two stacked rounded shapes.
                    RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                        .fill(.ultraThinMaterial)
                        .overlay(
                            RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                                .fill(LinearGradient(colors: [Color.white.opacity(0.16), Color.white.opacity(0.02)],
                                                     startPoint: .topLeading, endPoint: .bottomTrailing)))
                        .overlay(
                            RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                                .strokeBorder(pose.auraColor.opacity(0.55 + 0.35 * pose.glowBoost), lineWidth: 1.2))
                        .frame(width: size * 0.86, height: size * 0.8)

                    // Antenna
                    VStack(spacing: 0) {
                        Circle().fill(pose.auraColor)
                            .frame(width: size * 0.09, height: size * 0.09)
                            .shadow(color: pose.auraColor.opacity(0.9), radius: 4)
                        Rectangle().fill(pose.auraColor.opacity(0.8))
                            .frame(width: 2, height: size * 0.1)
                    }
                    .offset(y: -size * 0.5)

                    // Face panel
                    RoundedRectangle(cornerRadius: size * 0.2, style: .continuous)
                        .fill(Color(red: 0.07, green: 0.06, blue: 0.12).opacity(0.92))
                        .frame(width: size * 0.62, height: size * 0.44)
                        .offset(y: -size * 0.03)

                    face(t: t)
                        .offset(y: -size * 0.03)

                    arms
                }
                .frame(width: size, height: size)
                .scaleEffect(pose.scale * (pose.braced ? 0.96 : 1))
                .offset(y: bob)
            }
            .frame(width: size * 1.7, height: size * 1.7)
        }
    }

    private func orbit(radius: CGFloat, tilt: CGFloat, angle: Double, dot: Color) -> some View {
        ZStack {
            Ellipse()
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.8)
                .frame(width: radius * 2, height: radius * 2 * (0.55 + abs(tilt) * 0.3))
            Circle().fill(dot)
                .frame(width: 4.5, height: 4.5)
                .shadow(color: dot.opacity(0.9), radius: 3)
                .offset(x: radius * cos(angle),
                        y: radius * (0.55 + abs(tilt) * 0.3) * sin(angle))
        }
        .rotationEffect(.radians(Double(tilt) * 0.5))
    }

    @ViewBuilder private func face(t: TimeInterval) -> some View {
        let eyeW = size * 0.085
        let gap = size * 0.16
        let look = pose.eyeLook * size * 0.035
        // ~6 s blink under normal motion.
        let blink = !reduceMotion && t.truncatingRemainder(dividingBy: 6.0) > 5.86

        HStack(spacing: gap) {
            eye(width: eyeW, blink: blink, wink: false)
            eye(width: eyeW, blink: blink, wink: pose.winkRight)
        }
        .offset(x: look, y: -size * 0.02)
        .overlay(alignment: .bottom) { mouth.offset(y: size * 0.055) }
    }

    @ViewBuilder private func eye(width: CGFloat, blink: Bool, wink: Bool) -> some View {
        let closed = blink || wink
        Group {
            if pose.eyeHappy && !closed {
                // Happy arc
                Circle().trim(from: 0.08, to: 0.42)
                    .stroke(AgentMotionColor.mint, style: StrokeStyle(lineWidth: width * 0.42, lineCap: .round))
                    .frame(width: width * 1.5, height: width * 1.5)
                    .rotationEffect(.degrees(180))
            } else {
                Capsule()
                    .fill(AgentMotionColor.mint)
                    .frame(width: width, height: closed ? width * 0.16 : width * 1.55)
                    .rotationEffect(.degrees(pose.eyeWorried ? 12 : 0))
                    .shadow(color: AgentMotionColor.mint.opacity(0.8), radius: 3)
            }
        }
        .animation(.easeOut(duration: 0.12), value: closed)
    }

    @ViewBuilder private var mouth: some View {
        let w = size * 0.13
        switch pose.mouth {
        case .smile:
            Circle().trim(from: 0.56, to: 0.94)
                .stroke(AgentMotionColor.mint.opacity(0.9), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .frame(width: w, height: w * 0.9)
        case .oh:
            Circle().strokeBorder(AgentMotionColor.mint.opacity(0.9), lineWidth: 2)
                .frame(width: w * 0.55, height: w * 0.62)
        case .focused:
            Capsule().fill(AgentMotionColor.mint.opacity(0.85))
                .frame(width: w * 0.8, height: 2)
        case .grin:
            Circle().trim(from: 0.52, to: 0.98)
                .stroke(AgentMotionColor.mint, style: StrokeStyle(lineWidth: 2.6, lineCap: .round))
                .frame(width: w * 1.25, height: w * 1.1)
        }
    }

    @ViewBuilder private var arms: some View {
        let lift = pose.armLift
        HStack {
            Capsule().fill(.ultraThinMaterial)
                .overlay(Capsule().strokeBorder(pose.auraColor.opacity(0.5), lineWidth: 1))
                .frame(width: size * 0.07, height: size * 0.22)
                .rotationEffect(.degrees(Double(28 - lift * 118)), anchor: .top)
                .offset(x: -size * 0.41, y: size * 0.06 - lift * size * 0.1)
            Spacer().frame(width: size * 0.6)
            Capsule().fill(.ultraThinMaterial)
                .overlay(Capsule().strokeBorder(pose.auraColor.opacity(0.5), lineWidth: 1))
                .frame(width: size * 0.07, height: size * 0.22)
                .rotationEffect(.degrees(pose.pointUp ? -160 : Double(-28 + lift * 118)), anchor: .top)
                .offset(x: size * 0.41, y: size * 0.06 - lift * size * 0.1)
        }
        .animation(.spring(response: 0.42, dampingFraction: 0.68), value: lift)
        .animation(.spring(response: 0.42, dampingFraction: 0.68), value: pose.pointUp)
    }
}

// MARK: - Particles (conservative, prebuilt geometry)

@available(iOS 17.0, *)
struct AgentParticleField: View {
    /// 0…1 — how strongly particles converge toward the core (finalizing).
    var converge: CGFloat = 0
    var color: Color = AgentMotionColor.violet
    var count: Int = 10
    var clockStart: Date
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Deterministic per-index seeds — built once, no per-frame allocation.
    private static let seeds: [(angle: Double, radius: CGFloat, speed: Double, size: CGFloat)] = (0..<16).map { i in
        let a = Double(i) * 2.399963  // golden angle
        return (a, 0.55 + CGFloat((i * 37) % 40) / 100, 0.5 + Double((i * 53) % 50) / 60, 2 + CGFloat(i % 3))
    }

    var body: some View {
        if reduceMotion || ProcessInfo.processInfo.isLowPowerModeEnabled {
            EmptyView()
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 45.0)) { ctx in
                let t = ctx.date.timeIntervalSince(clockStart)
                Canvas { canvas, cg in
                    let c = CGPoint(x: cg.width / 2, y: cg.height / 2)
                    let base = min(cg.width, cg.height) / 2
                    for i in 0..<min(count, Self.seeds.count) {
                        let s = Self.seeds[i]
                        let drift = t * s.speed
                        let r = base * s.radius * (1 - converge * 0.72)
                        let a = s.angle + drift
                        let p = CGPoint(x: c.x + r * cos(a), y: c.y + r * sin(a) * 0.8)
                        let alpha = 0.25 + 0.5 * (0.5 + 0.5 * sin(drift * 2 + s.angle))
                        canvas.fill(Path(ellipseIn: CGRect(x: p.x - s.size / 2, y: p.y - s.size / 2,
                                                           width: s.size, height: s.size)),
                                    with: .color(color.opacity(alpha)))
                    }
                }
            }
            .allowsHitTesting(false)
        }
    }
}

// MARK: - A. Session-opening awakening

@available(iOS 17.0, *)
enum AgentAwakeningPhase: Equatable {
    case hidden, arriving, greeting, searching, apologetic, discovered, finalizing, success, dismissing
}

/// Pure, deterministic phase reducer — selftest-covered. Success may begin ONLY
/// when the app has confirmed real readiness (`ready == true`).
@available(iOS 17.0, *)
struct AgentAwakeningReducer {
    static let order: [AgentAwakeningPhase] =
        [.arriving, .greeting, .searching, .apologetic, .discovered, .finalizing, .success, .dismissing]

    static func next(after phase: AgentAwakeningPhase, ready: Bool) -> AgentAwakeningPhase {
        switch phase {
        case .hidden: return .arriving
        case .finalizing: return ready ? .success : .finalizing   // loop focus only, never re-play dialogue
        case .success: return .dismissing
        case .dismissing: return .hidden
        default:
            guard let i = order.firstIndex(of: phase) else { return .hidden }
            return order[i + 1]
        }
    }

    /// If restoration finishes early we accelerate: any pre-finalizing phase may
    /// jump straight to .success once ready AND the minimum arrival beat played.
    static func accelerated(from phase: AgentAwakeningPhase, ready: Bool) -> AgentAwakeningPhase? {
        guard ready else { return nil }
        switch phase {
        case .greeting, .searching, .apologetic, .discovered, .finalizing: return .success
        default: return nil
        }
    }
}

@available(iOS 17.0, *)
@Observable @MainActor
final class AgentAwakeningModel {
    private(set) var phase: AgentAwakeningPhase = .hidden
    private(set) var ready = false
    /// True while the overlay owns the content area (pull-refresh must stay off).
    var isActive: Bool { phase != .hidden }
    private var runner: Task<Void, Never>?
    let clockStart = Date()

    /// Begin the performance — only when an existing session is actually being
    /// restored (empty message list at screen-open). No-op otherwise.
    func begin(sessionNeedsRestore: Bool) {
        guard sessionNeedsRestore, phase == .hidden, runner == nil else { return }
        AgentAnimHaptics.shared.prepareAll()
        AlmaPerfLog.event("agentAwakening.begin")
        runner = Task { [weak self] in await self?.run() }
    }

    /// Replay from scratch — used when a DIFFERENT existing conversation is opened
    /// from the drawer (the app-launch path uses `begin`). Cancels any in-flight
    /// run, resets to hidden, and starts the performance fresh.
    func restart(sessionNeedsRestore: Bool) {
        runner?.cancel(); runner = nil
        ready = false
        phase = .hidden
        begin(sessionNeedsRestore: sessionNeedsRestore)
    }

    /// Real readiness signal. `hasContent=false` (nothing to restore — fresh chat)
    /// dismisses quietly without the success celebration.
    func markReady(hasContent: Bool) {
        ready = true
        if !hasContent, isActive {
            AlmaPerfLog.event("agentAwakening.quietDismiss")
            runner?.cancel(); runner = nil
            withAnimation(.easeOut(duration: 0.3)) { phase = .hidden }
        }
    }

    private func set(_ p: AgentAwakeningPhase) {
        guard phase != p else { return }
        AlmaPerfLog.event("agentAwakening.phase", "\(p)")
        withAnimation(.spring(response: 0.42, dampingFraction: 0.72)) { phase = p }
        switch p {
        case .apologetic: AgentAnimHaptics.shared.apologetic()
        case .discovered: AgentAnimHaptics.shared.discovered()
        case .success:
            AgentAnimHaptics.shared.successMain()
            Task { try? await Task.sleep(nanoseconds: 90_000_000); AgentAnimHaptics.shared.successBounce() }
            UIAccessibility.post(notification: .announcement, argument: "সেশন প্রস্তুত")
        default: break
        }
    }

    private func run() async {
        let reduceMotion = UIAccessibility.isReduceMotionEnabled
        // Reduce Motion: skip the theatrical dialogue — calm fade in, wait for
        // readiness, calm fade out (haptics preserved at success).
        if reduceMotion {
            set(.finalizing)
            while !ready, !Task.isCancelled { try? await Task.sleep(nanoseconds: 120_000_000) }
            guard !Task.isCancelled else { return }
            set(.success)
            try? await Task.sleep(nanoseconds: 800_000_000)
            set(.dismissing)
            try? await Task.sleep(nanoseconds: 350_000_000)
            set(.hidden); runner = nil
            return
        }
        // Deterministic presentation beats (spec §2 timing); real readiness can
        // accelerate any post-greeting beat straight to success.
        let beats: [(AgentAwakeningPhase, UInt64)] = [
            (.arriving, 850_000_000), (.greeting, 1_450_000_000), (.searching, 1_550_000_000),
            (.apologetic, 1_550_000_000), (.discovered, 1_350_000_000),
        ]
        for (p, ns) in beats {
            guard !Task.isCancelled else { return }
            set(p)
            try? await Task.sleep(nanoseconds: ns)
            // Early real readiness → accelerate (but always let arrival+greeting land).
            if let jump = AgentAwakeningReducer.accelerated(from: p, ready: ready), p != .arriving {
                set(jump); await finishFromSuccess(); return
            }
        }
        guard !Task.isCancelled else { return }
        set(.finalizing)
        while !ready, !Task.isCancelled {   // loop the focus state only
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        guard !Task.isCancelled else { return }
        set(.success)
        await finishFromSuccess()
    }

    private func finishFromSuccess() async {
        try? await Task.sleep(nanoseconds: 1_100_000_000)
        guard !Task.isCancelled else { return }
        set(.dismissing)
        try? await Task.sleep(nanoseconds: 320_000_000)
        set(.hidden)
        AlmaPerfLog.event("agentAwakening.done")
        runner = nil
    }
}

@available(iOS 17.0, *)
struct AgentAwakeningOverlay: View {
    let model: AgentAwakeningModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var bubbleText: String? {
        switch model.phase {
        case .greeting:   return "Shhh… boss আসছে!"
        case .searching:  return "Boss! একটু wait… 👀"
        case .apologetic: return "Oops, boss sorry! অনেক কাজ 😅"
        case .discovered: return "YES! সব পেয়ে গেছি!"
        case .finalizing: return "Last touch, boss… magic চলছে ✦"
        case .success:    return "Happy boss? DONE! ✦"
        default: return nil
        }
    }

    private var pose: AgentCharacterPose {
        var p = AgentCharacterPose()
        switch model.phase {
        case .arriving:  p.scale = 0.9; p.mouth = .smile
        case .greeting:  p.scale = 0.86; p.eyeLook = 0.7; p.armLift = 0.25
        case .searching: p.scale = 1.0; p.auraSpeed = 1.5; p.mouth = .smile
        case .apologetic: p.eyeWorried = true; p.mouth = .oh; p.armLift = 0.55; p.auraColor = AgentMotionColor.gold
        case .discovered: p.pointUp = true; p.winkRight = true; p.auraSpeed = 2.4; p.glowBoost = 0.5; p.mouth = .grin
        case .finalizing: p.mouth = .focused; p.auraSpeed = 1.8; p.glowBoost = 0.3; p.auraColor = AgentMotionColor.gold
        case .success:   p.scale = 1.14; p.eyeHappy = true; p.mouth = .grin; p.armLift = 1
                         p.auraColor = AgentMotionColor.success; p.glowBoost = 0.7; p.auraSpeed = 2.0
        case .dismissing: p.scale = 0.94; p.eyeHappy = true
        default: break
        }
        return p
    }

    var body: some View {
        if model.isActive {
            GeometryReader { geo in
                ZStack {
                    // Searching eyes scan; implemented as a slow autonomous look.
                    let scanning = model.phase == .searching
                    TimelineView(.animation(minimumInterval: reduceMotion ? 1 : 0.15, paused: !scanning)) { ctx in
                        var p = pose
                        let t = ctx.date.timeIntervalSince(model.clockStart)
                        if scanning { p.eyeLook = CGFloat(sin(t * 2.2)) }
                        return ZStack {
                            // finalizing scan-line + converging particles
                            AgentParticleField(converge: model.phase == .finalizing ? 0.9 : 0.15,
                                               color: pose.auraColor, count: 10,
                                               clockStart: model.clockStart)
                                .frame(width: 220, height: 220)

                            if model.phase == .success {
                                AgentSuccessBurst(clockStart: model.clockStart)
                            }

                            LivingAgentCharacter(pose: p, size: 96, clockStart: model.clockStart)
                                .modifier(AgentArrivalModifier(phase: model.phase, reduceMotion: reduceMotion))
                                .modifier(AgentShakeModifier(active: model.phase == .apologetic && !reduceMotion))
                        }
                    }

                    // Dialogue bubble (spring, no typing indicator)
                    if let text = bubbleText {
                        Text(text)
                            .font(.system(size: 15, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white.opacity(0.95))
                            .padding(.horizontal, 16).padding(.vertical, 9)
                            .background(.ultraThinMaterial, in: Capsule())
                            .overlay(Capsule().strokeBorder(pose.auraColor.opacity(0.45), lineWidth: 1))
                            .offset(y: -92)
                            .transition(.scale(scale: 0.7).combined(with: .opacity))
                            .id(text)
                    }

                    // READY reveal
                    if model.phase == .success {
                        Text("READY")
                            .font(.system(size: 13, weight: .black, design: .rounded))
                            .kerning(4)
                            .foregroundStyle(AgentMotionColor.success)
                            .shadow(color: AgentMotionColor.success.opacity(0.9), radius: 8)
                            .offset(y: 84)
                            .transition(.asymmetric(
                                insertion: .opacity.combined(with: .offset(y: 14)),
                                removal: .opacity.combined(with: .offset(y: -18))))
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height)
                .opacity(model.phase == .dismissing ? 0 : 1)
                .blur(radius: model.phase == .dismissing ? 4 : 0)
            }
            .transition(.opacity)
            .allowsHitTesting(false)   // never intercept composer/header taps
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("এজেন্ট সেশন লোড হচ্ছে")
        }
    }
}

/// Phase-1 arrival: 5% scale, 40pt low, blurred, slight negative rotation → spring in.
@available(iOS 17.0, *)
private struct AgentArrivalModifier: ViewModifier {
    let phase: AgentAwakeningPhase
    let reduceMotion: Bool
    func body(content: Content) -> some View {
        let arriving = phase == .arriving
        content
            .scaleEffect(arriving && !reduceMotion ? 0.05 : 1)
            .offset(y: arriving && !reduceMotion ? 42 : 0)
            .blur(radius: arriving && !reduceMotion ? 14 : 0)
            .rotationEffect(.degrees(arriving && !reduceMotion ? -8 : 0))
            .opacity(arriving && !reduceMotion ? 0 : 1)
            .animation(.spring(response: 0.95, dampingFraction: 0.74), value: arriving)
    }
}

/// Apologetic micro-shake — character only, never the app screen.
@available(iOS 17.0, *)
private struct AgentShakeModifier: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        TimelineView(.animation(minimumInterval: 1.0 / 45.0, paused: !active)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            content.offset(x: active ? CGFloat(sin(t * 34)) * 2.2 : 0)
        }
    }
}

/// One-shot success wave + fine confetti (restrained; no full-screen flash).
@available(iOS 17.0, *)
private struct AgentSuccessBurst: View {
    var clockStart: Date
    @State private var fired = Date()
    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { ctx in
            let age = ctx.date.timeIntervalSince(fired)
            let k = min(1, age / 0.9)
            ZStack {
                Circle()
                    .strokeBorder(AgentMotionColor.success.opacity(0.5 * (1 - k)), lineWidth: 2)
                    .frame(width: 40 + 220 * k, height: 40 + 220 * k)
                Canvas { canvas, size in
                    guard k < 1 else { return }
                    let c = CGPoint(x: size.width / 2, y: size.height / 2)
                    for i in 0..<14 {
                        let a = Double(i) * 0.4488 + 0.3
                        let r = 20 + 130 * k * (0.6 + 0.4 * Double((i * 29) % 10) / 10)
                        let p = CGPoint(x: c.x + r * cos(a), y: c.y + r * sin(a) - 30 * k)
                        let col = i % 3 == 0 ? AgentMotionColor.mint : (i % 3 == 1 ? AgentMotionColor.success : AgentMotionColor.gold)
                        canvas.fill(Path(ellipseIn: CGRect(x: p.x, y: p.y, width: 3, height: 3)),
                                    with: .color(col.opacity(1 - k)))
                    }
                }
            }
        }
        .frame(width: 280, height: 280)
        .allowsHitTesting(false)
    }
}

// MARK: - B. Hidden pull-to-refresh

/// Pure pull math (spec §3) — selftest-covered.
struct AgentPullMath {
    static let threshold: CGFloat = 104
    static let maximumVisualPull: CGFloat = 128
    static let resistance: CGFloat = 0.58
    static let armThreshold: CGFloat = 1.00
    static let disarmThreshold: CGFloat = 0.94

    static func resistedPull(raw: CGFloat) -> CGFloat {
        min(maximumVisualPull, max(0, raw * resistance))
    }
    static func progress(raw: CGFloat) -> CGFloat {
        min(1, resistedPull(raw: raw) / threshold)
    }
    /// Hysteresis: returns the new armed flag (nil = unchanged / no edge).
    static func armedEdge(current: Bool, progress: CGFloat) -> Bool? {
        if !current && progress >= armThreshold { return true }
        if current && progress < disarmThreshold { return false }
        return nil
    }
}

@available(iOS 17.0, *)
enum PullRefreshPhase: Equatable {
    case idle
    case revealing(progress: CGFloat)
    case observing(progress: CGFloat)
    case collecting(progress: CGFloat)
    case armed
    case refreshing
    case celebrating
    case collapsing
}

@available(iOS 17.0, *)
@Observable @MainActor
final class AgentPullState {
    private(set) var phase: PullRefreshPhase = .idle
    private(set) var progress: CGFloat = 0     // 0…1 scrub
    private(set) var stageHeight: CGFloat = 0  // EXACTLY 0 at idle
    private(set) var armed = false
    private var refreshRunning = false
    private var dragging = false
    let clockStart = Date()

    /// Live finger-driven update. rawPull = top overscroll in points (≥0).
    func dragChanged(rawPull: CGFloat) {
        guard !refreshRunning else { return }
        dragging = rawPull > 0.5
        let resisted = AgentPullMath.resistedPull(raw: rawPull)
        let p = AgentPullMath.progress(raw: rawPull)
        progress = p
        stageHeight = resisted
        if let edge = AgentPullMath.armedEdge(current: armed, progress: p) {
            armed = edge
            if edge { AgentAnimHaptics.shared.armed()
                      UIAccessibility.post(notification: .announcement, argument: "ছাড়লে রিফ্রেশ হবে") }
            else    { AgentAnimHaptics.shared.disarmed() }
            AlmaPerfLog.event("agentPull.arm", edge ? "armed" : "disarmed")
        }
        switch p {
        case 0:            if !refreshRunning { phase = .idle }
        case ..<0.20:      phase = .revealing(progress: p)
        case ..<0.52:      phase = .observing(progress: p)
        case ..<1:         phase = .collecting(progress: p)
        default:           phase = .armed
        }
    }

    /// Finger lifted / scroll settled. Returns true when a refresh was started.
    @discardableResult
    func dragEnded(refresh: @escaping @MainActor () async throws -> Void) -> Bool {
        guard dragging || armed, !refreshRunning else { collapseIfNeeded(); return false }
        dragging = false
        guard armed else { collapseIfNeeded(); return false }
        armed = false
        refreshRunning = true
        phase = .refreshing
        AgentAnimHaptics.shared.releaseKick()
        UIAccessibility.post(notification: .announcement, argument: "রিফ্রেশ হচ্ছে")
        AlmaPerfLog.event("agentPull.refresh", "start")
        withAnimation(.spring(response: 0.36, dampingFraction: 0.88)) {
            stageHeight = AgentPullMath.threshold * 0.86   // locked stage while working
            progress = 1
        }
        Task { @MainActor [weak self] in
            var failed = false
            do { try await refresh() } catch { failed = true }
            self?.finishRefresh(failed: failed)
        }
        return true
    }

    private func finishRefresh(failed: Bool) {
        AlmaPerfLog.event("agentPull.refresh", failed ? "fail" : "done")
        if failed {
            AgentAnimHaptics.shared.failure()
            UIAccessibility.post(notification: .announcement, argument: "রিফ্রেশ ব্যর্থ")
            collapse(after: 0)
        } else {
            phase = .celebrating
            AgentAnimHaptics.shared.successMain()
            UIAccessibility.post(notification: .announcement, argument: "রিফ্রেশ সম্পন্ন")
            collapse(after: 0.9)
        }
    }

    private func collapse(after delay: TimeInterval) {
        Task { [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            await MainActor.run {
                guard let self else { return }
                self.phase = .collapsing
                withAnimation(.spring(response: 0.36, dampingFraction: 0.88)) {
                    self.stageHeight = 0; self.progress = 0
                }
                self.refreshRunning = false
                Task { try? await Task.sleep(nanoseconds: 380_000_000)
                       await MainActor.run { if self.stageHeight == 0 { self.phase = .idle } } }
            }
        }
    }

    private func collapseIfNeeded() {
        guard !refreshRunning, stageHeight > 0 || progress > 0 else { return }
        withAnimation(.spring(response: 0.36, dampingFraction: 0.88)) {
            stageHeight = 0; progress = 0
        }
        phase = .idle
    }
}

/// The revealed stage. Rendered ONLY while stageHeight > 0 — at idle nothing is
/// mounted, honouring the pixel-identical idle contract.
@available(iOS 17.0, *)
struct AgentPullStage: View {
    let state: AgentPullState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var pose: AgentCharacterPose {
        var p = AgentCharacterPose()
        let prog = state.progress
        switch state.phase {
        case .revealing:  p.scale = 0.7; p.eyeLook = 0
        case .observing:  p.scale = 0.8 + prog * 0.2; p.eyeLook = CGFloat(sin(Double(prog) * 9)) * 0.8
        case .collecting: p.scale = 1; p.armLift = (prog - 0.52) / 0.4; p.glowBoost = prog * 0.5
        case .armed:      p.scale = 1; p.armLift = 0.9; p.glowBoost = 0.7; p.braced = true; p.mouth = .focused
        case .refreshing: p.mouth = .focused; p.auraSpeed = 2.2; p.auraColor = AgentMotionColor.gold; p.glowBoost = 0.5
        case .celebrating: p.eyeHappy = true; p.mouth = .grin; p.armLift = 1
                           p.auraColor = AgentMotionColor.success; p.glowBoost = 0.8
        default: break
        }
        return p
    }

    var body: some View {
        if state.stageHeight > 0 {
            ZStack {
                // Portal edge — dark recess the character peeks from.
                LinearGradient(colors: [Color.black.opacity(0.35), .clear],
                               startPoint: .top, endPoint: .bottom)

                let reveal = min(1, state.stageHeight / AgentPullMath.threshold)
                if reduceMotion {
                    // RM fallback: simple progress ring, no acting.
                    Circle().trim(from: 0, to: max(0.04, state.progress))
                        .stroke(AgentMotionColor.violet, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .frame(width: 30, height: 30)
                } else {
                    // Live signal dots that drift toward the character with progress.
                    if case .idle = state.phase {} else if state.progress > 0.2 {
                        AgentParticleField(converge: state.progress,
                                           color: AgentMotionColor.mint,
                                           count: 3 + Int(state.progress * 4),
                                           clockStart: state.clockStart)
                            .frame(width: 190, height: 90)
                    }
                    LivingAgentCharacter(pose: pose, size: 58, clockStart: state.clockStart)
                        .modifier(AgentArmedWobble(active: state.phase == .armed))
                        // Peek: character rises from behind the top edge with reveal.
                        .offset(y: (1 - reveal) * -42)
                    if case .celebrating = state.phase {
                        AgentSuccessBurst(clockStart: state.clockStart).scaleEffect(0.6)
                    }
                }

                if case .armed = state.phase, state.stageHeight > 84 {
                    Text("Release to refresh")
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.65))
                        .offset(y: 34)
                        .transition(.opacity)
                }
            }
            .frame(height: state.stageHeight)
            .frame(maxWidth: .infinity)
            .clipped()
            .allowsHitTesting(false)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
        }
    }

    private var accessibilityText: String {
        switch state.phase {
        case .armed: return "ছাড়লে রিফ্রেশ হবে"
        case .refreshing: return "রিফ্রেশ হচ্ছে"
        case .celebrating: return "রিফ্রেশ সম্পন্ন"
        default: return "রিফ্রেশ করতে টেনে ধরুন"
        }
    }
}

/// Armed holding loop — small continuous wobble while the user holds.
@available(iOS 17.0, *)
private struct AgentArmedWobble: ViewModifier {
    let active: Bool
    func body(content: Content) -> some View {
        TimelineView(.animation(minimumInterval: 1.0 / 40.0, paused: !active)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            content
                .rotationEffect(.degrees(active ? sin(t * 9) * 2.4 : 0))
                .offset(y: active ? CGFloat(sin(t * 13)) * 1.4 : 0)
        }
    }
}

/// Scroll wiring — iOS 18+ scroll-geometry/phase APIs (supported path per spec).
/// On iOS 17 the modifier is inert: zero visual/behaviour change (= idle contract).
/// The stage lives in an .overlay(alignment: .top) revealed by the NATIVE bounce
/// translation of the content — no reserved layout space, no second scroll view.
@available(iOS 17.0, *)
struct AgentPullToRefreshModifier: ViewModifier {
    let state: AgentPullState
    let isEnabled: Bool
    let refresh: @MainActor () async throws -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .onScrollGeometryChange(for: CGFloat.self) { g in
                    // Raw top overscroll: how far the content is dragged below its
                    // resting top edge (rubber-band zone only).
                    max(0, -(g.contentOffset.y + g.contentInsets.top))
                } action: { _, raw in
                    guard isEnabled else { return }
                    state.dragChanged(rawPull: raw)
                }
                .onScrollPhaseChange { old, new in
                    guard isEnabled else { return }
                    // Finger lifted while armed → fire exactly once.
                    if old == .interacting, new != .interacting {
                        state.dragEnded(refresh: refresh)
                    }
                }
                // NOTE: the stage view itself is attached OUTSIDE .claudeTopFade
                // (by the host screen) — attached here it renders UNDER the top
                // fade's blur strip and washes out (sim-verified 2026-07-17).
        } else {
            // iOS 17: the scroll-geometry/phase APIs are unavailable, so fall back
            // to the system pull-refresh (no custom character). Keeps every host
            // page refreshable; the premium animation is an iOS-18+ enhancement.
            content.refreshable { try? await refresh() }
        }
    }
}

// MARK: - DEBUG selftests (house convention — no XCTest target in this project)

#if DEBUG
@available(iOS 17.0, *)
enum AgentAnimSelfTest {
    /// ALMA_ANIM_SELFTEST=1 — pure-logic assertions, results as perf signposts.
    @MainActor static func runIfRequested() {
        let p = ProcessInfo.processInfo
        guard p.environment["ALMA_ANIM_SELFTEST"] == "1"
            || p.arguments.contains("ALMA_ANIM_SELFTEST=1") else { return }
        var pass = 0, fail = 0
        func check(_ name: String, _ ok: Bool) {
            ok ? (pass += 1) : (fail += 1)
            AlmaPerfLog.event("animSelfTest.case", "\(ok ? "PASS" : "FAIL") \(name)")
        }
        // Pull math
        check("resistance", abs(AgentPullMath.resistedPull(raw: 100) - 58) < 0.0001)
        check("clamp-max", AgentPullMath.resistedPull(raw: 900) == AgentPullMath.maximumVisualPull)
        check("clamp-min", AgentPullMath.resistedPull(raw: -40) == 0)
        check("progress-1", AgentPullMath.progress(raw: AgentPullMath.threshold / AgentPullMath.resistance) >= 1)
        check("progress-0", AgentPullMath.progress(raw: 0) == 0)
        // Hysteresis
        check("arm-edge", AgentPullMath.armedEdge(current: false, progress: 1.0) == true)
        check("no-rearm", AgentPullMath.armedEdge(current: true, progress: 0.97) == nil)
        check("disarm-edge", AgentPullMath.armedEdge(current: true, progress: 0.93) == false)
        check("no-early-arm", AgentPullMath.armedEdge(current: false, progress: 0.99) == nil)
        // Awakening reducer
        check("awaken-order", AgentAwakeningReducer.next(after: .arriving, ready: false) == .greeting)
        check("finalize-loops", AgentAwakeningReducer.next(after: .finalizing, ready: false) == .finalizing)
        check("success-gated", AgentAwakeningReducer.next(after: .finalizing, ready: true) == .success)
        check("accelerate", AgentAwakeningReducer.accelerated(from: .searching, ready: true) == .success)
        check("no-early-accel", AgentAwakeningReducer.accelerated(from: .searching, ready: false) == nil)
        // Refresh-once guard
        let st = AgentPullState()
        st.dragChanged(rawPull: 400)                                  // arm
        let noop: @MainActor () async throws -> Void = {}
        let first = st.dragEnded(refresh: noop)                       // fires
        let second = st.dragEnded(refresh: noop)                      // must NOT fire (running)
        check("refresh-once", first == true && second == false)
        AlmaPerfLog.event("animSelfTest.result", "pass=\(pass) fail=\(fail)")
    }
}
#endif
