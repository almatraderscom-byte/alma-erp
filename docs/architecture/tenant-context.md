# Tenant & Business Context Propagation (G01 / SPEC-005)

Source: `src/agent/contracts/tenant-context.ts`. Builds on SPEC-004 identity.

- `guardResourceAccess(identity, resource)` — fail-closed tenant (and business)
  isolation; cross-tenant/cross-business → `DENIED` + `CROSS_TENANT`.
- `withBusiness(identity, businessId, stepId?)` — narrow to a business context.
- `stampScope(identity, partial?)` — stamp caller tenant onto a new resource;
  never widens scope.
- `idempotencyKey(identity, resourceRef)` — deterministic key so unknown outcomes
  are reconciled, not blindly retried (INV-06).

Failure: typed `ComponentFailure`. Zero model calls. Rollback:
`git revert --no-edit <SPEC-005 commit>`.
