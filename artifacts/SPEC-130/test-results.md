# SPEC-130 — Test results
`npx vitest run src/agent/tool-gateway`
```
 Test Files  10 passed (10)
      Tests  60 passed (60)     # ...+10
```
Scoped tsc: 0. Full-repo tsc: 0.
CLI gate on the real tree: `node .../check-gateway-bypass.mjs` → "1045 files scanned,
PASS", exit 0 (FALSE-POSITIVE-FREE).

Note (honesty): an intermediate test run FAILED (1 of 60) — my own test asserted the
raw NETWORK_CALL_RE matches the bare word "fetch"; it does not (the regex requires a
call `fetch(`, which is correct precision). Fixed the test expectation; re-run green.
PASS was NOT certified until BOTH vitest and tsc were clean.
Cases → tests: classifiers; import detection; regex precision; Rule A flags core
fetch / exempts adapter stage / exempts comment+opt-out / passes clean; Rule B flags
gateway-importer bypass / ignores legacy out-of-scope / ignores tests.
