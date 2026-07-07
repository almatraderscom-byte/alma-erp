import styles from './TopScrollFade.module.css'

/**
 * TopScrollFade — the web half of the app-wide "scroll-edge progressive blur".
 *
 * As content scrolls up behind the floating header it blurs with a VARIABLE radius
 * (strong at the very top edge, softening downward) and dissolves into the page
 * background — no solid header bar; the fade IS the separator. The native SwiftUI
 * screens draw the identical effect via ClaudeTopFade.swift, so switching between a
 * native page and a web page shows no seam.
 *
 * ── SHARED DESIGN TOKENS (keep IN SYNC with ios/App/App/ClaudeTopFade.swift) ──
 *   FADE_HEIGHT = env(safe-area-inset-top) + 88px
 *   SCRIM       = var(--bg-0)  (light #FAF9F6 / dark #141418 — the page's own bg;
 *                 native uses its AlmaTheme twin so each surface dissolves into
 *                 its OWN background with zero hard line)
 *   BLUR RAMP   = 8px at the top edge → 0 at the fade bottom (5 masked layers)
 * If any number changes, change it on BOTH surfaces (see NATIVE_MIGRATION_HANDOFF §7).
 *
 * Variable radius is faked with a STACK of masked backdrop-filter layers — a single
 * backdrop-filter is uniform and reads as a flat band. Each layer's mask reveals a
 * window higher up than the previous, so stronger blurs show only near the top.
 *
 * GATED: rendered only inside the native iOS shell (html.alma-native, injected by
 * NativeShellBridge) — desktop / mobile-web keep their existing sticky headers and
 * see nothing. Mounted ONCE in app/layout.tsx so every route gets it.
 * pointer-events: none — taps always pass through; header controls live elsewhere.
 *
 * iOS 27: the wrapper also carries the global `.lg-scroll-edge` token class
 * (src/styles/ios27.css — Scroll Edge Effect, blur radius var(--lg-scroll-edge-blur)
 * = 10px with a 40%→100% mask fade). It layers the kit's progressive edge blur on
 * top of the existing ramp; same height/position/z-index/gating (the CSS-module
 * `html.alma-native` gate still controls display, so web/desktop see nothing).
 */
export default function TopScrollFade() {
  return (
    <div className={`${styles.fade} lg-scroll-edge`} aria-hidden="true">
      <span className={`${styles.layer} ${styles.b1}`} />
      <span className={`${styles.layer} ${styles.b2}`} />
      <span className={`${styles.layer} ${styles.b3}`} />
      <span className={`${styles.layer} ${styles.b4}`} />
      <span className={`${styles.layer} ${styles.b5}`} />
      <span className={styles.scrim} />
    </div>
  )
}
