# SPEC-096 — Test results
`npx vitest run src/agent/tools/selection src/agent/tools/results`
```
 Test Files  6 passed (6)
      Tests  49 passed (49)     # selection 38 + results 11
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: small payload passthrough + evidence stored; secret redaction;
oversize fails closed (truncated, viewBytes bounded, references evidence, full
payload retained); boundary bounded view + evidenceId; identity fail-closed + no-throw.
