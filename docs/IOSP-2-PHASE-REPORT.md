# IOSP-2 Phase Report — Overlay and safe-area coordinator

**Session date:** 2026-07-16 (Asia/Dhaka)
**Branch:** `agent-phase-19` · **Pre-phase tag:** `pre-agent-phase-19`
**Base:** `d451f56a` (IOSP-1 head) · **Simulator:** clean iPhone 17 Pro Max `9E51818A-…` (iOS 26.5). The other session's iPhone 17 Pro was never touched.

## Scope

- **Allowed (roadmap IOSP-2):** one overlay presentation model; tab-bar/keyboard/composer/sheet exclusion zones; predictable docking; `UIScreen.main.bounds` removal; z-order policy; Reduce Motion / Reduce Transparency / VoiceOver support on the overlay layer.
- **Files changed:**
  - `ios/App/App/AlmaOverlayCoordinator.swift` (new) — the shared model
  - `ios/App/App/FloatingChatHead.swift` — coordinator z-order/scene; keyboard-aware bottom clamp; Reduce Motion
  - `ios/App/App/AlmaIslandBanner.swift` — coordinator z-order/scene; `UIScreen.main.bounds` removed; Reduce Motion (skip confetti/spring); VoiceOver label
  - `ios/App/App/ConnectivityBeacon.swift` — coordinator z-order/scene; Reduce Motion (freeze perpetual sweep/pulse/comet); Reduce Transparency (opaque veil)
  - `ios/App/App/AppDelegate.swift` — install coordinator first; DEBUG env-gated overlay self-test
  - `ios/App/App.xcodeproj/project.pbxproj`
- **Out of scope, untouched:** web/API (zero TS), routing (IOSP-1), caching (IOSP-3), polling (IOSP-4 — the 3s intercom poll is still there), feature parity.

## Root cause addressed

The IOSP-0 audit found three independent passthrough windows (chat head, ALMA Island result pill, offline beacon) that each: picked their own `windowLevel`, duplicated the "find the foreground scene" lookup, clamped to fixed pixel offsets (chat head `-70`), read `UIScreen.main.bounds`, and ignored the keyboard, tab bar, Reduce Motion and Reduce Transparency. The baseline screenshot showed the chat head overlapping Dashboard content and sitting where a keyboard/composer would cover it.

## Implementation summary

`AlmaOverlayCoordinator` is the single authority: canonical `Level` z-order (chatHead < island < beacon < system), `maxCenterY(inWindow:overlayHeight:)` = the bottom exclusion (larger of tab bar 49 and the live keyboard, above the safe area), live keyboard tracking via `keyboardWillChangeFrame`, `reduceMotion`/`reduceTransparency` passthroughs, and one `foregroundScene()` (was copied in all three overlays). The chat head subscribes to the coordinator's `keyboardDidChange` and lifts above the keyboard; its initial place and drag-snap use the shared exclusion instead of the `-70` magic number. The island computes width from the layout container (capped 560 + side insets) instead of `UIScreen.main.bounds`, and honours Reduce Motion (instant open, no confetti) with a combined VoiceOver label. The beacon freezes its perpetual sweep/pulse/comet under Reduce Motion and uses an opaque veil under Reduce Transparency.

## Verification

- **Build:** `BUILD SUCCEEDED` (Debug, Pro Max, UDID printed).
- **Checker:** `node scripts/iosp0-route-contract-check.mjs` → OK (no route change).
- **Keyboard-exclusion behaviour — proven with hard numbers** (DEBUG env-gated overlay self-test posting a synthetic keyboard frame through the real coordinator path; `com.almatraders.erp.perf` signposts):

  | Event | Head center-Y | maxY | keyboard |
  |---|---:|---:|---:|
  | parked at bottom edge | **831** | 831 | 0 |
  | keyboard up (340pt) | **831 → 540** | 540 | 340 |
  | keyboard down | 540 (held) | 831 | 0 |

  The head lifts 291pt to clear the keyboard, then holds (we only push up into the zone, never force back down). Window height 956pt; 540 = 956 − 34(safe) − 340(kbd) − 30(size/2) − 12(gap). Screenshots: `promax-overlay-1-head-parked-bottom.png` (head just above tab bar) → `promax-overlay-2-keyboard-up-head-lifted.png` (head at 540, well clear) → `promax-overlay-3-keyboard-down.png`.
