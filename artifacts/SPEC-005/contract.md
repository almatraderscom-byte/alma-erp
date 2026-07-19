# SPEC-005 Contract — Tenant context
`guardResourceAccess(identity, resource)` fail-closed cross-tenant/business
rejection (CROSS_TENANT); `withBusiness`, `stampScope` (never widens),
`idempotencyKey` (deterministic, INV-06). Typed failures, zero model calls.
Rollback: `git revert --no-edit <SPEC-005 commit>`.
