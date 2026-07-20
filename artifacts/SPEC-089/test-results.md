# SPEC-089 — Test results
`npx vitest run src/agent/capabilities`
```
 Test Files  9 passed (9)
      Tests  95 passed (95)     # 15+11+9+13+9+9+12+9+8
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Note: an intermediate run caught a real defect — `callability` was imported via the
bare `@/agent/tools/registry` (→ monolith file). Fixed to the explicit decoupled
path `@/agent/tools/registry/deprecation`; re-run green. (PASS was NOT certified
until both the vitest summary AND tsc were clean.)
Cases → tests: callableTools real+ranked; broker primary+fallbacks; kill-switch →
null (fail-closed); unpermitted → null; class query brokers across caps; boundary
COMPLETED/DENIED + identity fail-closed + no-throw.
