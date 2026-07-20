# SPEC-143 contract — Concurrency and backpressure

## Public contract
- Type: `ConcurrencyLimits` = { maxInFlightPerDomain, maxInFlightPerTenant, maxDepthPerDomain, retryAfterMs } (positive ints).
- Fns (return G01 `ComponentResult`): `admitDequeue` (in-flight caps), `admitEnqueue` (depth ceiling), `inFlight` (LEASED counter).
- Reason codes: BACKPRESSURE_DOMAIN, BACKPRESSURE_TENANT, QUEUE_FULL, MALFORMED.

## Behavior
Admit only with headroom on BOTH domain and tenant in-flight caps; else RETRYABLE + deterministic retryAfterMs. Enqueue refused at the pending-depth ceiling (RETRYABLE/QUEUE_FULL). Malformed limits / missing tenant ⇒ FAILED_FINAL/MALFORMED (fail-closed).

## Invariants
INV-01 deterministic (limits/nowMs/retryAfterMs injected). INV-02 per-tenant counting. INV-05 fail-closed. No boolean success; no throw.
