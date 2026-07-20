# Canonical Execution Identity (G01 / SPEC-004)

Source: `src/agent/contracts/execution-identity.ts`. Realises invariant INV-02.

## Shape
`ExecutionIdentity` = tenantId, businessId?, actorId, agentId?, workflowId,
stepId, correlationId (from `component.ts`).

## Builder / propagation
- `createExecutionIdentity(input)` — validates, fail-closed; derives a
  deterministic `correlationId` (sha256 of tenant|workflow|step|actor) when none
  is supplied. No time / RNG → replayable.
- `deriveChildStep(parent, stepId)` — propagates identity down the request path
  (Admission → Cost → Context → … → Gateway), keeping ONE correlation id per run.
- `sameTenant(a, b)` — cross-tenant guard seed (enforced in SPEC-005).
- `identityAuditFields(id)` — flat record for audit + metrics rows.

## Failure behaviour
Missing tenant/actor/workflow/step/correlation → typed `ComponentFailure` with a
specific reason code (MISSING_TENANT, …). Never throws across the boundary.

## Cost / security
Zero model calls. Identity fields are ids, not secrets. Deterministic hashing via
node:crypto (local, no network).

## Rollback
`git revert --no-edit <SPEC-004 commit>`.
