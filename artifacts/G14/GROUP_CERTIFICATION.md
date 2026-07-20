# G14 — GROUP CERTIFICATION

Group: G14 — Durable Workflow Runtime
Branch: `aios/G14-workflow` (base = integration-wave @ G13)

```
Group: G14   Specs: SPEC-131..SPEC-140   Individual PASS: 10/10
Repository integration tests: PASS   Architecture scan: PASS
Cost regression: PASS (deterministic; 0 model calls added)
Security regression: PASS   Rollback drill: PASS (per spec — parent tree MATCH)
Unresolved critical risks: 0   Verdict: PASS
```

## What G14 built
The durable runtime that lets a multi-step job survive crashes, retries and
timeouts without ever double-charging or losing work.

| Spec | Deliverable |
| --- | --- |
| 131 | Workflow template registry — versioned, immutable, ordered step definitions |
| 132 | Workflow versioning — instances pin a version for life; no silent drift (INV-09) |
| 133 | Durable workflow state — event-sourced, replayable; legal transitions only |
| 134 | Step leases & heartbeats — at most one live worker per step |
| 135 | Retry classification — RETRY / RECONCILE / TERMINAL, deterministic backoff |
| 136 | Idempotency keys — stable per (instance, step, pin); at-most-once side effect |
| 137 | Unknown-outcome reconciliation — INV-06 core: probe & converge, never blind-retry |
| 138 | Compensation & saga — undo committed effects in reverse order |
| 139 | Dead-letter & manual recovery — human-authorized, fail-closed action set |
| 140 | Durability chaos certification — 13 invariants driven through the composed stack |

## Integration checkpoint
| Check | Result |
| --- | --- |
| Zone typecheck | **PASS** (tsc 0) |
| G14 zone tests | **PASS** (80) |
| Full suite (merged wave) | **PASS** (see wave note) |
| Forbidden-import / admission / authz / gateway gates | **PASS** (no regression) |
| Cost vs baseline | **PASS** (deterministic; 0 model calls, INV-01) |
| Rollback (per spec) | **PASS** (revert → parent tree MATCH, all 10) |

## Scope discipline
All changes within `src/agent/workflows` (+ `src/worker/workflows` reserved) and
`artifacts/`. **0 modifications, 0 deletions** to existing code. Hermes, live
schema, ERP money code: **0 touched**.

## Security / correctness posture
- **At-most-once side effects:** lease (one live worker) + stable idempotency key
  (dedup across retries/crashes) make a double charge/post impossible.
- **INV-06 everywhere:** an unknown side-effect outcome reconciles (probe & converge)
  or escalates to a human — it is NEVER blindly retried.
- **Saga safety:** only steps that actually committed are compensated, in reverse.
- **No silent loss:** anything unrecoverable dead-letters for a human; recovery is
  human-authorized and the legal action set is fail-closed (no auto-retry of an
  uncompensatable or unknown effect).
- **Deterministic (INV-01):** event-sourced, timestamps injected, no clock/LLM/DB
  in the decision core — every instance is replayable.

## Verdict
**G14 PASS.** Ready to unblock G15 (queue/browser) and G18 (specialist agents).
