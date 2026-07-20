# SPEC-164 Baseline — Measured model router
## Discovery
```text
$ rg -n "routeModel|measured-router" src/agent/routing → NONE
$ rg -n "ROUTABLE_TIERS|frontier" src/agent/routing     → NONE (invariant not yet enforced)
$ rg -n "candidates|primary" src/agent/models/registry.ts → G16 tier→candidate bindings
```
- Current: SPEC-161/162/163 records + scores. No router.
- Direct provider/model calls: none — the router DECIDES; G16 fabric (FAKE adapter) invokes.
- Tests: 17 green pre-spec.
- Bypass paths (the crux): defaulting to a frontier head model. Prevented — the router
  refuses T4 (DENIED) and T0; picks only T1..T3; no-telemetry fallback is the registry
  PRIMARY (cheapest, non-frontier), never frontier.
- Migration boundary: additive; consumed by the runtime head/worker split (SPEC-167..170).
- Files expected: routing/measured-router.ts, index.ts, tests, artifacts.
