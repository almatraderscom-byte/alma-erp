//
//  ClaudeTopFade.swift
//  ALMA ERP — reusable "top scroll-edge fade" (the Claude iOS app's top-of-scroll look)
//
//  As content scrolls UP behind the floating header it progressively BLURS (stronger at
//  the very top, softer lower down) and DISSOLVES into the app background colour. There
//  is NO solid header bar — the fade itself is the visual separator.
//
//  ── WIRING (one-liner on any scrolling screen) ────────────────────────────────────────
//
//    // Screen with a native toolbar header (real SwiftUI .toolbar):
//    ScrollView { MessagesView() }
//        .claudeTopFade()                       // native iOS 26 edge effect + light scrim
//
//    // Screen with a CUSTOM floating header overlay (most ALMA screens):
//    ScrollView { MessagesView() }
//        .claudeTopFade(useNativeEdgeEffect: false)   // full masked-blur + colour dissolve
//        .overlay(alignment: .top) { FloatingHeaderView() }  // header floats ABOVE the fade
//
//  ── TUNING ────────────────────────────────────────────────────────────────────────────
//  • Fade height:   .claudeTopFade(height: 180) — default = FADE_HEIGHT token
//    (safe-area top + 88pt, ClaudeTopFadeTheme.fadeHeight; same number as the web).
//  • Scrim colours: edit ClaudeTopFadeTheme.lightScrim / .darkScrim below. They MUST stay
//    equal to the app background (AlmaTheme.rootBg: light #F2F0F8, dark #0b0a12 — the spec's
//    #F5EBDD placeholder was replaced with ALMA's real cream) or the dissolve shows a seam.
//  • Pass useNativeEdgeEffect: false whenever the screen's header is NOT a real .toolbar —
//    over a custom overlay the native effect may not paint where expected, and stacking
//    both would double-darken. The modifier never runs blur twice: native ON ⇒ colour-only
//    scrim; native OFF ⇒ masked blur + full scrim.
//
//  Self-contained: no third-party code. Safe on the app's iOS 16 deployment target — the
//  native .scrollEdgeEffectStyle path is availability-gated to iOS 26.
//

import SwiftUI
import UIKit

// MARK: - Theme tokens

/// ── SHARED DESIGN TOKENS — keep IN SYNC with the web twin
/// (src/components/layout/TopScrollFade.tsx + .module.css, mounted in app/layout.tsx):
///   FADE_HEIGHT = safe-area top inset + 88pt   (fadeBaseHeight below)
///   BLUR RAMP   = ~8px at the very top edge → 0 at the fade bottom
///   SCRIM       = the surface's own background (native: AlmaTheme.rootBg twins below;
///                 web: var(--bg-0)) so each surface dissolves into ITS page colour.
/// If any number changes, change BOTH sides (see NATIVE_MIGRATION_HANDOFF.md §7).
enum ClaudeTopFadeTheme {
    /// The 88 in "safe-area + 88" — the header zone below the notch, both surfaces.
    static let fadeBaseHeight: CGFloat = 88

    /// SCRIM_LIGHT #FAF9F6 — the light page base (web --bg-0; same value both surfaces).
    static let lightScrim = Color(red: 0.980, green: 0.976, blue: 0.965)
    /// SCRIM_DARK #1C1830 — the TOP of the dark "aura" gradient (indigo). NEVER a
    /// near-black here: on the dark theme a black-ish scrim reads as a shadow band
    /// (owner verdict 2026-07-06); the dissolve must come from blur + this bg-matched
    /// tint. Same value as the web scrim.
    static let darkScrim = Color(red: 0.110, green: 0.094, blue: 0.188)

    static func scrim(for scheme: ColorScheme) -> Color {
        scheme == .dark ? darkScrim : lightScrim
    }

    /// FADE_HEIGHT resolved: status-bar/notch inset + the 88pt header zone. Falls back
    /// to 59pt (Pro Max notch) if no window is attached yet — corrected on first layout.
    static var fadeHeight: CGFloat {
        let topInset = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow?.safeAreaInsets.top }
            .first ?? 59
        return topInset + fadeBaseHeight
    }
}

// MARK: - Masked variable blur (manual / custom-header path)

