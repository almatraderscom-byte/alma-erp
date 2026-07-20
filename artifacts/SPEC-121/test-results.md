# SPEC-121 — Test results
`npx vitest run src/agent/tool-gateway`
```
 Test Files  1 passed (1)
      Tests  8 passed (8)
```
Scoped `tsc -p src/agent/tool-gateway/tsconfig.json`: 0 errors. Full-repo tsc: 0.
Cases → tests: composer runs all stages; short-circuits on first non-success (later
stages never run); propagates NEEDS_APPROVAL/BUDGET_EXCEEDED verbatim; empty
pipeline completes; boundary validates envelope; missing tenant / malformed /
version-mismatch fail closed; never throws.
