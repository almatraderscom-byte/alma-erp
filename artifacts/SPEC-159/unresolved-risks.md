# SPEC-159 Unresolved Risks
1. Failover reuses the primary's single cost reservation; candidates are same-tier
   equivalents (comparable price, governor clamps actual ≤ reserved). Per-attempt
   re-authorization is a future refinement (documented).
2. Ordering is the static registry order; adaptive/health-based ordering is a seam.
No unresolved **critical** risks. Count: 0.
