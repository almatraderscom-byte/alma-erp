# SPEC-079 — Test results
`npx vitest run src/agent/tools/registry`
```
 Test Files  7 passed (7)
      Tests  96 passed (96)     # 14+17+16+11+16+11+11
```
Owned-zone tsc: 0. Full-repo tsc: 0.

Cases → tests: feature-flag authority (legacy under off/shadow/warn/rollback; new
only under enforce), 326-tool assembly with facets, model-facing definitions,
enforce drops removed tools (fail-closed), **shadow parity with inventory (326
matched, 0 drift)**, drift detection, boundary identity fail-closed + no-throw.
