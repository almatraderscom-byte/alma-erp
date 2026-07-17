# Phase 32 proof — Conversation Focus + Continuation spine

- **Date:** 2026-07-17 06:38 (Asia/Dhaka) · Branch `claude/agent-roadmap-1-langgraph`
- **Where:** owner's Chrome at `http://localhost:8318/…` (Vercel deploys intentionally disabled on this branch per owner instruction) — the committed pages below, exercised live and re-rendered to PNG via headless Chrome.

## What shipped

| Piece | File |
|---|---|
| Focus tables (additive) | `prisma/schema.prisma` + `prisma/migrations/20260918000000_agent_conversation_focus/` — `agent_conversation_focuses` (stack: 1 active + parked + awaiting_owner; goal, step, verified-done ledger, blocker, exact next actions, completion criteria, surface, optimistic `version`, lease) + append-only `agent_focus_events` |
| Focus store | `src/agent/lib/conversation-focus.ts` — CRUD with optimistic concurrency (`FocusVersionConflictError`), park/activate, WorkflowRun bridge (`ensureFocusForWorkflowRun`/`syncFocusWithWorkflowRun`), never-repeat ledger, Bangla system note |
| Deterministic resolver | `src/agent/lib/continuity-resolver.ts` — ONE conflict rule: reply-to card > pending-card decision/status > checkpoint retry/why-stopped > imperative new task parks focus (side-questions don't) > continuation/status/demonstrative binds active focus > single-parked resume > clarify (never fabricate). Pure core + `AGENT_CONTINUITY_RESOLVER` gate (unset → preview **on**, production **shadow**) |
| Turn wiring | `run-owner-turn.ts` — resolver runs each turn, decision logged on the route span (`extras.continuity`), live mode widens workflow-continuation authorization + step binding, injects the focus block, parks on new imperative task. `workflow-run.ts` creates/syncs focus rows on every run create/transition. `resume-brief.ts` leads with the focus stack. `tail-compact.ts`/`message-recall.ts` carry the "summary ≠ checkpoint / recall is advisory" contracts (CI-enforced) |
| Runner | `run-agent-replay.ts` binding + continuation checks now execute the REAL resolver (as the Phase 31 baseline doc pre-announced) |

## Exit gates

| Gate | Result |
|---|---|
| ≥99% task binding on the Phase 31 corpus; zero wrong high-risk bindings | ✅ **100%** (107/107 binding checks; wrong-card/checkpoint bindings structurally impossible — asserted over the whole corpus) |
| Exact next step survives restart + 90-day gap | ✅ resolver is pure over durable rows (restart test) + 90-day fixtures pass |
| Repeated verified side effect = 0 in failure/retry tests | ✅ repeated-effect risks 23 → **0**; `forbiddenEffects` carries the never-repeat ledger |
| Tail compaction never deletes focus state | ✅ CI guard: `applyTailCompaction` touches no focus/state table, zero deletes |
| Chrome proof: task → 3 unrelated replies → gap → «যেখানে ছিলে সেখান থেকে করো» → next (not repeated) step | ✅ `scenario-resume-after-gap.html` (PASS verdict, real resolver calls) — `proof-01-scenario-resume.png` |

Corpus after Phase 32: **143/150** (was 110/150). Remaining 7 = Banglish tool-pack recall gaps (state-router `INTENT_RULES`, outside this phase's allowlist; owned by Phase 37's ≥95% recall gate). Baseline locks updated in `agent-replay.test.ts` — binding/continuation/repeated-effect are now perfect-invariants.

## Files (proofs)

- `scenario-resume-after-gap.html` + `proof-01-scenario-resume.png` — the mandated scenario, PASS.
- `replay-baseline.html` / `.json` + `proof-02-corpus-metrics.png` — full corpus re-run: binding 100%.

## Necessary out-of-allowlist touches (sanctioned, pre-announced in Phase 31)

`src/agent/replay/run-agent-replay.ts` + `src/agent/lib/__tests__/agent-replay.test.ts` — the runner now calls the real resolver and the baseline locks moved with it. No other file outside the Phase 32 allowlist changed.
