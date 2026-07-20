# SPEC-144 unresolved risks
- Priority is caller-assigned (0..9); no dynamic aging is implemented, so a stream of high-priority tasks could delay low-priority ones (bounded by fairness SPEC-142 across tenants, not within a tenant). Acceptable per spec; 0 critical risks.
