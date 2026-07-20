# SPEC-105 Baseline — Unified policy decision API

## Current implementation and aliases
- No prior policy decision engine exists. Discovery commands:
  - `grep -rn "decidePolicy\|PolicyEngine\|policyDecision\|src/agent/policy" src/` → no matches (new zone).
  - `find src/agent/policy -name "*.ts" -not -path "*__tests__*"` → empty before this spec.
- G01 already provides the boundary idiom this reuses: `ComponentResult`, `allowed()`, `REASON_CODES` (incl. `CROSS_TENANT`, `POLICY_DENIED`), `executionIdentitySchema` in `src/agent/contracts/component.ts`.
- G11/SPEC-101..104 already provide the `Principal` union + `principalKey` in `src/agent/identity/principals.ts`.

## Callers and downstream dependencies
- None yet. SPEC-106..109 (RBAC/ABAC/relationship/obligations) will register `PolicyLayer`s into this engine; SPEC-110 adds the bypass gate. No production caller — engine is dormant until wired behind a feature flag by a later integration checkpoint.

## Direct provider/model/tool/database calls
- None. Deterministic pure functions only (INV-01). Verified by `model-call-scan` evidence.

## Current tests / cost / latency evidence
- New surface: `src/agent/policy/__tests__/decision.test.ts` (30 tests total in zone).
- Cost: zero model calls, zero tokens (see cost-before-after.md).

## Tenant / permission / audit propagation
- Engine takes a full `ExecutionIdentity` and a `Principal`; both tenants (+ resource tenant) must match the operation tenant or it is a `CROSS_TENANT` denial before any layer runs (INV-02).

## Likely bypass paths
- A caller reading `ALLOW` without checking `status` — mitigated: result is a typed discriminated union, `DENIED` has no `value`.
- Treating `abstain` as permit — mitigated: abstain never grants; explicit permit required.
- Empty-layer engine silently allowing — mitigated: zero layers ⇒ `NO_APPLICABLE_PERMIT` DENY (fail-closed).

## Proposed migration boundary
- `PolicyEngine`/`decidePolicy` is the single authorization choke point; feature modes (off/shadow/warn/enforce/rollback) governed at the future integration wiring — engine itself is authoritative-neutral (pure decision).

## Files expected to change
- `src/agent/policy/decision.ts` (new), `src/agent/policy/__tests__/decision.test.ts` (new), `artifacts/SPEC-105/**`.
