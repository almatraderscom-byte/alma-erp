# Phase 34 proof — universal interrupt/ask/approval/resume bridge

- **Date:** 2026-07-17 07:03 (Asia/Dhaka) · Branch `claude/agent-roadmap-1-langgraph`

## What shipped

| Piece | File |
|---|---|
| Universal typed bridge | `src/agent/lib/graph/action-bridge.ts` — ONE typed contract for ask/approve/reject/revise/cancel/external_handoff: `BridgeInterruptPayload` (card → run → thread → expected state version), `BridgeResumeValue`, universal 2-node interrupt graph, `guardBridgeDecision` (pure verdict matrix), Bangla zero-effect messages |
| Ask-card store | `src/agent/lib/ask-cards.ts` — idempotent `answerAskCard`: same answer repeated = no-op success; different answer after one is recorded = refused; bound WorkflowRun advances immediately (version-guarded) |
| Route wiring | `answer` route → ask-cards helper (idempotent + run binding at answer time) · `approve` route → bridge guard (stale-version + revision-requires-new-card + double-click thread consumption) BEFORE any effect · `reject`/`revise` routes → consume the decision thread so a stale resume can never fire the pre-revise payload |

Boundaries kept: **interrupt = transport, never authorization** (the routes' owner-auth/status/expiry guards are untouched and still run first); the log_expense pilot graph is grandfathered unchanged; approval covers exactly the displayed effect.

## Exit gates

| Gate | Result |
|---|---|
| Every staged action category has interrupt/resume contract tests | ✅ 9 categories (log_expense, fb_post, staff_dispatch, campaign_budget, browser_task, outbound_call, seo_fix, product_publish, image_gen) × 6 decision kinds in `action-bridge.test.ts` |
| Duplicate approve produces one effect | ✅ second resume → `alreadyConsumed`, applies nothing; approve-after-reject/revise likewise |
| Stale or mismatched card produces zero effects + clear message | ✅ `stale_version` / `already_resolved` / `expired` / `wrong_card` verdicts, each with a Bangla message; approve route returns 409 before any executor runs |
| Approval = the exact displayed effect only | ✅ approve carrying revised fields → `revision_requires_new_card`; revise consumes the pre-revise thread |
| Resume never reinterprets the approved text as a new instruction | ✅ resume values are TYPED (`BridgeResumeValue`), never prose fed to the model; ask answers are durable bound state (anchoring note reads the row) |
| Chrome proof incl. three-day-gap resume | ✅ `bridge-scenarios.html` / `proof-01-bridge-scenarios.png` — 6 live bridge-graph scenarios, ALL PASS |

## Platform gotcha discovered (recorded for later phases)

Custom `checkpoint_ns` values desync `getState().next` on the JS `MemorySaver` — the bridge therefore encodes its namespace in the thread id (`action_bridge:<cardId>`) with no `checkpoint_ns`. The LG-3 expense pilot (PostgresSaver + invoke-only resume) is unaffected and stays as verified live.
