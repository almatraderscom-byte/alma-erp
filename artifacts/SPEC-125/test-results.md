# SPEC-125 — Test results
`npx vitest run src/agent/tool-gateway`
```
 Test Files  5 passed (5)
      Tests  28 passed (28)     # 8+5+5+5+5
```
Scoped tsc: 0. Full-repo tsc: 0.
Cases → tests: free call advances (no reservation); within-budget reserves + carries
reservation (available reflects reserved); over-budget → BUDGET_EXCEEDED; paid call
with no governor → BUDGET_EXCEEDED (fail-closed); never throws.
