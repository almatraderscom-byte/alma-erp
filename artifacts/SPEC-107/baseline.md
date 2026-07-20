# SPEC-107 Baseline — ABAC policy layer

## Current implementation and aliases
- No ABAC before this spec. `find src/agent/policy -name "*.ts" -not -path "*__tests__*"` → decision.ts (105), rbac.ts (106).
- Builds on SPEC-105 `PolicyLayer` and G11 `principalRoles()`.

## Callers and downstream dependencies
- None yet — registered as a sibling layer alongside RBAC by future integration wiring. SPEC-108 adds relationship auth; SPEC-109 obligations; SPEC-110 the bypass gate.

## Direct provider/model/tool/database calls
- None. Rules are a serializable predicate DSL over in-memory request attributes (INV-01). Verified by model-call-scan.

## Current tests / cost / latency evidence
- New: `src/agent/policy/__tests__/abac.test.ts` (15 cases). Zero model calls / tokens.

## Tenant / permission / audit propagation
- Tenant isolation is the engine's job (SPEC-105, pre-layer). ABAC only evaluates attribute conditions; it can read `resource.tenantId`/`identity.tenantId` if a rule wants extra defence.

## Likely bypass paths
- Non-serializable / code conditions — prevented: DSL is data-only (no eval, no function), zod-validated.
- Unbounded nesting DoS — prevented: `MAX_CONDITION_DEPTH` rejected at construction.
- Non-numeric ordering surprises — handled: lt/lte/gt/gte on non-numbers → no match (never a silent true).

## Proposed migration boundary
- One layer under the SPEC-105 choke point; feature modes handled at integration wiring.

## Files expected to change
- `src/agent/policy/abac.ts` (new), `src/agent/policy/__tests__/abac.test.ts` (new), `artifacts/SPEC-107/**`.
