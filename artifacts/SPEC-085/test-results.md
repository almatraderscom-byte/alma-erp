# SPEC-085 — Test results
`npx vitest run src/agent/capabilities`
```
 Test Files  5 passed (5)
      Tests  57 passed (57)     # 15+11+9+13+9
```
Owned-zone tsc: 0. Full-repo tsc: 0.
Integration: checkAllCostMetadata() === [] — every capability's declared tier/class
matches its G08 tools' real cost drivers (SPEC-081 seed validated vs SPEC-085).
Cases → tests: external tool→standard; class tracks tier; hints strictly increasing;
whole-set clean; TIER_MISMATCH / CLASS_MISMATCH flagged; boundary identity
fail-closed + no-throw.
