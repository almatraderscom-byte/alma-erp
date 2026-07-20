# SPEC-095 — Test results
`npx vitest run src/agent/tools/selection src/agent/tools/results`
```
 Test Files  5 passed (5)
      Tests  44 passed (44)     # selection 38 + results 6
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: deterministic content-addressed id (same in/out, format); different
payloads differ; store retains full payload + dedupes + metadata; has/get; boundary
returns id+size only (payload/secret never echoed) while store keeps full payload;
identity fail-closed + no-throw.
