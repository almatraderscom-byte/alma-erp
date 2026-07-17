# IOSP-1 Phase Report — Single native navigation coordinator

**Session date:** 2026-07-16 (Asia/Dhaka)
**Branch:** `agent-phase-18` · **Pre-phase tag:** `pre-agent-phase-18` (phase-17 was already taken by another session's work)
**Base:** `ae9824dc` (IOSP-0 head) · **Baseline:** `docs/IOSP-0-BASELINE-REPORT.md`
**Simulator:** clean iPhone 17 Pro Max `9E51818A-AA25-4C9F-9C1F-9EE2D99E2998` (iOS 26.5). The other session's iPhone 17 Pro was never touched. (The roadmap-assigned Pro Max `94E0186B-…` still launch-crashes — IOSP-0 report §8 — so the owner-approved fresh sim was used.)

## Scope

- **Allowed (roadmap IOSP-1):** one typed navigation coordinator; replace direct `pushWeb` for internal routes; typed dynamic routes (employee ✓ pre-existing, CDIT client ✓ pre-existing, trading account **added**); `/agent` mapping; classify `/agent/live-watch` + `/portal/wallet`; structured routing-failure telemetry; query-deep-link policy; navigation contract tests. No feature parity beyond routing.
- **Actual files changed:**
  - `ios/App/App/AlmaNavCoordinator.swift` (new) — the single typed decision point
  - `ios/App/App/SwiftUIShell.swift` — `pushSmart` → coordinator switch; fail-loud unknown-route alert; notification-tap unification; `route.tabRoot` telemetry
  - `ios/App/App/AppDelegate.swift` — native `almaerp://` interception; DEBUG-only env-gated nav self-test harness
  - `ios/App/App/AlmaNativeRouter.swift` — `/trading/accounts/{id}` dynamic case
  - `ios/App/App/TradingAccountsSwiftUI.swift` — `focusAccountId` deep-link param (Employees pattern)
  - `ios/App/App/AssistantSwiftUI.swift` — assistive nav + Assistant `openWeb` routed through the coordinator; dead `webPushItem` removed
  - `ios/route-contract.json`, `scripts/iosp0-route-contract-check.mjs`, `ios/App/App.xcodeproj/project.pbxproj`
- **Out of scope, untouched:** web/API code (zero TS changes → no Vercel preview needed), overlays (IOSP-2), caching (IOSP-3), polling (IOSP-4), feature parity (IOSP-6/7).

## Root cause addressed

IOSP-0 found there was no single navigation contract: router-miss and query links **silently** became embedded WKWebView, `/agent` deep links missed, `/trading/accounts/{id}` fell to web, `almaerp://` links navigated the **hidden** Capacitor webview (invisible to the user, and it broke the hidden dashboard the bridges depend on), and the Assistant tab kept its own private router-consult + a direct web `/login` push that bypassed the owner's "login goes native" decision.

## Implementation summary

`AlmaNavCoordinator.decide(path:)` returns a typed decision — `.native(vc)` / `.tabRoot(index)` / `.web(reason)` / `.unknown` — and **every** entry point now goes through it: root-tab callbacks and More rows (`pushSmart`), notification taps (`routeNotificationTap`), `almaerp://` deep links (new native interception in AppDelegate → `.almaOpenPath`), and the Assistant tab (assistive nav + `openWeb`, fixing native-login bypass). Web is now an explicit classification: the coordinator's `temporaryWebRoutes`/`publicWebRoutes`/`publicWebPrefixes` mirror `ios/route-contract.json`, and the extended checker fails when they drift (bidirectionally). An unknown internal route emits `route.unknown` telemetry and shows an owner-facing Bangla alert with an explicit "ওয়েবে খুলুন" handoff — never a silent web embed. Query-carrying links keep their web page (native screens don't accept those params yet) but as an explicit `route.webAllowed reason=query-context` decision. The kill switch (`AlmaSwiftUIFlag` off → legacy web) is preserved.

Classifications decided this phase: `/agent/live-watch` and `/portal/wallet` = explicit temporary-web exceptions with telemetry, native-or-retire decision in IOSP-7 (wallet is financially sensitive → belongs in the finance parity batch, not a routing phase).

## Verification

- **Contract test:** `node scripts/iosp0-route-contract-check.mjs` → OK; coordinator↔fixture cross-check active (parser proven against the real Swift file); 5 remaining gaps, all IOSP-7.
- **Build:** `BUILD SUCCEEDED` (Debug, Pro Max destination, UDID printed).
- **Runtime nav-contract self-test** (DEBUG-only, env-gated harness driving the exact notification-tap/deep-link code path; verified from outside via timed screenshots + signposts):
  - `/trading/accounts/{id}` → `route.push` + native "Trading account" screen (screenshot r1)
  - `/agent` → `route.tabRoot` + Assistant tab selected (screenshot r2)
  - `/portal/wallet` → `route.webAllowed reason=temporary-web` + WKWebView pushed (screenshot r3)
  - `/orders?focus=123` → `route.webAllowed reason=query-context` + web (screenshot r4)
  - `/totally-unknown-page` → `route.unknown` + Bangla fail-loud alert on native Dashboard (screenshot r5) — **no silent web embed**
