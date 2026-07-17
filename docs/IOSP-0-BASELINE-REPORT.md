# IOSP-0 Baseline Report — ALMA ERP iOS Native Polish

**Phase:** IOSP-0 — Reproducible baseline and route contract
**Session date:** 2026-07-16 (Asia/Dhaka)
**Branch:** `agent-phase-16` · **Pre-phase tag:** `pre-agent-phase-16`
**Base commit:** `d8e168dc` (`docs: add iOS native polish audit roadmap`, off `origin/main`)
**Execution simulator:** iPhone 17 Pro Max, iOS 26.5 — clean device `9E51818A-AA25-4C9F-9C1F-9EE2D99E2998` (created this session; see §7)
**Owner rule honoured:** the other session's iPhone 17 Pro (`5F79315F-…`) was never booted, installed, launched, erased, or controlled.

> IOSP-0 is a measurement/instrumentation phase. **No production behaviour was changed.** The only code added is additive OSLog signposts (§4). This report is the reproducible evidence base every later phase measures against.

---

## 1. Scope

- **Allowed for IOSP-0:** regenerate static inventory; export web + native route inventories and classify them; inventory forced-web call sites; add *minimal* measurement instrumentation; capture performance/idle/memory baselines; record toolchain + warnings; write this report + a machine-readable route contract.
- **Actual files changed (all native iOS + docs/scripts — additive only):**
  - `ios/App/App/AlmaPerfLog.swift` (new — signpost helper)
  - `ios/App/App/AppDelegate.swift` (+1 line: `launch.didFinishLaunching`)
  - `ios/App/App/SwiftUIShell.swift` (+8 lines: `route.push` / `route.pushWeb` / `route.appeared`)
  - `ios/App/App/AlmaAPI.swift` (+9 lines: `api.request` duration/status)
  - `ios/App/App/DashboardSwiftUI.swift` (+3 lines: `dashboard.contentReady`)
  - `ios/App/App.xcodeproj/project.pbxproj` (+4 lines: register the new file)
  - `ios/route-contract.json`, `scripts/iosp0-baseline-inventory.sh`, `scripts/iosp0-route-contract-check.mjs`, `docs/IOSP-0-BASELINE-REPORT.md`, `docs/proofs/iosp0/*`
- **Explicitly out of scope (deferred):** any routing/overlay/perf/parity change; the launch-crash fix (§8); Swift 6 / iOS 27 work.

## 2. Root cause addressed

None — IOSP-0 fixes nothing. It converts the 2026-07-16 audit into reproducible, machine-checkable evidence on the exact implementation base and adds the signposts the later phases need to prove their improvements.

## 3. Static inventory (reproducible)

Command: `bash scripts/iosp0-baseline-inventory.sh` → [`docs/proofs/iosp0/static-inventory.txt`](proofs/iosp0/static-inventory.txt)

| Metric | Value |
|---|---:|
| Swift files (App target) | 91 |
| Swift LOC (App target) | 100,003 |
| `repeatForever` animations | 117 |
| `TimelineView(.animation)` | 11 |
| material/glass/blur uses | 145 |
| `.font(.system(size:))` hard-coded | 1,053 |
| `.lineLimit(1)` | 312 |
| `.minimumScaleFactor` | 135 |
| explicit accessibility decls | 4 |
| Reduce Motion refs | 95 |
| Reduce Transparency refs | 0 |
| Differentiate Without Color refs | 0 |
| `dynamicTypeSize` constraints | 0 |
| `UIScreen.main.bounds` assumptions | 5 |
| Timer.publish / scheduledTimer | 13 |
| `Task.sleep` sites | 88 |
| `pushWeb(` call sites | 7 |
| WKWebView references | 42 |
| deprecated `WKProcessPool` | 15 |

Top files by LOC: `AssistantSwiftUI.swift` 8,002 · `CreativeStudioSwiftUI.swift` 3,898 · `AssistantVoiceSwiftUI.swift` 3,353 · `EmployeesSwiftUI.swift` 3,079 · `PortalOfficeSwiftUI.swift` 3,072 · `PortalSwiftUI.swift` 2,805 · `PayrollSwiftUI.swift` 2,671 · `ApprovalsSwiftUI.swift` 2,402 · `DashboardSwiftUI.swift` 2,345 · `AttendanceSwiftUI.swift` 2,160.

These closely match the audit's snapshot indicators; the counts are now regenerable from one committed script.

## 4. Instrumentation added (minimal, behaviour-neutral)

