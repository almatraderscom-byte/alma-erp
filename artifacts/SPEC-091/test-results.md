# SPEC-091 — Test results
`npx vitest run src/agent/tools/selection src/agent/tools/results`
```
 Test Files  1 passed (1)
      Tests  11 passed (11)
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: domain narrowing (sorted, < 326); permission-scoped (customer can't
retrieve owner tools → resolved false); guards (isRetrievableTool, 63 domains);
boundary intent COMPLETED, direct-domain COMPLETED, unresolved → DENIED (no full-
surface fallback), unknown domain → FAILED_FINAL, no-selector rejected, identity
fail-closed + no-throw.