- **Video:** full sequence recorded (`promax-nav-contract-selftest.mp4`).
- **vitest:** not run this phase — zero TypeScript touched (IOSP-0 ran 1089 green on this tree).
- **Chrome/Vercel proof:** N/A — no web/API change.

## Proof artifacts (`docs/proofs/iosp1/`)

`promax-r1-trading-accounts-native.png` · `promax-r2-agent-tabroot.png` · `promax-r3-wallet-temporary-web.png` · `promax-r4-orders-query-web.png` · `promax-r5-unknown-alert.png` · `promax-nav-contract-selftest.mp4` · `nav-selftest-signposts.txt`

Note: r1–r4 screenshots carry a stale SpringBoard "Open in Alma ERP?" dialog left by an earlier `simctl openurl` probe (it sits above the app and can't be dismissed headlessly); the app content beneath is fully legible, and the r5 re-test after a sim reboot is clean.

## Regression and safety

- `git diff --stat`: 8 files, +186/−80, plus new `AlmaNavCoordinator.swift` and proofs. All iOS-native + fixture + checker.
- No `/api/agent/*`, auth, or financial code touched (grep-verified). No secrets. No migrations. Unrelated worktrees preserved.
- `almaerp://` handling change: new builds consume the scheme natively and the hidden webview no longer navigates; old binaries keep the legacy web path (their AppDelegate lacks the intercept). `DeepLinkManager` (web) untouched.
- Self-test harness is `#if DEBUG` — not compiled into Release/TestFlight.

## PASS/FAIL — IOSP-1 exit criteria

| Criterion | Result | Evidence |
|---|---|---|
| Every internal test route resolves native or fails explicitly | **PASS** | self-test signposts + r1/r2/r5 |
| No internal route silently falls into WKWebView | **PASS** | web paths emit `route.webAllowed` with reason; unknown → alert |
| Root tabs + native screens use one typed coordinator | **PASS** | pushSmart/notification/deep-link/Assistant all through `AlmaNavCoordinator` |
| Typed dynamic routes: employee / CDIT client / trading account | **PASS** | first two pre-existing; `/trading/accounts/{id}` added + proven (r1) |
| `/agent` maps to native Agent root | **PASS** | `route.tabRoot` + r2 |
| `/agent/live-watch`, `/portal/wallet` classified explicitly | **PASS** | fixture + coordinator allowlist + r3 |
| Structured telemetry for unknown/temporary-web routes | **PASS** | `route.unknown` / `route.webAllowed` / `route.tabRoot` / `route.deepLink` |
| Navigation contract tests | **PASS** | extended checker (bidirectional coordinator↔fixture) |
| Cross-navigation Dashboard/Orders/Agent/Approvals/More | **PARTIAL** | cross-tab pushes + tab select proven via self-test; physical tab **taps** and Back-button behaviour need the owner's hands (sim UI driving unavailable — checklist below) |
| Deep links + back stack on Pro Max | **PARTIAL** | deep-link path proven end-to-end via the harness (same code path as notification taps); real `almaerp://` from SpringBoard blocked by the system confirm dialog headlessly; back-stack pop untested without taps |
| Public/system handoffs still work | **PASS** | allowlist verified; escape-hatch closures unchanged (recursion guard intact) |
| No feature parity beyond routing | **PASS** | diff review — `focusAccountId` wires an existing sheet, no new business UI |

## Owner checklist (Bangla, ২ মিনিট)

1. যেকোনো tab থেকে অন্য ৪টি tab-এ tap করে ঘুরে আসুন — সব native থাকবে।
2. Assistant-এ auth-expired card এলে "লগইন খুলুন" চাপলে **native** Sign in আসবে (আগে web আসত)।
3. Siri shortcut বা order entity থেকে অ্যাপ খুললে (almaerp://) native পেজে নামবে — hidden webview আর নড়বে না।
4. যেকোনো pushed পেজ থেকে Back চাপলে আগের জায়গায় ফিরবে।

## Remaining risks / carried debt

- Back-stack and physical tab taps are owner-verified, not Claude-verified (headless limitation; same as IOSP-0 gate 8).
- Query deep links (`?focus=`, `?review=`) still open web by design — native param support belongs to the parity phases (IOSP-6).
- The r3/r4 web pushes showed the WKWebView **web login** — the copied sim container carried native-API cookies but not the webview session. Environment artifact of the sim-clone; on the owner's device the web session exists. Not a routing defect.
- The launch-crash on the original Pro Max sim (CallKit×Agora) remains open for IOSP-4.
- 95 MB raw video was recompressed to 14 MB with `avconvert`; if repo size matters, proofs could move to release assets in a later phase.

## Next: IOSP-2 handoff

`docs/IOSP-2-CLAUDE-CODE-HANDOFF.md` — overlay & safe-area coordinator (chat head / island / banner exclusion zones, keyboard/tab-bar/composer collisions). Branch `agent-phase-19` (verify free first).