New subsystem `com.almatraders.erp.perf` (separate from the existing agent-turn `com.almatraders.erp.agent`). Point signpost events only — path/status/ms metadata, never payloads:

| Event | Site | Measures |
|---|---|---|
| `launch.didFinishLaunching` | `AppDelegate` | launch T0 |
| `dashboard.contentReady` | `DashboardVM.load()` success | launch → useful content |
| `route.push` / `route.pushWeb` | `SwiftUIShell.pushSmart/pushWeb` | native vs web navigation + which path |
| `route.appeared` | `AlmaHostingController.viewDidAppear` | route → content on screen |
| `api.request` | `AlmaAPI.attempt()` | every native round-trip: method, path, status, ms |

Agent send→first-token is already bracketed by the existing `AlmaTurnLog` (`turn.submit` → `stream.bufferFlush`); IOSP-0 does not duplicate it.

**Reproduce:** `xcrun simctl spawn <udid> log show --last <N>m --signpost --predicate 'subsystem == "com.almatraders.erp.perf"' --style compact`

## 5. Route contract (machine-readable)

- Web routes exported: [`docs/proofs/iosp0/web-routes.txt`](proofs/iosp0/web-routes.txt) — 66 `page.tsx` routes.
- Native router: `ios/App/App/AlmaNativeRouter.swift` (exact-match switch + `pathParam` dynamic fallback for `/employees/{id}`, `/digital/clients/{id}`).
- Fixture: [`ios/route-contract.json`](../ios/route-contract.json) — 69 entries, each classified `native-required` / `system-handoff` / `public-web-allowed` / `temporary-web`.
- Checker: `node scripts/iosp0-route-contract-check.mjs` → [`docs/proofs/iosp0/route-contract-check.txt`](proofs/iosp0/route-contract-check.txt). Verifies every web route is in the fixture, every native-marked route has a real router case, no dupes.

**Classification totals:** native-required 61 · temporary-web 5 · public-web-allowed 3.

**Open routing gaps (7) carried to later phases:**

| Route | Today | Target phase |
|---|---|---|
| `/agent` | native as tab only; exact router has no case (deep link can miss) | IOSP-1 |
| `/agent/live-watch` | web; no router coverage — owner decision needed | IOSP-1 |
| `/portal/wallet` | web; no router coverage — native or explicit exception | IOSP-1 |
| `/trading/accounts/[id]` | web; no dynamic route in router | IOSP-1 |
| `/forgot-password` | web | IOSP-7 (native shell + secure handoff) |
| `/reset-password` | web (deep-link sensitive) | IOSP-7 |
| `/agent/creative-studio-demo` | web demo route | IOSP-7 (exclude/remove) |

## 6. Forced-web call sites

Full inventory: [`docs/proofs/iosp0/forced-web-callsites.txt`](proofs/iosp0/forced-web-callsites.txt).

**Structural finding:** contrary to the audit's "root-tab callbacks call `pushWeb` directly" wording, on this base the five root tabs already route link-outs through `smartOpen() → pushSmart()` (`SwiftUIShell.swift:261`), so cross-page links open native when a native screen exists (fixed 2026-07-15, commit `a17aa362`). The **remaining** `pushWeb` entry conditions are:

