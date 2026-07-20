# SPEC-170 Baseline — Routing and head-isolation regression gate
## Discovery
```text
$ rg -n "regression|RegressionReport" src/agent/runtime → NONE
$ ls src/agent/routing src/agent/runtime → all SPEC-161..169 modules present
```
- Current: all group functions (161-169) exist; no single executable invariant gate.
- Direct provider/db calls: none — exercises real group functions with synthetic inputs.
- Tests: 55 green pre-spec.
- Bypass paths: a future edit silently weakening an invariant (frontier default,
  de-escalation, head tool-loop). Prevented — the gate runs the REAL functions and fails
  if any invariant regresses; injectable deps prove it has teeth.
- Migration boundary: additive; the CI regression gate for the whole group.
- Files expected: runtime/regression-gate.ts, runtime/index.ts, tests, artifacts.
