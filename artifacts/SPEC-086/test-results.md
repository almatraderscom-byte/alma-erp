# SPEC-086 — Test results
`npx vitest run src/agent/capabilities`
```
 Test Files  6 passed (6)
      Tests  66 passed (66)     # 15+11+9+13+9+9
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Integration: checkAllRuntimeOwner() === [] — every capability's runtime matches its
tools and owner resolves to a valid agent zone.
Cases → tests: expectedRuntime union; whole-set clean; fabricated group / unbacked
pool flagged; ERP zone rejected; wrong team flagged; integration-only rejected;
boundary DENIED fail-closed + identity + no-throw.
