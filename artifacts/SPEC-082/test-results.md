# SPEC-082 — Test results
`npx vitest run src/agent/capabilities`
```
 Test Files  2 passed (2)
      Tests  26 passed (26)     # 15 (081) + 11 (082)
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: every cap reachable by query_<key>; write caps reachable by
command class; every intent key resolves; sorted/stable; whole-set clean;
consistency (manage_ without mutating class flagged / with class fine / read-only
fine); boundary identity fail-closed + no-throw.
