# SPEC-084 — Test results
`npx vitest run src/agent/capabilities`
```
 Test Files  4 passed (4)
      Tests  48 passed (48)     # 15+11+9+13
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Cases → tests: lattice (owner/staff/customer allow+deny matrix), fail-closed
(no roles, disabled, kill-switch), metadata integrity whole-set clean +
DEFAULT_NOT_DENY flagged, boundary ALLOWED/DENIED (unknown cap → DENIED,
customer-on-owner → DENIED), identity fail-closed + no-throw.
