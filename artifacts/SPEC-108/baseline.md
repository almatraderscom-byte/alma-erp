# SPEC-108 Baseline — Relationship authorization layer

## Current implementation and aliases
- No ReBAC before this spec. `find src/agent/policy -name "*.ts" -not -path "*__tests__*"` → decision.ts(105), rbac.ts(106), abac.ts(107).
- Builds on SPEC-105 `PolicyLayer` and the G11 `Principal` union.

## Callers and downstream dependencies
- None yet — registered as a sibling layer. SPEC-109 adds obligations; SPEC-110 the bypass gate.

## Direct provider/model/tool/database calls
- None. Relation tuples + requirements are in-memory data (INV-01), NOT a graph DB. Verified by model-call-scan.

## Current tests / cost / latency evidence
- New: `src/agent/policy/__tests__/relationship.test.ts` (12 cases). Zero model calls / tokens.

## Tenant / permission / audit propagation
- Tenant isolation is enforced pre-layer by the engine (SPEC-105). Subject refs are tenant-free `type:id` (`principalRef`) since tenant scoping already happened.

## Likely bypass paths
- Unbounded graph traversal — prevented: `maxGroupHops` (default 1) bounds indirection; direct + one member→group hop only.
- Instance-less permit — prevented: no `resource.id` ⇒ abstain (REL_NO_RESOURCE_ID), never a silent permit.
- Deny bypass — prevented: deny-relations scanned before permit-relations (veto wins).

## Proposed migration boundary
- One layer under the SPEC-105 choke point; feature modes at integration wiring.

## Files expected to change
- `src/agent/policy/relationship.ts` (new), `src/agent/policy/__tests__/relationship.test.ts` (new), `artifacts/SPEC-108/**`.
