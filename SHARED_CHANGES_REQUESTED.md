# SHARED CHANGES QUEUE (append-only)

Parallel page sessions may NOT edit frozen/shared files (NATIVE_MIGRATION_HANDOFF.md §2).
Instead they APPEND a request here and keep working. The OWNER applies these centrally,
serially, between sessions, then marks them ✅ APPLIED (with commit hash).

**Never rewrite or delete another session's entry. Add yours at the bottom.**

## Entry format (copy this block)

```
### [PENDING] <page-slug> — <one-line title>
- Session: native/<page-slug>   Date: YYYY-MM-DD
- File(s): <exact frozen file path(s)>
- Exact change: <precise diff-level description — e.g. the 4 pbxproj entries for
  ios/App/App/FooSwiftUI.swift, or "add More-menu row X → FooScreen">
- Why: <one sentence — what breaks without it>
```

Owner flips `[PENDING]` → `[✅ APPLIED <commit>]` or `[❌ REJECTED — reason]`.

---

## Queue

### [✅ APPLIED — same commit as AssistantSwiftUI.swift] agent-chat — S6b native Assistant wiring (FYI, no action needed)
- Session: assistant session (direct owner instruction 2026-07-06, predates this queue)   Date: 2026-07-06
- File(s): `ios/App/App.xcodeproj/project.pbxproj`, `ios/App/App/SpikeNativeShell.swift`, `ios/App/App/SwiftUIShell.swift`
- Exact change: pbxproj = 4 additive entries for AssistantSwiftUI.swift (ids `…A021`/`…B021`,
  deliberately gapped from the …A015 series to avoid id collisions); SpikeNativeShell = the
  inline Assistant web-tab construction in `AlmaTabBarController.init` replaced by
  `makeAssistantTab()` (the old construction moved VERBATIM into that builder's else-branch in
  AssistantSwiftUI.swift); SwiftUIShell = `onSwiftUIFlagChanged` now also swaps `vcs[2]`.
- Why: the owner directly instructed the Assistant section be migrated native in a parallel
  session; these shared edits were applied + sim-verified (both themes, E2E streamed turn,
  flag-off web fallback) and REBASED onto build-36 before pushing — logged here so the
  integrator knows the pbxproj/shell deltas on the branch are intentional.

### [✅ APPLIED — commit 57cb5c2c] agent-chat — AssistantVoiceSwiftUI.swift pbxproj registration (FYI)
- Session: assistant session   Date: 2026-07-06
- File(s): `ios/App/App.xcodeproj/project.pbxproj`
- Exact change: 4 additive entries for `AssistantVoiceSwiftUI.swift` (ids `…A022`/`…B022`).
- Why: the native voice-to-voice orb console (owner bundle design) lives in its own file.

---
## 2026-07-06 · approvals/marathon session (owner-directed)
- **Owner instruction (2026-07-06, chat):** merge `native/approvals-parity` into the frontier; then migrate ALL remaining Alma Lifestyle pages native (aurora + current components), session acts as owner for decisions; ONE build at the very end.
- APPLIED on `native/approvals-parity` (acting owner): `AlmaNativeRouter.swift` (new, A040/B040) + `SwiftUIShell.swift` `pushSmart` hook (More rows route to native screens when migrated; forced-web escape prevents recursion).
- **pbxproj ID range reserved for this marathon: A040–A07F / B040–B07F** — other sessions please allocate below/above this range.
- Marathon page files will be registered incrementally on this branch; final integration merge + sim-verified build happens at the end of the marathon.

---
## 2026-07-06 · native/dashboard session (owner-directed — freeze on `/` lifted)

**Owner instruction (2026-07-06, chat):** lift the `FROZEN_CAPACITOR` freeze on the Lifestyle
home dashboard (`/`) and migrate it to native SwiftUI (`DashboardSwiftUI.swift`), keeping every
component + the exact theme; owner/admin scope only; verify N1–N5 push/reminders still fire;
do NOT build until the owner confirms. Owned file `DashboardSwiftUI.swift` is on branch
`native/dashboard`. **pbxproj ID range requested for this file: A080/B080** (above the marathon's
reserved A040–A07F range, to avoid collisions).

### [✅ APPLIED on branch — owner told dashboard session to do both items itself, 2026-07-07] dashboard — additive `/api/dashboard` fields for native parity
- Session: native/dashboard   Date: 2026-07-06 (applied 2026-07-07)
- File(s): `src/lib/lifestyle/dashboard.ts`, `src/types/index.ts` (web/ERP code — owner-directed exception)
- Exact change: in `metricsToDashboard()`, add to the returned object:
  `daily_trend: metrics.daily_trend,` and `top_products: metrics.top_products,` — and stop
  stripping `pending_count` from `kpis` (currently `const { pending_count: _pc, cod_amount: _cod, ...kpis } = metrics.kpis`
  drops it; keep `pending_count` in the returned `kpis`). Purely additive — no existing field changes.
- Why: the native dashboard renders **Daily Sales**, **Top Products**, and the **Pending** KPI
  from these fields. Without them those three blocks show their empty state. The web `/` page
  aggregates client-side so it never noticed the omission; the web dashboard does not read this
  route, so adding fields cannot break it. The Swift model decodes them optional-with-default, so
  the app is correct both before and after this change (blocks just fill in once it lands).

### [✅ APPLIED on branch — owner told dashboard session to do both items itself, 2026-07-07] dashboard — native home-tab wiring (frozen shell + pbxproj)
- Session: native/dashboard   Date: 2026-07-06 (applied + sim-verified 2026-07-07)
- File(s): `ios/App/App.xcodeproj/project.pbxproj`, `ios/App/App/SwiftUIShell.swift`, `ios/App/App/SpikeNativeShell.swift`, `ios/App/App/AlmaNativeRouter.swift`
- Exact change: (1) pbxproj = 4 additive entries for `DashboardSwiftUI.swift` (ids `…A080`/`…B080`).
  (2) SwiftUIShell = new `makeDashboardTab()` + `detachDashboardVC()`; `onSwiftUIFlagChanged` now
  also swaps `vcs[0]`. (3) SpikeNativeShell = `dashboardVC` made internal (was `private`) so the
  builder can mount it; `vcs[0]` init uses `makeDashboardTab()`; viewDidAppear gained the
  `ALMA_DASH_APPEARANCE` debug hook (env-guarded, same pattern as `ALMA_OPEN_TAB`).
  (4) AlmaNativeRouter = `case "/", "/dashboard": DashboardScreen`.
- **Key design (the reason `/` was frozen):** the native `DashboardScreen` does NOT replace the
  Capacitor bridge — `DashboardHostController` (in `DashboardSwiftUI.swift`) mounts the Capacitor
  VC BEHIND the native dashboard (loaded + in-hierarchy, interaction disabled) so
  `capacitorDidLoad()` + the ERP webview keep driving push / reminders / the N1–N5 bridges. The
  native host has an OPAQUE app-colour backing so the webview can never bleed through on scroll
  (a real z-order bug caught + fixed during sim verification).
- Status: applied on `native/dashboard`, sim-built (iPhone 17 Pro Max) and verified light+dark with
  live production data. Owner will review before any TestFlight upload.
