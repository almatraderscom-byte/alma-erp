# SPEC-122 — Test results
`npx vitest run src/agent/tool-gateway`
```
 Test Files  2 passed (2)
      Tests  13 passed (13)     # 8 (121) + 5 (122)
```
Scoped tsc: 0. Full-repo tsc: 0.
Cases → tests: valid args advance; unknown tool DENIED(MALFORMED_INPUT); missing
required DENIED; oversized DENIED(OVERSIZED_INPUT); never throws.
