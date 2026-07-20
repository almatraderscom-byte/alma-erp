# SPEC-106 Baseline — RBAC policy layer

## Current implementation and aliases
- No RBAC layer before this spec. Discovery: `find src/agent/policy -name "*.ts" -not -path "*__tests__*"` → only `decision.ts` (SPEC-105).
- Builds on SPEC-105 `PolicyLayer`/`PolicyEngine` and G11 `principalRoles()` (`src/agent/identity/principals.ts`).

## Callers and downstream dependencies
- None yet. `RbacLayer` is registered into a `PolicyEngine` by future integration wiring. SPEC-107/108 add sibling layers; SPEC-110 the bypass gate.

## Direct provider/model/tool/database calls
- None. Roles resolve through an in-memory `RoleBinding[]` table (pure data, NOT a DB). Verified by model-call-scan.

## Current tests / cost / latency evidence
- New: `src/agent/policy/__tests__/rbac.test.ts` (15 cases). Zero model calls / tokens.

## Tenant / permission / audit propagation
- Layer is tenant-agnostic by design — the engine (SPEC-105) enforces tenant isolation before any layer runs. RBAC only maps roles→actions.

## Likely bypass paths
- Implicit-permit on unknown role — mitigated: unknown role ⇒ abstain (never permit).
- Wildcard over-grant — mitigated: `ns.*` never crosses a segment; bare `*` is owner-only by table convention; explicit `deny` overrides `allow`.

## Proposed migration boundary
- RBAC is one layer under the SPEC-105 choke point; feature modes handled at integration wiring.

## Files expected to change
- `src/agent/policy/rbac.ts` (new), `src/agent/policy/__tests__/rbac.test.ts` (new), `artifacts/SPEC-106/**`.
