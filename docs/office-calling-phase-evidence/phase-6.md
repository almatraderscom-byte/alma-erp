# Office Calling Phase 6 Evidence — Unified call UI/UX and accessibility

Date: 2026-07-18 (Asia/Dhaka)
Branch: `agent/office-calling-whatsapp`
Implementation commit: `5b1b61f476cd238e28bfbf8353f0bdf8eae4044c`

## Gate result

`ENGINEERING PASS / DEVICE DEFERRED`

This is not a production/release PASS. Manual VoiceOver/TalkBack, font-scaling,
RTL, audio-route and real incoming/outgoing interaction rows remain in the
single Phase 8 physical-device matrix.

## Implemented contract

- Web, native iOS and native Android expose a dedicated Office Calls entry; the
  call experience is no longer discoverable only through the chat drawer.
- All three surfaces explicitly separate App voice call, mobile `tel:` call,
  recorded PTT and live office walkie-talkie. Labels no longer imply these are
  the same transport or persistence model.
- Canonical call state, direction, outcome and duration feed a common recent-call
  presentation. Active, reconnecting, completed, declined, busy, failed and
  missed outcomes are distinguishable without relying on color alone.
- Web has a responsive modal/bottom-sheet Calls panel, keyboard/backdrop close,
  focus restoration, permission guidance, staff/owner targets and 44px live-call
  controls. The minimized live-call surface no longer nests interactive buttons.
- iOS has a first-class SwiftUI Calls card and sheet, Dynamic Type-compatible
  layouts, VoiceOver labels/hints, reduced-motion behavior and a direct Settings
  recovery action for microphone denial.
- Android has a first-class Compose Calls card/sheet, 48dp minimum actionable
  targets, merged semantics, settings recovery, a scrollable small-screen layout
  and TalkBack descriptions for PTT/live/call-state controls.
- A source-level cross-platform UI contract test checks entry points, vocabulary,
  history/duration, accessibility labels, touch targets, settings recovery,
  reduced motion and WCAG contrast. A deterministic snapshot generator records
  the intended code-surface contract for review.

## Hard verification

| Gate | Result |
|---|---|
| Calling Vitest suite | PASS — 7 files, 45 tests |
| `npm run type-check` | PASS |
| Changed web/source ESLint | PASS — zero errors; snapshot script is intentionally ignored by the repository lint pattern |
| `git diff --check` | PASS |
| Production `npm run build` | PASS — compiled successfully; 377 static pages generated |
| Android `:app:compileDebugKotlin :app:testDebugUnitTest` | PASS — Android Studio JBR/installed SDK, `BUILD SUCCESSFUL` |
| iOS fresh universal Debug simulator build | PASS — arm64 + x86_64, `** BUILD SUCCEEDED **` |
| iOS post-entry incremental build | PASS — dedicated Office Calls card included, `** BUILD SUCCEEDED **` |
| iOS latest-build simulator launch | PASS — `com.almatraders.erp` launched on iPhone 17 Pro Max / iOS 26.5 |
| iOS runtime accessibility-tree inspection | PASS — dedicated entry exposed label/hint; opened sheet exposed close control, heading, four communication modes and recent-call empty state |
| Deterministic cross-surface screenshots | PASS — web, iOS and Android contract PNGs generated and visually inspected |

The production build emitted existing OpenTelemetry dynamic-require warnings,
missing-local-`DATABASE_URL` notices and two unauthenticated approval warnings
during static generation. It completed successfully; none originated in the
calling changes.

## Evidence assets

- `phase-6-assets/ios-calls-runtime.png` — actual latest native iOS simulator
  Calls sheet after navigation through the dedicated entry.
- `phase-6-assets/web-calls-contract.png` — deterministic web UI contract.
- `phase-6-assets/ios-calls-contract.png` — deterministic iOS UI contract.
- `phase-6-assets/android-calls-contract.png` — deterministic Android UI contract.
- `phase-6-assets/ios-simulator-launch.png` — native launch/build provenance.
- `scripts/office-call-ui-snapshots.mjs` — reproducible snapshot generator.

## Device deferrals and truthful limitations

- No Android AVD is configured on this Mac, so a latest-build Android runtime
  screenshot is not fabricated. Native Kotlin compilation, unit tests, manifest
  checks from Phase 4 and the cross-surface source contract are the available
  engineering gates; physical Android runtime verification is Phase 8.
- The iOS simulator proves layout/navigation/accessibility metadata but cannot
  prove PushKit/CallKit delivery, Bluetooth/GSM routing or background process
  survival.
- Manual VoiceOver/TalkBack traversal, maximum system font size, increased
  contrast, RTL/Bangla, one-handed reach and screen-reader call handling must run
  on the finished signed builds in Phase 8.

## Phase signature

`PHASE 6: ENGINEERING PASS / DEVICE DEFERRED — Codex — 2026-07-18 Asia/Dhaka`

Phase 7 starts automatically under the fixed execution goal.
