# SPEC-097 — Test results
`npx vitest run src/agent/tools/selection src/agent/tools/results`
```
 Test Files  7 passed (7)
      Tests  58 passed (58)     # selection 38 + results 20
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: array head+omitted; numeric digest; string truncate+len; depth clip;
object key clip; deterministic + no undefined-clobber; small passthrough; boundary
COMPLETED (_omitted correct) + identity fail-closed + no-throw.