/// A material blur whose layer is masked by a vertical alpha gradient: full blur at the
/// very top → gone at the bottom. Fading the blur's OPACITY top→bottom fakes the native
/// variable-RADIUS look closely enough at header scale. UIKit-backed because SwiftUI has
/// no maskable UIVisualEffectView; .systemThinMaterial adapts to light/dark on its own
/// (the hosting SwiftUI environment's colorScheme reaches it via the trait collection).
private final class TopFadeBlurUIView: UIView {
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    private let fadeMask = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        addSubview(blur)
        stripTint()
        // Mask alpha = blur visibility: 1.0 at top, ~0.35 at 55%, 0 at bottom.
        fadeMask.colors = [
            UIColor.black.cgColor,
            UIColor.black.withAlphaComponent(0.35).cgColor,
            UIColor.clear.cgColor,
        ]
        fadeMask.locations = [0.0, 0.55, 1.0]
        fadeMask.startPoint = CGPoint(x: 0.5, y: 0)
        fadeMask.endPoint = CGPoint(x: 0.5, y: 1)
        blur.layer.mask = fadeMask
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    /// Same trick as AlmaGlassHeaderView: every UIKit material paints a TINT layer over
    /// the blur (dark band on the dark aura — exactly the "black shadow" the owner
    /// rejected). The gaussian lives in the Backdrop sublayer — hide the tint sublayers,
    /// keep PURE blur; the colour dissolve comes from the bg-matched scrim gradient only.
    private func stripTint() {
        for sub in blur.subviews where sub !== blur.contentView {
            if !String(describing: type(of: sub)).contains("Backdrop") {
                sub.isHidden = true
                sub.backgroundColor = .clear
            }
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        blur.frame = bounds
        stripTint()   // effect views rebuild sublayers on layout — re-strip
        // Mask layers don't autoresize — track bounds ourselves, without implicit animation.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fadeMask.frame = blur.bounds
        CATransaction.commit()
    }
}

private struct TopFadeBlur: UIViewRepresentable {
    func makeUIView(context: Context) -> TopFadeBlurUIView { TopFadeBlurUIView() }
    func updateUIView(_ uiView: TopFadeBlurUIView, context: Context) {}
}

// MARK: - The modifier

struct ClaudeTopFadeModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    var height: CGFloat
    var useNativeEdgeEffect: Bool

    /// True only when the caller asked for the native path AND the OS has it.
    private var nativeActive: Bool {
        if useNativeEdgeEffect, #available(iOS 26.0, *) { return true }
        return false
    }

    func body(content: Content) -> some View {
        nativeStyled(content)
            .overlay(alignment: .top) { fadeOverlay }
    }

    /// Native path: Apple's variable-radius Liquid Glass top edge effect (iOS 26).
    @ViewBuilder
    private func nativeStyled(_ content: Content) -> some View {
        if useNativeEdgeEffect, #available(iOS 26.0, *) {
            content.scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            content
        }
    }

    /// Manual overlay. Never eats touches; extends under the status bar.
    /// nativeActive ⇒ colour-only scrim (the native effect already blurs — adding our
    /// masked blur on top would double-darken the band). Native off ⇒ full treatment:
    /// masked blur UNDER a scrim gradient, so content both blurs AND colour-dissolves.
    private var fadeOverlay: some View {
        ZStack(alignment: .top) {
            if !nativeActive {
                TopFadeBlur()
            }
            LinearGradient(
                // SUBTLE scrim — max 0.45 (owner rule: 0.9 read as a heavy shadow; the
                // BLUR does the separating, the scrim only melts into the page colour).
                stops: nativeActive
                    ? [
                        .init(color: scrim.opacity(0.35), location: 0.0),
                        .init(color: scrim.opacity(0.0), location: 1.0),
                    ]
                    : [
                        .init(color: scrim.opacity(0.45), location: 0.0),
                        .init(color: scrim.opacity(0.22), location: 0.55),
                        .init(color: scrim.opacity(0.0), location: 1.0),
                    ],
                startPoint: .top, endPoint: .bottom
            )
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .allowsHitTesting(false)      // taps always reach the header / content below
        .ignoresSafeArea(edges: .top) // run up under the status bar
    }

    private var scrim: Color { ClaudeTopFadeTheme.scrim(for: colorScheme) }
}

