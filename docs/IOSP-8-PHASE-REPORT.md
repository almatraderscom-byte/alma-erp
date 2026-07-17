# IOSP-8 Phase Report — Xcode 27 / iOS 27 modernization (doable-now subset)

Branch `agent-phase-25`, tag `pre-agent-phase-25`, base = IOSP-7 tip `bbe6949d`.
Toolchain at execution time: **Xcode 26.6 / iOS 26.5 SDK / Swift 6.3.3** (Xcode 27 NOT installed — see Owner-blocked).

## What was done (toolchain-independent subset)

### 1. WKProcessPool fully removed (9 warning sites → 0)
`WKProcessPool` has been a no-op since iOS 15 (deployment target is 16.0), so the
entire pool-plumbing was dead code. Removed the stored pools and `processPool:`
init parameters from `AlmaWebTabViewController`, `AlmaCompanionViewController`,
`CompanionScreen`, `MoreMenuViewController`, and the `AlmaTabBarController.contentPool`
property + all call sites (SwiftUIShell, AssistantSwiftUI, SpikeNativeShell).
Session/login sharing was never the pool's doing — it comes from
`websiteDataStore = .default()`, which every webview already sets (comments corrected).

### 2. Swift 6 readiness: async-not-awaited 96 → 0
All 96 were one pattern: haptic feedback generator calls
(`UINotificationFeedbackGenerator` ×94, `UIImpactFeedbackGenerator` ×2) inside
17 view-model classes that were `@Observable` but **not** `@MainActor`.
Root cause fixed rather than symptom: the 17 VMs are now `@MainActor`
(ApprovalsVM, AttendanceVM, OwnerTodoVM, EmployeesVM, EmployeeDetailVM, ExpensesVM,
InventoryVM, InvoicesVM, OfficeFundVM, OrdersVM, PayrollVM, PortalExpenseVM,
PortalOfficeVM, PortalVM, SettingsNotifVM, StaffMonitorControlsVM, TaskSpotlightVM).
This also fixes a latent thread-safety bug: these VMs mutate SwiftUI-observed state
from nonisolated async contexts. Networking stays off the main thread
(`AlmaAPI.send` is a nonisolated async call — awaiting it suspends, not blocks).
Cascade from the annotation was exactly one compile error
(PayrollScreen's PDF renderer closure reading `vm.businessId`) — fixed by hoisting
the value out of the closure, same pattern the code already used for `rows`.
Swift language mode remains 5 (roadmap forbids a one-shot flip to 6).

### 3. Deprecated `.allowBluetooth` → `.allowBluetoothHFP` (1 → 0)
`AgoraIntercom.configureAudioSession()`. Verified in the SDK header: same raw
value (0x4), available since iOS 1.0 — a pure rename, zero behaviour change.

### 4. never-mutated `var` → `let` (3 → 0)
AssistantSwiftUI.swift lines 2464/2728/2886.

## Warning count before/after (both CLEAN builds, deduped file:line:col)

| category | before | after |
|---|---|---|
| WKProcessPool deprecated | 9 | **0** |
| async-not-awaited (Swift 6 error-to-be) | 96 | **0** |
| allowBluetooth deprecated | 1 | **0** |
| never-mutated var | 3 | **0** |
| non-Sendable capture | 3 | 3 (see below) |
| CocoaPods script-phase no outputs | 5 | 5 (see below) |

No new warning kinds introduced (verified by diffing unique warning texts).
Full table: `docs/proofs/iosp8/warning-before-after.txt`.

## Verification (Pro Max sim `9E51818A-…`, fresh install of the clean build)

- BUILD SUCCEEDED, 0 errors. App launches; login session intact after the
  WKProcessPool removal (the phase's biggest risk) — Dashboard shows live revenue.
- Screens owned by re-isolated VMs exercised live with real data:
  Orders, Approvals (Face ID unlock), Payroll (14 sites — liability/bonus/deduction
  figures render), Portal Office (17 sites — approvals/tasks/staff-online counts),
  More, Agent Companion (pairing dialog + webview, no pool).
  Proofs: `docs/proofs/iosp8/*.png`.
- No crash reports, no hang/watchdog events in the sim log during the drive.
- Observed (pre-existing, NOT from this phase): two authenticated endpoints
  (`/api/assistant/office/notifications`, `…/intercom`) timed out at the 20 s client
  limit; also hit from an untouched file (AlmaIslandBanner) and the unauth server
  answers in ~0.5 s — server-side slowness, flagged for IOSP-9 regression watch.

## Deliberately NOT done (with reasons)

- **CocoaPods script-phase warnings (5):** the fix lives in the Podfile
  post_install / regenerated `Pods.xcodeproj`, not in this repo's source. Touching
  pod-generated project files risks the CI signing pipeline (PR #389 lesson) for a
  cosmetic warning. Defer to a Pods-regeneration moment (e.g. next pod update).
- **non-Sendable captures (3):** ConnectivityBeacon (2) and PortalGpsOnce (1) are
  Timer/CLLocation delegate captures that need a small redesign (Sendable wrapper or
  actor hop) — not mechanical, low value under language mode 5, deferred to the
  Swift-6-mode migration.
- **"Private implementation-class introspection" (handoff item): NOT APPLICABLE.**
  Audited: zero `NSClassFromString`/`setValue(forKey:)`/private-API calls exist.
  The only introspection is `AlmaGlassHeaderView.stripTint()` matching subview class
  NAMES by substring — an owner-locked design (pure frosted glass, 2026-07-05) that
  degrades safely to a stock blur. Its real replacement is Liquid Glass = the
  owner-blocked Xcode 27 work.

## Owner-blocked (requires Xcode 27 + iOS 27 runtime — not installed)

Xcode 27 rebuild + new-warning inventory; Liquid Glass adoption for
controls/navigation (would replace AlmaGlassHeaderView's stripTint); new SwiftUI
iOS-27 APIs; iOS-27-simulator regression pass. **Owner action: install Xcode 27 +
iOS 27 simulator runtime, then rerun this phase's blocked half.**

## Files changed

22 Swift files under `ios/App/App/` only (43+/34−). No web, no `/api/agent/*`,
no migrations, no Pods. (Separate commit on this branch: `vercel.json` +
`scripts/vercel-skip-ios-only.sh` — owner-requested build-queue fix, not IOSP-8.)

## PASS/FAIL checklist

- [PASS] Clean build 0 errors, target warnings zeroed, no new warning kinds
- [PASS] Sim drive of all touched high-site screens with live data + screenshots
- [PASS] Login/session survives WKProcessPool removal
- [PASS] No crash logs / hang events during verification
- [PASS] `git diff --stat` scope check (iOS-only for the phase commit)
- [FAIL→blocked] iOS 27 API adoption — toolchain absent (owner install required)

## Next: IOSP-9

See `docs/IOSP-9-CLAUDE-CODE-HANDOFF.md`.
