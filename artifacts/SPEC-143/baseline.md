# SPEC-143 baseline — Concurrency and backpressure

## Discovery commands
- `ls src/worker/queues` → SPEC-141/142 present. No concurrency/backpressure module.
- `grep -rln 'concurren|backpressure|inFlight|semaphore' src/worker src/agent/browser-runtime` → none. Greenfield.

## Current implementation
None. SPEC-141/142 will dequeue tasks with no cap on in-flight (LEASED) work and no ceiling on queue depth — an unbounded fan-out and an unbounded backlog are both possible. This spec adds deterministic admission control: per-domain and per-(domain,tenant) concurrency caps + a per-domain queue-depth ceiling that applies backpressure on enqueue.

## Callers / downstream
Consumes SPEC-141 `QueueState` (`depth`, LEASED count). Gate in front of `dequeue`/`scheduleFair`; enqueue admission in front of `enqueue`. Consumed by 150 chaos.

## Direct provider/model/tool/DB calls
None. Pure counting over `QueueState`; limits + `nowMs` + `retryAfterMs` injected (INV-01).

## Tenant / permission / audit propagation
Per-tenant concurrency is enforced by counting LEASED tasks whose identity.tenantId matches — isolation preserved. Decisions return typed ComponentResult with identity-free counters.

## Likely bypass paths
- Ignoring the gate and calling dequeue directly → the gate is advisory unless wired; documented as the admission seam. Backpressure ceiling defends the backlog.
- Retry storms on backpressure → mitigated by a deterministic `retryAfterMs` in the failure.

## Proposed migration boundary
Feature-flag ladder; additive. `off` = unbounded (legacy), `enforce` = caps active.

## Files expected to change
`src/worker/queues/{concurrency.ts,index.ts,__tests__/concurrency.test.ts}` — additive.
