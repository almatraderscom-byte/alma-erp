# SPEC-088 — Test results
`npx vitest run src/agent/capabilities`
```
 Test Files  8 passed (8)
      Tests  87 passed (87)     # 15+11+9+13+9+9+12+9
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: resolves permitted+available intent; ranked cheaper-tier first;
excludes unpermitted (deniedByPermission>0); excludes kill-switched
(unavailable>0); no-match→resolved false; boundary COMPLETED/DENIED (fail-closed),
missing intent rejected, identity fail-closed + no-throw.
