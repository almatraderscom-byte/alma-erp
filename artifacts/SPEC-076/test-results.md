# SPEC-076 — Test results
`npx vitest run src/agent/tools/registry`
```
 Test Files  4 passed (4)
      Tests  58 passed (58)     # 14 + 17 + 16 + 11
```
Owned-zone tsc: 0. Full-repo tsc: 0.

Integration: "every generated manifest has valid ownership"
(checkAllOwnership(ALL_MANIFESTS) === []); rollup covers 63 domains / 326 tools.

Cases → tests: valid, UNOWNED_ZONE, NOT_AGENT_ZONE (ERP rejected), INTEGRATION_ONLY
(prisma choke point rejected), TEAM_MISMATCH, whole-set validity, deterministic
rollup + CODEOWNERS proposal, boundary DENIED fail-closed + identity + no-throw.
