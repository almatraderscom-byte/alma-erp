# SPEC-168 Baseline — Frontier head planner contract
## Discovery
```text
$ rg -n "head-planner|HeadPlan" src/agent/runtime → NONE
$ rg -n "assertDeEscalated" src/agent/runtime/de-escalation.ts → SPEC-167 guard available
```
- Current: de-escalation guard (SPEC-167). No head-planner contract.
- Direct provider/model calls: none — the head planner is an INJECTED pure function
  (real model call is a documented seam; faked in tests).
- Tests: 42 green pre-spec.
- Bypass paths: head used as default executor / plan scheduling frontier execution.
  Prevented — head plans only; every step validated de-escalated + non-frontier.
- Migration boundary: additive; consumed by the regression gate (SPEC-170).
- Files expected: runtime/head-planner.ts, runtime/index.ts, tests, artifacts.
