# SPEC-129 — Test results
`npx vitest run src/agent/tool-gateway`
```
 Test Files  9 passed (9)
      Tests  50 passed (50)     # ...+4
```
Scoped tsc: 0. Full-repo tsc: 0.
Cases → tests: commits actual (clamped to reserved) to the ledger; over-actual
clamped; emits exactly ONE audit event with exact identity correlation + evidenceId;
abort AFTER reservation releases it (available restored, no leak).
