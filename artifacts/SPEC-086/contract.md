# SPEC-086 — Contract (runtime-owner.ts, v1.0.0)
- `expectedRuntime(toolNames): {groups[],pools[]}` — union of G08 tool routing.
- `checkRuntimeOwner(c)/checkAllRuntimeOwner(set): RuntimeOwnerIssue[]` —
  RUNTIME_GROUPS_MISMATCH | RUNTIME_POOLS_MISMATCH | UNOWNED_ZONE |
  NOT_AGENT_ZONE | INTEGRATION_ONLY | TEAM_MISMATCH (via G01 resolveOwner).
- Boundary `queryRuntimeOwner(raw): ComponentResult` — COMPLETED when clean,
  DENIED/POLICY_DENIED on any violation (fail-closed); identity-enforced; no throw.
