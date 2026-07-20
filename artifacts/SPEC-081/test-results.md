# SPEC-081 — Test results
`npx vitest run src/agent/capabilities`
```
 Test Files  1 passed (1)
      Tests  15 passed (15)
```
Owned-zone tsc: 0. Full-repo tsc: 0. Catalog regenerates byte-identical (deterministic).

Cases → tests: catalog integrity (63, valid, unique+sorted, id==cap.key, ≥1
tool/intent/class), schema validation (id/key mismatch, empty tools/intents,
disabled-but-healthy, duplicate tools, unknown intent class), store fail-closed
(duplicate id/key, invalid capability), boundary identity fail-closed + version
mismatch + no-throw.
