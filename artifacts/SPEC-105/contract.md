# SPEC-105 Contract — Unified policy decision API

## Public surface (`src/agent/policy/decision.ts`)
- `PolicyEngine` — immutable, holds an ordered `PolicyLayer[]`; `.decide(input): ComponentResult<PolicyDecisionValue>`; `.layerNames()`.
- `decidePolicy(input, layers)` — one-shot convenience.
- Types: `PolicyEvaluationInput { identity, principal, action, resource, context? }`, `PolicyResource { type, id?, tenantId?, attributes? }`, `PolicyLayer { name, evaluate }`, `LayerVerdict { layer, effect: permit|deny|abstain, reasonCodes, obligations? }`, `PolicyDecisionValue { effect:'ALLOW', action, principalKey, permittedBy, obligations }`.
- `POLICY_REASON_CODES` (G11-local, append-only): `POLICY_MALFORMED_REQUEST`, `POLICY_PRINCIPAL_TENANT_MISMATCH`, `POLICY_RESOURCE_TENANT_MISMATCH`, `POLICY_NO_APPLICABLE_PERMIT`, `POLICY_EXPLICIT_DENY`.

## Result shape
- Reuses G01 `ComponentResult`: success = `allowed(value)` (`status:'ALLOWED'`), failure = `{ status:'DENIED', reasonCodes, evidenceIds }`. No boolean, no throw across the boundary.

## Combining rule (fail-closed, INV-05)
1. Malformed request → DENY(`POLICY_MALFORMED_REQUEST`).
2. Principal/resource tenant ≠ operation tenant → DENY(`CROSS_TENANT` + mismatch code) — before layers run.
3. Any layer `deny` → DENY(`POLICY_EXPLICIT_DENY` + layer reasons) — deny overrides.
4. Else ≥1 layer `permit` → ALLOW (union of obligations, permittedBy list).
5. Else (zero layers / all abstain) → DENY(`POLICY_NO_APPLICABLE_PERMIT`).

## Failure / cost / security
- Failure behavior: every non-ALLOW path is a typed DENY with finite reason codes.
- Cost: 0 model calls, deterministic (INV-01).
- Security boundary: tenant isolation enforced pre-layer; engine layer array is frozen (defensive copy) so post-construction mutation cannot inject a layer.

## Rollback
`git revert --no-edit <SPEC-105 commit>` — restores exact pre-spec tree (see rollback-proof.md).
