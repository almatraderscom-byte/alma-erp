# SPEC-124 — Baseline (policy decision stage)
Parent: SPEC-123 (`1f3b2664`). Owned zone: src/agent/tool-gateway.

G11 provides `decidePolicy(input, layers): ComponentResult<PolicyDecisionValue>`
(fail-closed default deny; permit carries obligations). The gateway needs an
authorization stage that delegates to it and stops on any non-ALLOW.
Discovery:
```
$ grep -n "export function decidePolicy" src/agent/policy/decision.ts
$ grep -n "obligations" src/agent/policy/decision.ts
$ grep -n "humanPrincipal\|Principal" src/agent/identity/principals.ts
```
Migration boundary: a stage building PolicyEvaluationInput from context +
decidePolicy; obligations carried forward for SPEC-126.
Files: contract.ts (edit: +principal/resource/policyContext), stages/policy-decision.ts,
gateway.ts (edit), index.ts (edit), tests.
