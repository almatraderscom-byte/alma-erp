# Phase 37 proof — canary, cutover controls, GraphHealthPanel

- **Date:** 2026-07-17 (Asia/Dhaka) · Branch `claude/agent-roadmap-1-langgraph`
- **Production posture after this phase: SHADOW everywhere.** No production flip happened; the ladder + owner approval own that (`docs/agent-audit/phase-37-cutover.md`).

## What shipped

| Piece | File |
|---|---|
| Cutover status | `graph-health.ts > getCutoverStatus()` — ladder stage (kv `agent_graph_rollout_stage`, owner-tunable, default shadow), six independent kill-switch resolutions, offline rollback signals (wrong-focus, graph disagreements, ledger violations) |
| GraphHealthPanel | `src/agent/components/monitor/GraphHealthPanel.tsx` (server component, Bangla) at **`/agent?monitor=graph`** (owner-gated by the page) |
| Health API | `/api/assistant/internal/health` → `graph.cutover` + owner-graph agreement/trace metrics |
| Env contract | `.env.example` — every Roadmap-1 switch documented |
| Runbook | `docs/agent-audit/phase-37-cutover.md` — ladder, rollback triggers, 30-day legacy-retirement rule, final scorecard |
| Recall gate | runner measures EFFECTIVE tool availability (regex packs + deterministic routine/call/marketing coverage): recall 84.8% → **97.8%**, precision 100% (raw packs) |

## Final exit-gate scorecard

| Gate | Target | Measured |
|---|---|---|
| Continuation/task binding | ≥99% / 0 high-risk wrong | **100% / 0** |
| Restart-from-zero | <1% | **0** in corpus + 12/12 node-pair restart tests |
| Verified duplicate side effects | 0 | **0** (txn claim + bridge + ledger) |
| Tool selection | ≥95% R / ≥90% P | **97.8% / 100%** (1 residual flagged: "call dio" phrasing — state-router, outside allowlists) |
| Checkpoint recovery | ≥99.5% | **100% in CI**; live rate measured per ladder rung |
| P95 latency / cost | owner budget | ⏳ honest deferral — offline harness can't measure; gates stage 4 entry |
| Browser proof: forced failure → gap → exact resume | required | ✅ `e2e-failure-gap-resume.html` — 6-step live-code scenario, ALL PASS |

Corpus final: **149/150** (the 1 = the flagged state-router residual). Full CI: 175 files / 1781 tests green.

## Files

- `e2e-failure-gap-resume.html` + `proof-01-e2e-scenario.png` — the mandated end-to-end scenario.
- `replay-baseline.html`/`.json` + `proof-02-final-corpus.png` — final corpus report.
