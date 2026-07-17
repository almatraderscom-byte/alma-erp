# IOSP-0..9 Deep Cross-Phase Audit — 2026-07-17

Owner-requested (after IOSP-9): re-verify every phase end-to-end from the current
tree (`agent-phase-26`), find gaps, apply improvements. Same sim `9E51818A-…`,
Xcode 26.6. All checks run TODAY against the cumulative code, not read from old reports.

## A. Chain integrity (the build-63–69 failure mode)
Every phase tip is an ancestor of HEAD — verified by `git merge-base --is-ancestor`
for `ae9824dc` (0), `d451f56a` (1), `a183e091` (2), `22e27867` (3), `27101301` (4),
`ba155593` (5), `a1a732e6` (6), `bbe6949d` (7), `9e7e03f1` (8), `913615d5` (9).
**No phase work lost anywhere in the chain. PASS.**

## B. Scope safety (hard rules)
Full-programme diff vs merge-base `54aadb7c`: only `ios/**`, `docs/**`,
`scripts/iosp0-*` (measurement), `scripts/vercel-skip-ios-only.sh` + `vercel.json`
(owner-requested build-queue fix). `/api/agent/*` untouched (0 files). Zero web-app
code touched in 10 phases. Zero TODO/FIXME/HACK introduced. **PASS.**

## C. Per-phase claims re-proven live today
| Phase | Claim | Today's evidence |
|---|---|---|
| 0 | Baseline instruments | signposts still emit; same capture recipe works |
| 1 | No silent web; fail-loud unknown | selftest: native/tabroot/allowed-web/Bangla-alert all correct |
| 2 | Overlay/keyboard coordinator | `overlaySelfTest.start→keyboardUp→keyboardDown` PASS |
| 3 | Single-flight + TTL cache | `cacheSelfTest.concurrent/ttl` PASS |
| 4 | CallKit crash fix + scene polling | `callResetRepro.survived`; background polls **0**; foreground 3s = documented exception |
| 5 | Agent Reduce Motion | gates present; IOSP-9 extended to the last 3 ungated sites |
| 6 | Native parity (already done by S6-S8) | Orders/Approvals/Payroll/PortalOffice driven live with real data |
| 7 | Exception ledger | checker's 5 open gaps == ledger exactly |
| 8 | Warnings zeroed | clean build: target categories all 0, no new kinds |
| 9 | A11y + regression | this audit ran on top of it |

## D. Gaps found by this audit → fixed now
1. **One missed Swift-6 error-to-be** (`PayrollSwiftUI.swift:639` — mutable
   `rosterQuery` captured by `async let`). It sat outside IOSP-8's
   async-not-awaited category, so the "96→0" claim was true but incomplete as a
   "Swift-6 readiness" statement. **Fixed** (immutable closure-init); rebuild clean;
   `error in the Swift 6 language mode` count is now **0 across the app**.
2. **Vercel ignore script fail-open in the real container** (shallow clone ~10
   deep, no `origin/main`, PREV sha absent) — the first live run built anyway.
   **Fixed** on `agent-phase-26` (`d7286a46`): direct `--depth=1` fetch of the PREV
   sha + `--deepen=300` / `FETCH_HEAD` merge-base fallback; re-verified in a real
   depth-10 clone locally. (Fail-open direction preserved — errors always build.)

## E. Known remainders (deliberate, not gaps)
- 5 web-remainder routes (IOSP-7 ledger; owner decisions pending on live-watch/wallet).
- Foreground 3-s intercom poll (IOSP-4 exception — call latency; server push would
  be the real replacement, server-side work).
- 3 non-Sendable captures + 5 CocoaPods script-phase warnings (IOSP-8 deferrals
  with reasons; Pods regeneration risk vs cosmetic value).
- ~160 "other" baseline warnings (deprecation notes in third-party-adjacent code
  etc.) — none are Swift-6 errors-to-be; inventory lives in the IOSP-0 proofs.
- Full semantic Dynamic Type migration — deferred to the Xcode-27 pass.

## F. Improvement ideas for the owner (ranked, NOT implemented)
1. **Server push to replace the 3-s intercom poll** (biggest battery/network win
   left; needs a realtime channel server-side — Supabase realtime or APNs).
2. **CI a11y snapshot** — run the AX-XXXL screenshot set in the GitHub Actions
   pipeline so text-size regressions get caught before TestFlight.
3. **Pods regeneration window** — next time a pod is added anyway, take the
   5 script-phase warnings + re-audit in the same build.
4. **Swift 6 language mode flip** — everything is now clean except the 3
   non-Sendable captures; a small dedicated session can flip the mode for real.

## Verdict
Roadmap IOSP-0..9: **verified complete and internally consistent** on the
Xcode-26.6 track, with the two audit gaps above found and fixed today.
Remaining programme work is owner-gated: Xcode 27 + iOS 27 verify, then ONE
TestFlight + the Bangla checklist (`docs/IOSP-FINAL-OWNER-CHECKLIST-BN.md`).
