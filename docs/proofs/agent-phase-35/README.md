# Phase 35 proof — specialist subgraphs, parallel reads, durable long work

- **Date:** 2026-07-17 07:20 (Asia/Dhaka) · Branch `claude/agent-roadmap-1-langgraph`

## What shipped

| Piece | File |
|---|---|
| Send fan-out subgraph | `src/agent/lib/graph/specialist-subgraph.ts` — per-invocation stateless briefs → LangGraph `Send` parallel branches (READ/RESEARCH only, capped at 4) → fan-in `reconcile` with deterministic conflict flagging + a structured head brief (head stays the single owner-facing narrator) |
| Read-only enforcement | `src/agent/lib/models/subagent.ts` — `readOnly` param filters the role's toolset to reads and hard-drops memory/effect writers (`save_memory`, checkpoints, `ask_user`); every fan-out branch sets it by construction |
| Cache policy | explicit `cacheable + cacheKey + cacheVersion` briefs only, stored in the LangGraph BaseStore (`specialist_cache` ns), fail-open |
| Durable long work | `worker/src/agent-graph-run.mjs` — the >30s contract: checkpoint after EVERY brief, resume skips completed briefs (no duplicated work), heartbeat, cancellation, deadline-checkpoint-partial; wired in `worker/src/index.mjs` as the `agent-graph-run` BullMQ queue (jobId dedupe) with brief execution through the app's chat route (worker stays modelless; all app guards apply) |

## Exit gates

| Gate | Result |
|---|---|
| Parallel branches cannot write memory or owner-facing effects | ✅ `readOnly:true` on every Send branch + `filterToolsReadOnly` drops writers; asserted in `specialist-subgraph.test.ts` |
| Worker crash/retry resumes without duplicated work | ✅ mid-run kill test: brief 0 checkpointed → retry runs only briefs 1–2; BullMQ retry after a failed brief re-runs nothing (`agent-graph-run.test.mjs`, `node --test`, 6/6) |
| A failed specialist is visible and does not erase sibling evidence | ✅ failed branch → success:false finding with error; siblings intact (both layers tested) |
| Chrome proof: multi-specialist task, fan-out/fan-in trace, grounded Bangla answer material | ✅ `fanout-trace.html` / `proof-01-fanout-trace.png` — 3 branches (1 deliberately failed), reconciled head brief in Bangla |

## Necessary out-of-allowlist touch

`src/app/api/assistant/internal/pending-jobs/route.ts` — added `agent_graph_run` to the dispatch list; the repo's own contract test (`pending-jobs-dispatch.test.ts`) fails the build if a worker-handled type is missing there, so this edit is forced by the phase's worker wiring.
