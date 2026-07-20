# SPEC-098 — Test results
`npx vitest run src/agent/tools/selection src/agent/tools/results`
```
 Test Files  8 passed (8)
      Tests  68 passed (68)     # selection 38 + results 30
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: {results}/{organic}/bare-array+strings shapes; drop javascript:/data:
urls; snippet cap; item bound (truncated + MAX_ITEMS); skip empty rows; boundary
COMPLETED / empty→FAILED_FINAL / identity fail-closed + no-throw.