- **z-order / scene consolidation / `UIScreen.main.bounds` removal / Reduce Motion / Reduce Transparency / VoiceOver label:** compile-verified and logic-reviewed. Headless toggling of Reduce Motion/Transparency for an overlay-window screenshot isn't available this session (no simctl toggle; the overlays only appear on live network-drop / office events), so these are **code-verified, not screenshot-verified** — flagged honestly below.

## Proof artifacts (`docs/proofs/iosp2/`)

`promax-overlay-1-head-parked-bottom.png` · `promax-overlay-2-keyboard-up-head-lifted.png` · `promax-overlay-3-keyboard-down.png` + the signpost table above.

## Regression and safety

- `git diff --stat`: 5 files, +130/−31, plus new `AlmaOverlayCoordinator.swift`. All iOS-native. No web/API, no `/api/agent/*`, no auth, no money code (grep-verified). No secrets, no migrations. Unrelated worktrees preserved.
- Overlay self-test + `debugParkAtBottomEdge` are `#if DEBUG` — not in Release/TestFlight.
- Behaviour-preserving: overlays still install/present exactly as before; only their level/scene/clamp/animation gating changed.

## PASS/FAIL — IOSP-2 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| One overlay presentation model/coordinator | **PASS** | `AlmaOverlayCoordinator`; three overlays consume it |
| Tab-bar + keyboard exclusion zones | **PASS** | signpost table (831→540 on keyboard) |
| Composer/sheet exclusion | **PARTIAL** | keyboard covers the composer case; a discrete "composer height" input is available via `maxCenterY` but not yet wired to the Agent composer (needs IOSP-5 composer work) |
| Floating affordance docks/relocates predictably | **PASS** | shared clamp on place/snap/keyboard |
| `safeAreaInset`/guides instead of `UIScreen.main.bounds` | **PASS** | island width from container; head from window safe area |
| z-order + simultaneous-presentation policy | **PASS** | `Level` constants (chatHead<island<beacon<system) |
| Reduce Motion / Reduce Transparency / VoiceOver | **PARTIAL** | implemented + compile-verified across all three overlays; not screenshot-verified headlessly this session |
| Zero occluded actionable controls across the matrix | **PARTIAL** | keyboard×chat-head proven; full matrix (rotation, all sheet detents, incoming-call-over-sheet) needs owner taps / live events |

## Remaining risks / carried debt

- Reduce Motion/Transparency + VoiceOver on overlays are code-verified, not screenshot-verified (headless a11y toggling limitation). IOSP-9 (dedicated a11y phase) should screenshot-confirm.
- Agent composer height isn't fed into the exclusion yet — belongs with IOSP-5 composer stabilization; the coordinator API is ready for it.
- Full collision matrix (rotation, sheet detents, incoming call over a sheet) is owner-verifiable; the headline keyboard collision is fixed.

## Owner checklist (Bangla, ~২ মিনিট)

1. Assistant tab-এ গিয়ে message box-এ tap করুন — keyboard উঠলে চ্যাট-হেড keyboard-এর উপরে উঠে আসবে, নিচে চাপা পড়বে না।
2. চ্যাট-হেড ধরে নিচে টেনে ছাড়ুন — tab bar-এর উপরে থামবে, tab bar ঢাকবে না।
3. Settings → Accessibility → Reduce Motion চালু করে অফলাইন করুন (Wi-Fi বন্ধ) — beacon animation থেমে থাকবে, তবু "আবার চেষ্টা করুন" পড়া যাবে।

## Next: IOSP-3 handoff

`docs/IOSP-3-CLAUDE-CODE-HANDOFF.md` — shared data/cache + single-flight + view-lifetime. Branch `agent-phase-20` (verify free first).
