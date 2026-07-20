# SPEC-124 — Test results
`npx vitest run src/agent/tool-gateway`
```
 Test Files  4 passed (4)
      Tests  23 passed (23)     # 8+5+5+5
```
Scoped tsc: 0. Full-repo tsc: 0.
Cases → tests: ALLOW advances + carries obligations; no permit → non-success (fail-
closed default); missing principal/resource → DENIED; denial propagated verbatim;
never throws.
