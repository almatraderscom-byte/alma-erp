# SPEC-090 — Test results
`npx vitest run src/agent/capabilities`
```
 Test Files  10 passed (10)
      Tests  101 passed (101)     # 15+11+9+13+9+9+12+9+8+6
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Key: the live capability plane is CERTIFIED — all 8 facet checks pass, 0 blockers,
every capability brokers to a callable tool for an owner.
Cases → tests: all facet checks pass; certified with no blockers; 8 checks;
boundary certified + identity fail-closed + no-throw + malformed rejected.
