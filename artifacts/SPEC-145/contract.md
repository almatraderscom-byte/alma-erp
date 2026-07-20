# SPEC-145 contract — Worker lease and crash recovery

## Public contract
- Types: `RecoveryBudget`, `RecoveryOutcome` ({ action, task }), `RecoveryAction`.
- Fn: `recoverCrashedTask` → { result: ComponentResult<RecoveryOutcome>, state }.
- Reason codes: LEASE_STILL_LIVE, MALFORMED, TASK_NOT_LEASED, ESCALATED_DEAD_LETTER, RECONCILE_AGAIN.

## Reused G14 primitives (INV-06 — not reimplemented)
- `@/agent/workflows/lease` (isExpired, StepLease) — lease liveness.
- `@/agent/workflows/reconcile` (reconcile, ReconcileFinding) — unknown-outcome convergence.

## Recovery mapping
effect_present→DONE(COMPLETED); effect_absent→PENDING(REQUEUED, attempts preserved); indeterminate+budget→UNKNOWN_OUTCOME(RECONCILE_AGAIN, backoff); indeterminate exhausted→DEAD(FAILED_FINAL/ESCALATED).

## Invariants
INV-01 deterministic (nowMs/ttl/finding injected; probe I/O behind G14 seam). INV-05 fail-closed (live lease / not-leased / malformed deny). INV-06 reconcile, never blind-retry. No boolean success; no throw.
