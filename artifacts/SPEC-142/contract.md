# SPEC-142 contract — Tenant fairness scheduling

## Public contract
- Types: `FairnessState` (per-tenant service counters, immutable), `TenantWeights`.
- Fns: `pickFairTenant` (pure selection → tenantId|null), `scheduleFair` (returns G01 `ComponentResult<QueueTask>` + next FairnessState + next QueueState), `weightOf`, `emptyFairnessState`.
- Reason codes `FAIRNESS_REASON_CODES`: NO_PENDING, MALFORMED, NON_POSITIVE_WEIGHT.

## Algorithm
Weighted Deficit Round Robin: pick min `served/weight` among tenants with pending work; ascending-tenantId tie-break (deterministic). Chosen tenant is served its own SPEC-141 FIFO head; its counter advances by 1.

## Invariants
INV-01 deterministic (weights/nowMs injected). INV-02 no cross-tenant leak (a tenant only ever gets its own head). INV-05 fail-closed (no pending ⇒ RETRYABLE; non-positive weight ⇒ FAILED_FINAL). No boolean success; no throw.
