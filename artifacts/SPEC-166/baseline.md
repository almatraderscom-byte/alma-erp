# SPEC-166 Baseline — Escalation budget enforcement
## Discovery
```text
$ rg -n "escalation.budget|maxFrontierPerDay" src/agent/routing → NONE
$ rg -n "fixedClock|Clock" src/agent/models/ports.ts             → G16 injected clock available
```
- Current: escalation reason contract (SPEC-165); no budget cap.
- Direct provider/db calls: none — deterministic counters, injected clock.
- Tests: 32 green pre-spec.
- Bypass paths: unbounded escalation loop / unlimited frontier calls. Prevented —
  per-actor per-day cap + stricter frontier cap, fail-closed BUDGET_EXCEEDED.
- Migration boundary: additive; layered on SPEC-165 (validate then consume).
- Files expected: routing/escalation-budget.ts, index.ts, tests, artifacts.
