# SPEC-150 contract — Queue and browser chaos verification

## Public contract
- `runQueueChaosSuite()` → ChaosResult[] (11 queue invariants).
- `runBrowserChaosSuite()` → ChaosResult[] (9 browser invariants).
- `ChaosResult` = { invariant: string, ok: boolean }. Each suite catches thrown errors as ok=false (no exception escapes).

## Invariants asserted by driving the stack (INV-10)
Queue: duplicate→dedupe-once; cross-tenant reject; empty→RETRYABLE(no throw); domain backpressure; depth QUEUE_FULL; fairness no-starvation; strict deadline deny; crash+unknown→UNKNOWN_OUTCOME(no blind retry, stays LEASED); crash+effect-absent→requeue; crash+exhausted→DEAD(dead-letter).
Browser: hallucinated target DENIED; present target minted; secrets never in compact view; oversize view fail-closed; replan hard-stop; stall hard-stop; cost-ceiling BUDGET_EXCEEDED; step-ceiling hard-stop; float cost rejected.

## Invariants
INV-01 deterministic + self-contained (all constants). Verification-only; no production path change.
