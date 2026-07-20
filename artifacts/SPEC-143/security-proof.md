# SPEC-143 security proof
- Per-tenant isolation: `maxInFlightPerTenant` counts only LEASED tasks of that tenant; one tenant cannot exhaust another's concurrency budget.
- DoS defense: `maxDepthPerDomain` sheds load at the edge (QUEUE_FULL) instead of growing an unbounded backlog.
- Fail-closed: malformed limits / missing tenant deny; at-capacity denies with retry hint (never over-commit).
