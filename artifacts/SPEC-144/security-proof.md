# SPEC-144 security proof
- Tenant isolation: selection filters by identity.tenantId; no cross-tenant ordering.
- Stale-work safety: strict mode DENIES past-deadline heads (DEADLINE_MISSED) so stale/expired work is escalated, not silently executed (fail-closed on time).
- Determinism: total order prevents priority-inversion ambiguity across runs.
