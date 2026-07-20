# SPEC-141 contract — Domain task queues

## Public contract
- Types: `TaskDomain` (closed set), `QueueTask`, `QueueTaskState`, `QueueState`, `EnqueuePayload`, `EnqueueAck`, `QueueOp<T>`, `QueueAuditEvent`.
- Boundary fns (all return G01 `ComponentResult<T>` inside `QueueOp`): `enqueue`, `dequeue`, `complete`. Helpers: `depth`, `pendingFor`, `queueAuditEvent`, `emptyQueueState`.
- Contract version: `QUEUE_CONTRACT_VERSION = '1.0.0'`.

## Finite reason codes (`QUEUE_REASON_CODES`)
MISSING_IDENTITY, UNKNOWN_DOMAIN, MALFORMED, OVERSIZED, CROSS_TENANT, DUPLICATE, EMPTY, NOT_FOUND, BAD_PRIORITY — append-only.

## Runtime validation
`enqueuePayloadSchema` (zod): non-empty ids, `domain ∈ TASK_DOMAINS`, priority 0..9, `payloadRef` 1..1024 bytes, positive maxAttempts, non-negative timestamps.

## Audit + metrics fields
`QueueAuditEvent` = { component, op, tenantId, correlationId, domain, taskId, status, reasonCodes, observedAtMs }. Identity ids only; no secret/payload.

## Invariants honored
INV-01 deterministic (no clock/RNG/IO), INV-02 identity on every task+op, INV-05 fail-closed, INV-07 bounded view (payloadRef not body). No boolean success; no thrown errors across the boundary.
