# SPEC-144 contract — Priority and deadline scheduling

## Public contract
- Fns: `compareTasks` (total order), `prioritizedFor`, `isOverdue`, `overdueTasks`, `nextByPriority` (→ ComponentResult<{task,overdue}>), `nextByPriorityStrict` (denies past-deadline head).
- Reason codes: EMPTY, MALFORMED, DEADLINE_MISSED.

## Order
priority DESC → earliest deadline (EDF; no-deadline = +inf) → FIFO enqueuedAt → taskId. Total + deterministic (no map-order ties).

## Behavior
`nextByPriority` surfaces overdue status; `nextByPriorityStrict` DENIES a stale head for escalation; `overdueTasks` lists past-deadline pending work. Fail-closed: empty ⇒ RETRYABLE; bad nowMs/tenant ⇒ FAILED_FINAL.

## Invariants
INV-01 deterministic (nowMs injected). INV-02 tenant-scoped. INV-05 fail-closed. No boolean success; no throw.
