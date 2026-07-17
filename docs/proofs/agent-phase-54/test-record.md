# Phase 54 proof — durable graph worker for long-running work

Date: 2026-07-17 (Asia/Dhaka) · Branch: claude/agent-roadmap-phases-2a10b1

## What shipped

- `src/agent/lib/graph/durable-task-graph.ts` — durable task graphs on the existing WorkflowRun tables (no migration): code-registered node graphs (read/plan/verify/effect), CAS leases + heartbeat, checkpoint after EVERY node, cancellation at node boundaries, exact-blocker pause (blocked) instead of hard-fail, owner-readable progress (goal/completed/current/next/blocker/ETA range/cost), event replay from a cursor (exactly-once reconnection contract)
- Retry separation: read/plan/verify nodes retry in place with deterministic backoff; **effect nodes never replay directly** — `ctx.effect()` routes through the Phase 53 exactly-once engine with a node-scoped idempotency key
- `turn-queue.ts` — `enqueueDurableTask` on the same long-agent-task BullMQ queue (job name 'durable-task', deterministic jobId, retries SAFE because of checkpoints — documented contrast with non-idempotent turns)
- `worker/src/agent-task-runner.mjs` — VPS-side runner with identical semantics over supabase snake_case tables + compact exactly-once effect helper on agent_action_runs; wired into the long-agent-task consumer (blocked/lease-unavailable throws so BullMQ backoff resumes later)

## Exit gates

- Forced worker kill at EVERY node boundary resumes from the next safe point: **PASS** (lib: kill after n1/n2/n3 each → resume completes, every node ran exactly once; worker: same)
- Effect exactly-once across kill/resume: **PASS** (kill after effect checkpoint → 1 send; crash after effect before checkpoint → node re-runs, effect replays stored outcome, still 1 send)
- Redis/DB/provider outage recovers or pauses with an exact blocker: **PASS** (persistent failure → state blocked + facts.blocker verbatim; later retry resumes from the failed node without re-running done nodes)
- Duplicate workers cannot hold the same lease/effect: **PASS** (CAS lease exclusivity both sides; unknown_effect never blind-retried on the worker)
- Disconnect immunity: execution is queue+DB-driven; `replayTaskEvents(cursor)` replays persisted progress exactly once
- Regression: **2030/2030 vitest + 8/8 node --test**, tsc clean, worker syntax clean
- Chrome proof: DEFERRED (deploys disabled by owner instruction)
