# SPEC-078 — Test results
`npx vitest run src/agent/tools/registry`
```
 Test Files  6 passed (6)
      Tests  85 passed (85)     # 14+17+16+11+16+11
```
Owned-zone tsc: 0. Full-repo tsc: 0.

Cases → tests: callability (active/preview/deprecated-warn/removed-fail-closed),
migration chain to terminal successor, cycle detection (no infinite loop),
unresolved target, integrity (removeAfter ordering, missing replacement),
live-registry clean, boundary identity fail-closed + no-throw.
