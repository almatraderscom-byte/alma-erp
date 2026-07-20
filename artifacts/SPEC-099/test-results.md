# SPEC-099 — Test results
`npx vitest run src/agent/tools/selection src/agent/tools/results`
```
 Test Files  9 passed (9)
      Tests  74 passed (74)     # selection 38 + results 36
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: traceable envelope tied to evidence+identity; truncation propagated;
completeness check flags missing fields + bad source; isTraceable; boundary emits
provenanced view / never emits un-traceable; identity fail-closed + no-throw.
