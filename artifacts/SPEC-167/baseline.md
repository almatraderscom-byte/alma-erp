# SPEC-167 Baseline — De-escalation after planning
## Discovery
```text
$ ls src/agent/runtime → tsconfig only (greenfield for runtime code)
$ rg -n "tierRank|MODEL_TIERS" src/agent/models/tiers.ts → G16 tier ranks available
```
- Current: routing zone (161-166) done. runtime zone greenfield.
- Direct provider/db calls: none — pure tier arithmetic.
- Tests: 37 green pre-spec.
- Bypass paths: execution steps running at frontier after a frontier plan. Prevented —
  execution ceiling = one tier below planning, floored T1, never T4; guard fails closed.
- Migration boundary: additive; consumed by the head planner (SPEC-168) + regression gate.
- Files expected: runtime/de-escalation.ts, runtime/index.ts, tests, artifacts.
