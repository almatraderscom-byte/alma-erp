# SPEC-004 Contract — Execution identity
Module: `src/agent/contracts/execution-identity.ts`.
- `createExecutionIdentity(input)` → `{ok, identity} | {ok:false, failure}`, fail-closed.
- `deriveCorrelationId(...parts)` — deterministic sha256 (no time/RNG).
- `deriveChildStep(parent, stepId)` — propagate identity, one correlation per run.
- `sameTenant(a,b)`, `identityAuditFields(id)`.
Reason codes reused from `component.ts` (MISSING_TENANT, MISSING_ACTOR, …).
Failure: typed `ComponentFailure`, never a throw. Zero model calls. Rollback:
`git revert --no-edit <SPEC-004 commit>`.
