# SPEC-092 — Test results
`npx vitest run src/agent/tools/selection src/agent/tools/results`
```
 Test Files  2 passed (2)
      Tests  19 passed (19)     # 11 (091) + 8 (092)
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: never exceeds cap / MAX_SHORTLIST (truncated flagged); read ranked
before write; deterministic + de-dupe; zero/neg cap clamped to 1; shortlistForIntent
bounded; boundary COMPLETED bounded / DENIED unresolved / identity fail-closed + no-throw.
