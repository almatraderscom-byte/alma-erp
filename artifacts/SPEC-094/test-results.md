# SPEC-094 — Test results
`npx vitest run src/agent/tools/selection src/agent/tools/results`
```
 Test Files  4 passed (4)
      Tests  38 passed (38)     # 11+8+8+11
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: valid curated-schema accept; missing-required / unknown-field →
invalid_args; unknown tool → unknown_tool; oversized → oversized_args; never
throws; boundary ALLOWED / DENIED(MALFORMED_INPUT) / DENIED(unknown) /
DENIED(OVERSIZED_INPUT) / identity fail-closed + no-throw.
