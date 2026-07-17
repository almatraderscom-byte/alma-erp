# Phase 33 proof — graph-native owner-turn execution (shadow)

- **Date:** 2026-07-17 06:51 (Asia/Dhaka) · Branch `claude/agent-roadmap-1-langgraph`
- **Contract:** the graph DECIDES, legacy EXECUTES. Node 7 (`execute_or_stage`) predicts effects only — shadow traffic can never double-execute.

## What shipped

- `src/agent/lib/graph/owner-turn-graph.ts` — the REAL 12-node StateGraph (load_context → classify_intent → policy_precheck → select_tool_pack → plan_model_call → tool_pre_guard → execute_or_stage → observe_verify → repair_retry → update_focus → style_reply → persist_trace). Same real decision code as production: continuity resolver, fast-path classifier, pack assembly with `HEAD_TOOL_HARD_LIMIT`, routine-intent planner, mutation pre-guard. Durable via the shared Postgres checkpointer (`owner_turn` namespace, stable thread id per conversation+turn).
- `turn-graph-shadow.ts` v2 — the LG-4 fast-path shadow now ALSO invokes the full graph when the caller passes conversation inputs; record carries `graph.trace` + `graph.agreement`; hard disagreements warn.
- `run-owner-turn.ts` — passes the live turn's decisions (bound tool, continuity binding, authorization) + a state loader; the record lands on the route span (`extras.turnGraph.graph`).
- `graph-health.ts` — new `ownerGraph` aggregation: recorded/scored/agree-rate, disagreement labels, trace-completeness.

## Exit gates

| Gate | Result |
|---|---|
| ≥98% shadow agreement on low-risk corpus; disagreements classified | ✅ **100% (132/132)** in `owner-turn-graph.test.ts` (corpus-wide); labels wired (`fast_path`/`focus_binding`/`tool_groups`/`planned_tool`) |
| 100% of traces show focus, tool decision, guard, verification, final state | ✅ asserted over all 150 corpus cases |
| Process restart between any two nodes resumes from checkpoint | ✅ interrupt-before every node → resume on a FRESH graph instance → identical trace (MemorySaver in CI; Postgres saver in runtime) |
| No silent fail-open for writes | ✅ guard tests: unauthorized write → `write_requires_authorization`, effect `none`; listen mode strips all tools; `update_focus` records the fail-closed contract |
| Chrome proof: one read, one multi-tool task, one recovered failure | ✅ `graph-traces.html` / `proof-01-graph-traces.png` — three live graph invocations with full traces + agreement |

Note: SSE streaming to the UI is untouched (shadow doesn't stream; legacy path unchanged) — graph-driven streaming belongs to the Phase 37 cutover.

## Files

- `graph-traces.html` + `proof-01-graph-traces.png` — the three mandated scenario traces (all five trace elements each, agreement true).
