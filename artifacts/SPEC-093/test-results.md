# SPEC-093 — Test results
`npx vitest run src/agent/tools/selection src/agent/tools/results`
```
 Test Files  3 passed (3)
      Tests  27 passed (27)     # 11+8+8
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: drops annotations + trims prop descriptions + keeps contract keys;
after ≤ before for 40 real tools; root description capped; unknown → null;
aggregate tokensSaved≥0 consistent; boundary COMPLETED / all-unknown FAILED_FINAL /
identity fail-closed + no-throw.
