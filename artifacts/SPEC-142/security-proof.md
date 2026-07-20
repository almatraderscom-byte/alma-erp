# SPEC-142 security proof
- Tenant isolation: `scheduleFair` returns only the picked tenant's own FIFO head; test "no cross-tenant leak" asserts the returned task's tenantId equals the picked tenant.
- Anti-starvation: min-deficit selection guarantees every pending tenant is eventually the minimum ⇒ no indefinite starvation (fairness property).
- Fail-closed: no pending ⇒ RETRYABLE/NO_PENDING; non-positive weight ⇒ FAILED_FINAL/NON_POSITIVE_WEIGHT (undecidable priority denied, never treated as infinite).