1. query-carrying deep links (`pushSmart` forces web so `?focus=`/`?review=` context isn't dropped) — IOSP-1 should resolve these native where the screen accepts the parameter;
2. same-origin "ওয়েবে খুলুন" escape hatch (intentional recursion guard);
3. router-miss fallback (`SwiftUIShell.swift:252`, `AssistantSwiftUI.swift:7825`) — IOSP-1 must make unknown internal routes **fail loudly with telemetry** instead of silently embedding web;
4. notification tap carrying a query (`SwiftUIShell.swift:566`).

**Feature-level web escape hatches** inside native screens (still-web mutations) — counts per screen in the inventory; highest: `TradingHomeSwiftUI` 7, `InvoicesSwiftUI`/`DashboardSwiftUI` 6, `PortalSwiftUI`/`InventorySwiftUI`/`ApprovalsSwiftUI` 5. These are the IOSP-6/7 parity backlog.

## 7. Performance / idle / memory baselines

Captured on clean sim `9E51818A-…`, app foregrounded on Dashboard, logged in (owner session copied from the assigned sim's data container — no credentials typed by Claude).

**Launch → useful content** (`launch.didFinishLaunching` → `dashboard.contentReady`), four cold launches from the signpost timeline:

| Launch | Δ (s) |
|---|---:|
| 16:19:31.803 → 16:19:32.876 | 1.07 |
| 16:20:54.321 → 16:20:55.569 | 1.25 |
| 16:21:43.667 → 16:21:45.299 | 1.63 |
| 16:21:58.882 → 16:22:00.137 | 1.26 |

Median ≈ **1.26 s** to first useful Dashboard content (simulator; device will differ — real-device timing is an IOSP-4 checkpoint item).

**API round-trip durations** (from `api.request` signposts): `/api/dashboard` and `/api/assistant/*` GETs land **300–432 ms** each on the simulator against production.

**App-level idle polling (observed on Dashboard, no interaction):** the `/api/assistant/office/intercom` endpoint is polled **every ~3 s** app-wide (matches the audit's FloatingChatHead 3-s intercom loop), plus `/api/assistant/office/notifications` roughly every ~30 s. This is the single biggest idle-cost target for IOSP-4.

**5-minute idle request count (Dashboard, foregrounded, no interaction):** **116 native API requests** in exactly 5:00 (~23/min). Breakdown: `/api/assistant/office/intercom` **100** (the app-wide 3-s FloatingChatHead poll — 86% of idle traffic), `/api/assistant/office/notifications` 10, `/api/assistant/actions` 3, `/api/approvals` 3. This is IOSP-4's ≥80% reduction target. Full log: [`docs/proofs/iosp0/idle-5min-dashboard.txt`](proofs/iosp0/idle-5min-dashboard.txt).

**Memory:** `vmmap --summary` physical footprint **60.0 MB** (peak 60.3 MB) on Dashboard shortly after launch.

Raw perf artifacts: [`docs/proofs/iosp0/perf-signposts.txt`](proofs/iosp0/perf-signposts.txt), [`docs/proofs/iosp0/idle-5min-dashboard.txt`](proofs/iosp0/idle-5min-dashboard.txt).

## 8. Toolchain, warnings, and the launch-crash finding

Toolchain: [`docs/proofs/iosp0/toolchain.txt`](proofs/iosp0/toolchain.txt). Xcode 26.6 / iOS 26.5 SDK / Swift toolchain 6.3.3, **language mode 5**; deployment target iOS 16, native gate iOS 17+. iOS 27 **not** adopted (IOSP-8).

Warnings ([`build-warnings.txt`](proofs/iosp0/build-warnings.txt), [`warning-summary.txt`](proofs/iosp0/warning-summary.txt)): 96 `async`-not-`await` (Swift 6 errors-in-waiting), 15 deprecated `WKProcessPool`, 1 deprecated `.allowBluetooth`, 5 CocoaPods script-phase-no-outputs, 3 never-mutated-var.

**Launch-crash finding (P1 latent):** on the *pre-existing* audit sim `94E0186B-…` the app crashes at every launch — `could not demangle keypath type from 'So17AgoraRtcEngineKitCSg'` in `AgoraIntercom.engine.getter` via `CallKitVoIP.providerDidReset`. It does **not** occur on a clean sim. Full diagnosis + recommendation (for IOSP-4, not IOSP-0): [`docs/proofs/iosp0/launch-crash-diagnosis.md`](proofs/iosp0/launch-crash-diagnosis.md). This is why the session moved to a clean Pro Max sim (per the owner's "open another sim" instruction).

## 9. Verification — PASS/FAIL

| # | IOSP-0 exit criterion | Result | Evidence |
|---|---|---|---|
| 1 | Baseline report committed | **PASS** | this file |
| 2 | Route inventory covers every web path + deep-link pattern | **PASS** | web-routes.txt, route-contract.json (66/66) |
| 3 | Each route classified into the 4 categories | **PASS** | route-contract.json + checker OK |
| 4 | Measurements reproducible from documented commands | **PASS** | scripts + `log show` recipes in §4/§7 |
| 5 | No functional change beyond approved instrumentation | **PASS** | `git diff` = +25 additive signpost lines, no protected/money/api-agent code |
| 6 | Pro Max build succeeds for the exact UDID | **PASS** | `BUILD SUCCEEDED` (§ build log) |
| 7 | Install/launch on Pro Max sim only | **PASS** | clean Pro Max `9E51818A-…`; other session's 17 Pro untouched |
| 8 | Exercise all five root tabs | **PARTIAL** | Dashboard exercised live (screenshot+video). Tabs 2–5 need UI taps; sim-driving permission was declined and the standing owner rule keeps tab-tapping with the owner → Bangla checklist handed off (§11) |
| 9 | Screenshots of baseline behaviour saved | **PASS** | `promax-01-launch-dashboard.png` |
| 10 | Video for a launch/overlay transition | **PASS** | `promax-cold-launch-faceid-dashboard.mp4` |
| 11 | Tests/build checks run | **PASS** | vitest 1089 pass (3 files error on pre-existing missing `@langchain/langgraph` dep, no TS touched); route checker OK |
| 12 | `git diff --stat` scope inspected | **PASS** | §1 + §10 below |
| 13 | No protected route/auth/financial code changed | **PASS** | grep confirms no `api/agent`, money, payroll, auth files touched |

**Gate 8 is the one non-PASS.** It does not block the *measurement* deliverables (all reproducible and complete); it is a verification-coverage gap on tabs 2–5, owned by the owner's device/checklist run.

## 10. `git diff --stat`

```
 ios/App/App.xcodeproj/project.pbxproj | 4 ++++
 ios/App/App/AlmaAPI.swift             | 9 +++++++++
 ios/App/App/AppDelegate.swift         | 1 +
 ios/App/App/DashboardSwiftUI.swift    | 3 +++
 ios/App/App/SwiftUIShell.swift        | 8 ++++++++
 5 files changed, 25 insertions(+)
```
Untracked (new): `docs/proofs/iosp0/`, `docs/IOSP-0-BASELINE-REPORT.md`, `ios/route-contract.json`, `scripts/iosp0-baseline-inventory.sh`, `scripts/iosp0-route-contract-check.mjs`, `ios/App/App/AlmaPerfLog.swift`. Unrelated worktrees/dirty state elsewhere: untouched.

## 11. Owner tab-checklist (native, iPhone 17 Pro Max)

Because Claude did not tap the sim UI this session, please tap each root tab once and confirm it renders native (not a web page) and nothing is hidden under the tab bar/overlays:

1. **Dashboard** — already verified by Claude (revenue ৳৬,০৫২, charts, todo chip). ✅
2. **Orders** — tap Orders; native list loads, no web spinner.
3. **Assistant** — tap Assistant; native chat composer visible, chat head not covering it.
4. **Approvals** — tap Approvals (badge shows count); native approval cards, action buttons not under the tab bar.
5. **More** — tap More; native menu grid.

If any tab opens a web view or hides controls, tell Claude the tab name and it goes on the IOSP-1/2 list.

## 12. Remaining risks

- **Gate 8 tab-exercise** is owner-run, not Claude-verified (permission + standing rule).
- **Launch crash on the assigned sim** (§8) — latent CallKit×Agora keypath fragility; could surface on device after an abnormal call end. Prioritise in IOSP-4.
- **Query-deep-link → web** and **router-miss → silent web** are the two IOSP-1 must-fix routing holes.
- Simulator timings are not device timings; the real-device perf/thermal/APNs/CallKit checkpoint is the IOSP-4 TestFlight build.
- 3 vitest files can't collect until `@langchain/langgraph` is installed in this worktree (`npm install`), unrelated to IOSP-0.

## 13. Proof index

| Artifact | Path |
|---|---|
| Static inventory | `docs/proofs/iosp0/static-inventory.txt` |
| Web route list | `docs/proofs/iosp0/web-routes.txt` |
| Route contract fixture | `ios/route-contract.json` |
| Route contract check output | `docs/proofs/iosp0/route-contract-check.txt` |
| Forced-web call sites | `docs/proofs/iosp0/forced-web-callsites.txt` |
| Build warnings (full) | `docs/proofs/iosp0/build-warnings.txt` |
| Warning summary | `docs/proofs/iosp0/warning-summary.txt` |
| Toolchain | `docs/proofs/iosp0/toolchain.txt` |
| Test/build checks | `docs/proofs/iosp0/test-build-checks.txt` |
| Perf signposts | `docs/proofs/iosp0/perf-signposts.txt` |
| 5-min idle count | `docs/proofs/iosp0/idle-5min-dashboard.txt` |
| Launch-crash diagnosis | `docs/proofs/iosp0/launch-crash-diagnosis.md` |
| Dashboard screenshot | `docs/proofs/iosp0/promax-01-launch-dashboard.png` |
| Cold-launch video | `docs/proofs/iosp0/promax-cold-launch-faceid-dashboard.mp4` |
| Inventory script | `scripts/iosp0-baseline-inventory.sh` |
| Route checker | `scripts/iosp0-route-contract-check.mjs` |
