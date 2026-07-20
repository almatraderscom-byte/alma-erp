# SPEC-106 Contract — RBAC policy layer

## Public surface (`src/agent/policy/rbac.ts`)
- `RbacLayer implements PolicyLayer` (`name:'rbac'`, `version`) — constructed from `RoleBinding[]`; immutable role map.
- `rbacLayer(bindings, version?)` — builder.
- `actionMatches(pattern, action)` — exact | `ns.*` (single namespace, no segment crossing) | `*` (all).
- `RoleBinding { role, allow[], deny? }` (zod-validated at construction; invalid ⇒ throw).
- `RBAC_REASON_CODES`: `RBAC_ROLE_GRANTED`, `RBAC_NO_ROLE_GRANT`, `RBAC_ROLE_EXPLICIT_DENY`.

## Behavior (fail-closed, INV-05)
- Explicit role `deny` matches → `deny` (overrides that role's grants).
- Any role `allow` matches → `permit`.
- Else → `abstain` (unknown role / no grant) so another layer may still permit; engine's default then denies.

## Failure / cost / security
- No throw across the boundary at evaluate-time; construction throws on malformed table (owner-authored, caught in tests).
- Cost: 0 model calls (INV-01). Deterministic.
- Security: tenant isolation is the engine's job (SPEC-105); RBAC never widens tenant scope.

## Rollback
`git revert --no-edit <SPEC-106 commit>` — restores exact pre-spec tree (see rollback-proof.md).
