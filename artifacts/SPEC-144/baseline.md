# SPEC-144 baseline — Priority and deadline scheduling

## Discovery commands
- `ls src/worker/queues` → 141/142/143 present. No priority/deadline module.
- `grep -rln 'priority|deadline|EDF|earliest' src/worker/queues` → only the `priority`/`deadlineMs` FIELDS on QueueTask (SPEC-141 contract); no ordering logic consumes them yet.

## Current implementation
None. SPEC-141 stores `priority` (0..9) and optional `deadlineMs` on every task but dequeues strict FIFO, ignoring both. This spec adds deterministic ordering: priority-desc then earliest-deadline-first (EDF) then FIFO, plus deadline-miss detection for escalation.

## Callers / downstream
Consumes SPEC-141 `QueueState` + task priority/deadline. Alternative selection to FIFO; composes under 142 fairness and 143 caps. Consumed by 150 chaos.

## Direct provider/model/tool/DB calls
None. Pure comparator + selection; `nowMs` injected (INV-01).

## Tenant / permission / audit propagation
Selection is tenant-scoped; overdue detection returns identity-bearing tasks for escalation. No cross-tenant mixing.

## Likely bypass paths
- Silent execution of stale (past-deadline) work → mitigated: overdue is flagged on selection and `overdueTasks` surfaces them for escalation.
- Non-deterministic ordering on ties → mitigated by total order (priority, deadline, enqueuedAt, taskId).

## Proposed migration boundary
Feature-flag ladder; additive. `off` keeps FIFO; `enforce` uses priority+EDF.

## Files expected to change
`src/worker/queues/{scheduling.ts,index.ts,__tests__/scheduling.test.ts}` — additive.