extension View {
    /// Claude-style top scroll-edge fade — see the file header for wiring examples.
    /// - Parameters:
    ///   - height: fade depth in points (default = FADE_HEIGHT: safe-area top + 88).
    ///   - useNativeEdgeEffect: true for screens whose header is a real `.toolbar`
    ///     (uses iOS 26 `.scrollEdgeEffectStyle(.soft)` + a light scrim); false for
    ///     custom floating-header screens (full masked blur + colour dissolve).
    func claudeTopFade(height: CGFloat = ClaudeTopFadeTheme.fadeHeight,
                       useNativeEdgeEffect: Bool = true) -> some View {
        modifier(ClaudeTopFadeModifier(height: height, useNativeEdgeEffect: useNativeEdgeEffect))
    }
}

// MARK: - Demo / sim self-test

/// Long dummy list, scrolled to the middle, with a custom floating header — makes the
/// variable fade obvious. Also presented by the ALMA_FADE_DEMO simctl hook below.
@available(iOS 17.0, *)
struct ClaudeTopFadeDemo: View {
    @Environment(\.colorScheme) private var colorScheme
    var useNative = false

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(0..<60, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 14)
                        .fill(rowColor(i).opacity(colorScheme == .dark ? 0.45 : 0.75))
                        .frame(height: 64)
                        .overlay(alignment: .leading) {
                            Text("Row \(i)")
                                .font(.subheadline.weight(.semibold))
                                .padding(.leading, 16)
                        }
                        .padding(.horizontal, 16)
                }
            }
            .padding(.top, 120)
        }
        .defaultScrollAnchor(.center) // start mid-list so the top fade is visible at once
        .background(ClaudeTopFadeTheme.scrim(for: colorScheme))
        .claudeTopFade(useNativeEdgeEffect: useNative)
        .overlay(alignment: .top) {
            // Stand-in for a custom floating header — floats ABOVE the fade, taps intact.
            // (Hidden in the native variant: there the real .toolbar is the header.)
            if !useNative {
                Text("ALMA")
                    .font(.headline)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 10)
                    .background(.thinMaterial, in: Capsule())
            }
        }
    }

    private func rowColor(_ i: Int) -> Color {
        let palette: [Color] = [
            Color(red: 0.878, green: 0.478, blue: 0.373), // coral
            Color(red: 0.655, green: 0.545, blue: 0.980), // violet
            Color(red: 0.506, green: 0.698, blue: 0.604), // sage
        ]
        return palette[i % 3]
    }
}

/// DEBUG self-test hook (same pattern as ALMA_OPEN_COMPANION — never fires in production):
/// `simctl launch --env ALMA_FADE_DEMO=1 [ALMA_FADE_DEMO_DARK=1]` presents the demo full
/// screen so both themes can be screenshotted headlessly.
enum ClaudeTopFadeSelfTest {
    static func presentIfRequested(over host: UIViewController) {
        let env = ProcessInfo.processInfo.environment
        guard env["ALMA_FADE_DEMO"] == "1", #available(iOS 17.0, *) else { return }
        // ALMA_FADE_DEMO_NATIVE=1 → the .toolbar + native scroll-edge-effect variant.
        let vc: UIViewController
        if env["ALMA_FADE_DEMO_NATIVE"] == "1" {
            vc = UIHostingController(rootView: NavigationStack {
                ClaudeTopFadeDemo(useNative: true)
                    .navigationTitle("ALMA")
                    .navigationBarTitleDisplayMode(.inline)
            })
        } else {
            vc = UIHostingController(rootView: ClaudeTopFadeDemo())
        }
        vc.modalPresentationStyle = .fullScreen
        vc.overrideUserInterfaceStyle = env["ALMA_FADE_DEMO_DARK"] == "1" ? .dark : .light
        host.present(vc, animated: false)
    }
}

// MARK: - Previews (long list, mid-scroll, both themes)

@available(iOS 17.0, *)
#Preview("Custom header — Light") {
    ClaudeTopFadeDemo().preferredColorScheme(.light)
}

@available(iOS 17.0, *)
#Preview("Custom header — Dark") {
    ClaudeTopFadeDemo().preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Native toolbar — Light") {
    NavigationStack {
        ClaudeTopFadeDemo(useNative: true)
            .navigationTitle("ALMA")
            .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.light)
}
