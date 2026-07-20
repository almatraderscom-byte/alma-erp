# SPEC-123 — Test results
`npx vitest run src/agent/tool-gateway`
```
 Test Files  3 passed (3)
      Tests  18 passed (18)     # 8+5+5
```
Scoped tsc: 0. Full-repo tsc: 0.
Cases → tests: full identity advances; each missing field → DENIED with the exact
reason code; cross-tenant → DENIED(CROSS_TENANT); matching tenant allowed; never throws.
