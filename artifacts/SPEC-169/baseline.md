# SPEC-169 Baseline — Head-model tool-loop prohibition
## Discovery
```text
$ rg -n "tool-loop|isHeadInvocation" src/agent/runtime → NONE
$ rg -n "ModelTier" src/agent/models/tiers.ts           → G16 tiers available
```
- Current: head-planner contract (SPEC-168). No tool-loop guard.
- Direct provider/db calls: none — pure guard.
- Tests: 48 green pre-spec.
- Bypass paths: the head/frontier model running an agentic tool loop (defeats the
  router-worker split). Prevented — head-class invocations (role head OR tier T4) may
  not run any tool loop; fail-closed.
- Migration boundary: additive; consumed by the regression gate (SPEC-170).
- Files expected: runtime/head-tool-loop-guard.ts, runtime/index.ts, tests, artifacts.
