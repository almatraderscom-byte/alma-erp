# SPEC-080 — Test results
`npx vitest run src/agent/tools/registry src/agent/tools/manifests`
```
 Test Files  10 passed (10)
      Tests  140 passed (140)
```
Owned-zone tsc: 0. Full-repo tsc: 0.

Cases → tests: all 7 metadata preconditions PASS on the live manifest set;
default gate is BLOCKED with CUTOVER the sole blocker (fail-closed, INV-09);
removable only with cutover sign-off; proposed plan documented not executed;
boundary identity fail-closed + no-throw; gate deletes nothing.
