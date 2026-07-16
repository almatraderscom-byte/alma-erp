# Claude Code Handoff — ALMA ERP iOS Native Polish, IOSP-1 only

Copy the prompt below into a fresh Claude Code session. This handoff authorizes **IOSP-1 only**. Repository rules require one roadmap phase per session. IOSP-0 is complete (`docs/IOSP-0-BASELINE-REPORT.md`, branch `agent-phase-16`, tag `pre-agent-phase-16`).

---

You are taking over the ALMA ERP iOS Native Polish programme at **IOSP-1**.

## Required reading (completely, before any action)

1. `CLAUDE.md` (repository rules — highest authority).
2. `docs/IOS_NATIVE_POLISH_MASTER_ROADMAP_2026-07.md` — §8 "Phase IOSP-1", §4 (route contract), §7 (gates), §12 (safety).
3. `docs/IOSP-0-BASELINE-REPORT.md` — the baseline you build on, especially §5 (route gaps), §6 (forced-web call sites), §8 (launch-crash finding).
4. `ios/route-contract.json` + `scripts/iosp0-route-contract-check.mjs` — the machine-readable contract IOSP-1 must extend and keep green.
5. Source: `ios/App/App/SwiftUIShell.swift` (`pushWeb`/`pushSmart`/`smartOpen`), `ios/App/App/AlmaNativeRouter.swift`, `ios/App/App/AppDelegate.swift` deep-link handlers.

## Authorization for this session

Execute **IOSP-1 — Single native navigation coordinator only.** Do not start IOSP-2. End with an IOSP-1 phase report + an IOSP-2 handoff, then stop.

## IOSP-1 goal and work (from roadmap §8)

Eliminate accidental embedded-web transitions:

- Make all root tabs and native screens use one typed navigation coordinator; replace direct `pushWeb` callbacks for **internal** routes.
- Add typed dynamic routes for **employee**, **CDIT client**, and **trading account** details (`/employees/[id]` and `/digital/clients/[id]` already resolve via `pathParam`; **`/trading/accounts/[id]` does not — add it**).
- Map `/agent` consistently to the native Agent root (today it is a tab with no exact router case).
- Classify `/agent/live-watch` and `/portal/wallet` explicitly (native screen or documented owner-approved web exception with telemetry + expiry).
- Introduce **structured routing-failure telemetry**: an unknown/internal route must **fail loudly** (logged `route.unknown` + safe owner-facing error or allowlisted handoff), never silently become embedded web (baseline gap #3 in report §6).
- Resolve **query-carrying deep links** natively where the native screen accepts the parameter, instead of the current force-to-web (baseline gap #1). Keep genuine escape-hatch and public/system handoffs working.
- Add navigation-contract tests; extend `ios/route-contract.json` and keep `node scripts/iosp0-route-contract-check.mjs` green.

## Exit criteria (roadmap §8)

Every internal test route resolves native or fails explicitly; no internal route silently falls into WKWebView; Dashboard/Orders/Agent/Approvals/More cross-navigation passes; deep links + back-stack pass on Pro Max; public/system handoffs still work; **no feature-parity work beyond routing** (that is IOSP-6/7).

## Safety and branch rules

- Live production ERP. Preserve every unrelated dirty change and worktree. Never `git add -A`.
- Create the next branch/tag pair: **`agent-phase-17` + `pre-agent-phase-17`** (16 is taken by IOSP-0). Verify the next free number first.
- Never modify `/api/agent/*` or its auth. New agent API routes only under `/api/assistant/*`. `AGENT_ENABLED` checks stay.
- Do not change business/financial semantics; whole-taka money rules untouched.
- No secrets in git. Additive migrations only (IOSP-1 should need none).
- Do not merge to main, deploy production, or upload TestFlight.

## Simulator isolation — mandatory

- Approved audit device family: **iPhone 17 Pro Max, UDID `94E0186B-5CDA-4708-9368-53B4FF7274E7`.** ⚠️ That specific sim currently **crashes at launch** (CallKit×Agora keypath — see IOSP-0 report §8 / `docs/proofs/iosp0/launch-crash-diagnosis.md`). Either reset/reinstall it first, or create a fresh iPhone 17 Pro Max (iOS 26.5) sim as IOSP-0 did (`9E51818A-…` was this session's clean Pro Max). **Print and verify the destination UDID before every `simctl`/`xcodebuild` destination command.**
- Never boot, install, launch, erase, focus, or control the other session's **iPhone 17 Pro** (`5F79315F-…`).
- To reach the logged-in state on a fresh sim without typing credentials: copy the app data container (`Library/`, `Documents/`) from a logged-in sim, then trigger Face ID enrollment (`notifyutil -s/-p com.apple.BiometricKit.enrollmentChanged`) and match (`notifyutil -p com.apple.BiometricKit_Sim.pearl.match`). Claude never types the owner's password.

## Verification gate (roadmap §7 — build success is NOT proof)

Build for the exact Pro Max UDID; install/launch only there; exercise Dashboard→Orders→Agent→Approvals→More cross-navigation and the new dynamic/`/agent` routes; drive deep links + back stack; capture screenshots + a short video of a native transition that previously went to web; save the routing-failure telemetry firing on a deliberately-unknown route; run navigation-contract tests + `scripts/iosp0-route-contract-check.mjs`; `git diff --stat` scope check; confirm no protected/auth/money code changed. If IOSP-1 changes web/API code, push a Vercel preview and do the mandatory owner-Chrome proof.

**If any mandatory gate fails, IOSP-1 is not complete.** Note the standing rule: if driving the simulator UI is not available to Claude, hand the owner a Bangla tab/deep-link checklist for the tap-only gates, and be explicit about which gates are Claude-verified vs owner-verified.

## Deliverables

Files changed; routing coordinator design; extended route contract + green checker; screenshots/video + telemetry proof paths; PASS/FAIL against IOSP-1 exit criteria; branch/commit; unresolved risks; an IOSP-2-only handoff prompt. Stop after IOSP-1.

## TestFlight

No TestFlight in IOSP-1. Programme policy: two builds total — technical checkpoint after IOSP-4, final after IOSP-9. Every phase still needs Pro Max simulator proof.

---
