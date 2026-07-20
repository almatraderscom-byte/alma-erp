# SPEC-155 Baseline — Standard reasoner T3 tier
## Discovery
```text
$ rg -n "T3" src/agent/models/tier-handler.ts  → not registered (T0,T1,T2)
$ rg -n "governor|createGovernorCostPort" src/agent/models → NONE (cost port was a fake-only seam)
$ rg -n "authorize|settle|cancel" src/agent/control-plane/cost/governor.ts → real G04 governor available
$ rg -n "estimateWorstCaseCost|estimateNormalCost" src/agent/finops/estimator.ts → real G03 estimator
```
- Current: fabric + T0/T1/T2. Cost governance was a port with FAKE only.
- This spec adds T3 handler AND the real G04-governor-backed cost port
  (`createGovernorCostPort`) wiring G03 pricing/estimator — the representative
  production cost flow (INV-03 made real).
- Direct provider/db calls: none (pure arithmetic over in-memory store; FAKE adapter).
- Tests: 45 green pre-spec.
- Migration boundary: additive; register `T3`, add cost-port binding.
- Files expected: `t3.ts`, `cost-port.ts` (new), `tier-handler.ts`, `index.ts`,
  `tsconfig.json` (+control-plane include), tests, artifacts.
