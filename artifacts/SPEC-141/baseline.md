# SPEC-141 baseline — Domain task queues

## Discovery commands
- `ls src/worker` → **absent** in base `origin/aios/integration-wave` (ebbf7a59). No prior queue impl in owned zones.
- `grep -rln 'TaskQueue|enqueue' src --include=*.ts` → only ERP/service references (`src/services/sms/events.ts`, ERP routes) — none in `src/worker/queues` or `src/agent/browser-runtime`.
- `grep -rln 'redis|bullmq' src/agent src/worker` → none in owned zones (CLAUDE.md notes Redis VPS queue as future infra, not present here).

## Current implementation and aliases
None. This is a greenfield deterministic boundary inside the owned zone `src/worker/queues`.

## Callers / downstream dependencies
No callers yet (net-new zone). Downstream reuse target: G14 `src/agent/workflows` (lease/idempotency/reconcile) consumed by later specs 145/150.

## Direct provider/model/tool/database calls
None. Pure functions over an immutable `QueueState` value; `nowMs`/ids injected (INV-01).

## Current tests / cost / latency
None pre-existing. No model calls ⇒ zero token/USD cost (see cost-before-after.md).

## Tenant / permission / audit propagation
Every `QueueTask` carries a full `ExecutionIdentity` (INV-02). Enqueue/dequeue require request identity; cross-tenant is rejected. `queueAuditEvent` emits identity ids only (no payload body).

## Likely bypass paths
- Enqueuing raw payloads instead of an evidence ref → mitigated: `payloadRef` is a bounded (<=1KiB) string; body stays in evidence storage (INV-07).
- Cross-tenant enqueue/dequeue → mitigated by explicit tenant equality guard.

## Proposed migration boundary
Feature-flag ladder (off→shadow→warn→enforce→rollback) via G01 `feature-flag.ts` — the new queue path is additive; nothing legacy to displace, so `off` is a no-op and `enforce` activates the new path.

## Files expected to change
`src/worker/queues/{tsconfig.json,contract.ts,queue.ts,index.ts,__tests__/queue.test.ts}` — additive only.
