# SPEC-142 baseline — Tenant fairness scheduling

## Discovery commands
- `ls src/worker/queues` → SPEC-141 core present (`contract.ts`, `queue.ts`). No fairness/scheduler module yet.
- `grep -rln 'fair|weighted|round.?robin|deficit' src/worker src/agent/browser-runtime` → none. Greenfield.
- Base: builds on SPEC-141 `QueueState` / `pendingFor`.

## Current implementation
None. SPEC-141 dequeues strict FIFO for a single (domain, tenant). No cross-tenant arbitration exists — a busy tenant could monopolize a domain. This spec adds deterministic weighted fair queuing across tenants.

## Callers / downstream
Consumes SPEC-141 `QueueState`/`pendingFor`. Consumed later by 143 (backpressure) and 150 (chaos).

## Direct provider/model/tool/DB calls
None. Pure selection over injected `FairnessState` counters; `nowMs`/weights injected (INV-01).

## Tenant / permission / audit propagation
Selection is per-tenant by construction; returns the chosen tenant's own task (identity intact). No cross-tenant leakage — a tenant is only ever served its own FIFO head.

## Likely bypass paths
- Starvation of a low-weight tenant → mitigated by deficit-min selection (every pending tenant eventually has the lowest deficit).
- Non-determinism in tie-breaks → mitigated by ascending tenantId tie-break.

## Proposed migration boundary
Feature-flag ladder; additive. `off` keeps SPEC-141 FIFO-per-tenant, `enforce` uses fair arbitration.

## Files expected to change
`src/worker/queues/{fairness.ts,index.ts,__tests__/fairness.test.ts}` — additive.
