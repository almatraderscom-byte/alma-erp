# SPEC-110 Baseline — Authorization bypass CI and runtime gate

## Current implementation and aliases
- Final G11 spec. Prior policy files: decision.ts(105), rbac.ts(106), abac.ts(107), relationship.ts(108), obligations.ts(109). No bypass gate / runtime guard existed.
- Mirrors the proven SPEC-020 admission bypass gate (`src/agent/control-plane/admission/bypass-gate.ts` + `check-admission-bypass.mjs`): pure checker + repo-walking .mjs runner + precise import resolver.

## Callers and downstream dependencies
- Runtime guard (`runIfAuthorized`) is the choke point later side-effect code (Tool Gateway, writers) will call. CI runner wires into the architecture check suite alongside check-admission-bypass / check-forbidden-imports.

## Direct provider/model/tool/database calls
- None. Static text/import analysis + pure guard (INV-01). Verified by model-call-scan.

## Current tests / cost / latency evidence
- New: guard.test.ts (7 cases), bypass-gate.test.ts (12 cases). Zero model calls / tokens.
- Gate self-run: `node src/agent/policy/check-authorization-bypass.mjs` → PASS, 999 files scanned, 0 violations.

## Tenant / permission / audit propagation
- Guard enforces the engine's decision (which already did tenant isolation, SPEC-105). `runIfAuthorized` passes obligations (SPEC-109) to the side effect for audit/redaction honouring.

## Likely bypass paths (what this gate closes)
- Side effect proceeding without an ALLOW — closed: `runIfAuthorized` never invokes the thunk on non-ALLOW (fail-closed, INV-05).
- Self-authorizing on a single layer's `.evaluate()` — closed: CI flags layer deep-import + `.evaluate(` outside the policy package.
- Hand-rolled role-literal authz in authz-aware code — closed: CI flags raw `=== 'owner'` / `.roles.includes('admin')` in files importing policy/identity (scoped to avoid the 'owner'-as-data false positives seen in existing tools).

## Proposed migration boundary
- `runIfAuthorized` is the single runtime enforcement wrapper; the .mjs gate runs in CI. Feature modes handled at integration wiring.

## Files expected to change
- `src/agent/policy/guard.ts`, `bypass-gate.ts`, `index.ts`, `check-authorization-bypass.mjs` (all new), `__tests__/guard.test.ts`, `__tests__/bypass-gate.test.ts` (new), `artifacts/SPEC-110/**`.
