# SPEC-075 — Test results
`npx vitest run src/agent/tools/registry`
```
 Test Files  3 passed (3)
      Tests  47 passed (47)     # 14 inventory + 17 io + 16 risk
```
Owned-zone tsc: 0. Full-repo tsc: 0.

Key integration test: "every generated manifest passes classification
consistency" — all 326 SPEC-073 seeds validated against the SPEC-075 policy
(checkAllClassifications(ALL_MANIFESTS) === []).

Cases → tests: policy coverage, gateway (INV-04), cost-auth (INV-03),
reconciliation (INV-06), approval fail-closed (INV-05), money→high, read purity,
write-needs-effect, whole-set consistency, boundary identity + fail-closed + no-throw.
