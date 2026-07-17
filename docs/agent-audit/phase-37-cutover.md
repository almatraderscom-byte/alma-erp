# Phase 37 — Canary, cutover, and legacy retirement runbook

Date: 2026-07-17 · Branch `claude/agent-roadmap-1-langgraph` · Roadmap 1 final phase.
**Production default after this phase: everything stays SHADOW.** The graph becomes canonical only by climbing the ladder below, one rung at a time, owner-approved.

## The ladder

Stage lives in `agent_kv_settings` key **`agent_graph_rollout_stage`** (owner-tunable, no redeploy; default `shadow`):

| # | Stage | What executes | Entry condition |
|---|---|---|---|
| 1 | `shadow` (**current**) | Legacy executes everything; graph decides + compares on every gated turn | — |
| 2 | `synthetic` | Internal synthetic traffic through the graph | 7d shadow ≥98% agreement (`canaryReady`) |
| 3 | `preview_canary` | Owner preview, READ-ONLY turns graph-driven | stage 2 clean |
| 4 | `prod_1` | 1% of low-risk production turns | stage 3 clean + owner approval |
| 5–8 | `prod_10` / `prod_25` / `prod_50` / `prod_100` | Low-risk % ladder | each rung: 0 rollback signals for its window |
| 9 | `staged_writes` | Staged reversible writes via the graph | **Roadmap 3 safety gates (51–53) complete** |
| — | High-risk actions | ALWAYS owner-confirmed cards | never auto |

## Independent kill switches (each one alone reverts its subsystem; all behind `AGENT_ENABLED`)

| Subsystem | Env | Default |
|---|---|---|
| 12-node owner-turn graph (P33) | `AGENT_LANGGRAPH_TURN` | preview shadow-on / prod off |
| Durable checkpoints (LG-2) | `AGENT_LANGGRAPH_CHECKPOINT` | preview on / prod off |
| Interrupt/approval threads (LG-3 + P34 bridge) | `AGENT_LANGGRAPH_INTERRUPT` | preview on / prod off |
| Routine read graph (LG-1) | `AGENT_LANGGRAPH_ROUTINE` | preview on / prod off |
| Continuity resolver (P32) | `AGENT_CONTINUITY_RESOLVER` | preview on / prod **shadow** |
| Human-behaviour layer (P36) | `AGENT_INTERACTION_LAYER` | preview on / prod **shadow** |

## Automated rollback

Drop one stage immediately (and freeze climbing for 7 days) on ANY of, per `getCutoverStatus().rollbackSignals` / owner report:

- wrong-focus binding (ownerGraph `focus_binding` disagreement) > 0 on executed traffic
- any verified duplicate side effect (bridge/idempotency breach)
- checkpoint write/resume failure on an effect-bearing turn (fail-closed alerts)
- guard bypass (a write executed without authorization trail)
- error rate, P95 latency, or per-turn cost above the owner-approved budget for the rung
- owner-reported regression — always wins, no argument

Monitoring: **`/agent?monitor=graph`** (GraphHealthPanel — Bangla) and `/api/assistant/internal/health` → `graph.cutover`.

## Legacy retirement rule

The legacy execution path is REMOVED only after ≥30 days of stable measured traffic at `prod_100`, and only in a separate owner-approved phase. Until then every subsystem falls back to legacy on its kill switch.

## Final exit-gate scorecard (measured on the 150-case corpus + CI)

| Gate | Target | Measured | Verdict |
|---|---|---|---|
| Continuation/task binding | ≥99%, 0 high-risk wrong | **100%**, 0 wrong-card/checkpoint bindings (structural) | ✅ |
| Restart-from-zero on eligible tasks | <1% | 0 in corpus + restart tests (12/12 node pairs, bridge gap-resume) | ✅ (CI; live % measured per rung) |
| Verified duplicate side effects | 0 | 0 (claim-guard txn + bridge alreadyConsumed + ledger) | ✅ |
| Tool selection | ≥95% recall / ≥90% precision | **97.8% / 100%** (effective-availability measure; 1 residual: "call dio" reminder phrasing, state-router fix flagged separately) | ✅ |
| Checkpoint recovery | ≥99.5% | 100% in CI restart/resume suites; live rate gated per rung | ✅ (CI) |
| P95 latency + per-turn cost | within owner budget | **not measurable offline** — each rung's window measures it; budgets set at stage 4 entry | ⏳ honest deferral |
| Browser proof: forced failure → gap → exact resume | required | `docs/proofs/agent-phase-37/` e2e scenario | ✅ |

## What must not be claimed (restated)

LangGraph alone creates no intelligence; a summary is not a checkpoint; "I remember" is not continuity proof; the percentages above are measured per task class on the agreed corpus, not marketing; the flags are never flipped together.
