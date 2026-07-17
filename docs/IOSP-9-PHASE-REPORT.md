# IOSP-9 Phase Report — Accessibility + visual consistency + final regression (FINAL PHASE)

Branch `agent-phase-26`, tag `pre-agent-phase-26`, base = IOSP-8 tip `9e7e03f1`.
Toolchain: Xcode 26.6 / iOS 26.5 (Xcode 27 track remains owner-blocked, carried forward).

## 1. Accessibility work

### VoiceOver labels — 29 icon-only controls labelled (was: 6 a11y annotations app-wide)
- `glassBarButton` / `coralBarButton` factories now REQUIRE a `label:` (compiler-enforced
  for future call sites); all 5 nav-bar sites labelled (চ্যাট হিস্টরি / নতুন চ্যাট / পেছনে).
- 24 SwiftUI icon-only buttons labelled in Bangla across 10 files: attachment/image
  removals, delete/confirm-delete, search-clear, pager prev/next, sheet closes,
  password show/hide, subscription add/edit, todo delete.
  Decorative row-chevrons were deliberately NOT labelled (the row itself carries text).
- Tab bar, Approve/Reject, FloatingChatHead already had text/labels — untouched.

### Dynamic Type (targeted, per roadmap "critical screens")
- Verified at `accessibility-extra-extra-extra-large` on the money screens:
  Dashboard (revenue card), Payroll (budget/liability/bonus/deduction), Orders,
  Approvals, Trading accounts. **No money figure clips** — proofs in
  `docs/proofs/iosp9/promax-ax3xl-*.png`.
- One real break found and fixed: filter/business chips hyphenated into tall ovals
  at AX sizes ("Trad-ing"). Fix = `lineLimit(1).minimumScaleFactor(0.5)` applied to
  the 7 chip factories (Payroll, PortalExpense, DigitalInvoices, SettingsUsers,
  SupplierImport, Employees, TradingAnalytics). Before/after screenshots captured.
- Full semantic-typography migration (1000+ fixed-size sites) deliberately NOT
  attempted in the last phase — deferred to the Xcode-27/Liquid-Glass pass where
  type ramps get re-derived anyway. Fixed sizes render correctly at AX sizes today.

### Reduce Motion — sweep completed
- Codebase-wide sweep: every `repeatForever` animation checked. Only 3 sites app-wide
  lacked a gate (all other files already gate via the IOSP-2/5 aurora pattern):
  IntercomUI call-orb pulse ×2, Voice console LIVE blink ×1 — now gated on
  `UIAccessibility.isReduceMotionEnabled`.

## 2. Visual consistency
- Chip normalization above is the consistency fix (same one-line pill behaviour on
  all 7 screens). No other drift found against AlmaSwiftTheme tokens on the driven
  screens; no redesign attempted (locked owner specs respected).
- Light/dark: the app follows its OWN persisted theme (web-synced `alma-theme-mode`),
  by design — system-appearance flips do not restyle it, matching baseline behaviour.
  Owner's stored theme is dark; both palettes exist in code. In-app toggle remains
  the owner-visible switch (device checklist item).

## 3. Final regression (vs IOSP-0 baseline, same sim `9E51818A-…`)

| Check | Result |
|---|---|
| Route-contract checker | **PASS** — 69 cover 66; 5 open gaps all sanctioned (IOSP-7 ledger) |
| Nav contract self-test | **PASS** — /trading/accounts→native(live ৳16.1K), /agent→tab root, /portal/wallet→allowed web, unknown→fail-loud Bangla alert |
| 5-min foreground idle | **116 requests = baseline 116** (unchanged by design — foreground 3s intercom poll is IOSP-4's documented exception) |
| Backgrounded 75 s | **0 intercom polls** — IOSP-4 scene-suspend intact |
| Cache self-test (IOSP-3) | **PASS** — concurrent single-flight + TTL events |
| CallKit crash-repro (IOSP-4) | **PASS** — `callResetRepro.start→survived`, no crash report |
| Clean build | **BUILD SUCCEEDED**, 0 errors, warning inventory unchanged from IOSP-8 (all target categories still 0) |
| Crash logs during phase | none |

Evidence: `docs/proofs/iosp9/` (screenshots + `final-regression-summary.txt` + idle signpost log).

## 4. Watch item from IOSP-8
`/api/assistant/office/{notifications,intercom}` authed slowness (>20 s on 2026-07-16):
**not reproduced today** — intercom answering in ~0.3–0.5 s throughout the 5-min
sample. Treat as transient server-side; no iOS change needed.

## 5. Owner checklist
`docs/IOSP-FINAL-OWNER-CHECKLIST-BN.md` — Bangla, ~15 min, covers launch/login,
5 tabs, money screens, agent chat/voice, push/call (device-only), and an optional
accessibility pass. For the ONE final TestFlight build (per batching rule).

## 6. Files changed
iOS-only: 20 Swift files (a11y labels, chip guards, Reduce-Motion gates) + docs/proofs.
No web code, no `/api/agent/*`, no migrations, no Pods.

## PASS/FAIL — exit criteria (roadmap §IOSP-9)
- [PASS] No open P0/P1 (IOSP-0's two P1s fixed in IOSP-1/IOSP-4 and re-proven today)
- [PASS] All phase reports + proofs linked (`docs/IOSP-{0..9}-*`, `docs/proofs/iosp{0..9}/`)
- [PASS] Honest, reproducible perf comparison (same sim, same 5-min window, same signposts)
- [PASS] All internal routes meet classification (checker green; exceptions ledgered)
- [BLOCKED→owner] Final TestFlight + device checklist — owner-triggered CI build
- [BLOCKED→owner] Release/merge approval

## Roadmap status after this phase
**IOSP-0..9 COMPLETE on the Xcode-26.6 track.** Remaining program work, all owner-gated:
1. Owner: trigger the ONE TestFlight build (CI pipeline) → run the Bangla checklist.
2. Owner: install Xcode 27 + iOS 27 runtime → rerun the IOSP-8 blocked half
   (new-warning inventory, Liquid Glass, iOS-27 SwiftUI APIs, iOS-27-sim regression).
3. Deep cross-phase audit (owner-requested 2026-07-17) — next session's task.
