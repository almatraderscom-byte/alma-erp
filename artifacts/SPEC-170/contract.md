# SPEC-170 Contract — Routing and head-isolation regression gate
- `runRoutingHeadIsolationRegression(deps?)` → `RegressionReport{passed, checks[]}`
  (never throws). Exercises the REAL group functions and asserts 8 invariant checks:
  router refuses frontier default; default routes non-frontier; escalation needs a
  reason; frontier needs a frontier-eligible reason; budget caps frontier; de-escalation
  never frontier; head planner rejects frontier-execution; head-class no tool loop.
- Deps are injectable (default = real functions) so a broken component is provably CAUGHT
  (tests inject a frontier-leaking router and a frontier-returning de-escalation → passed=false).
- Deterministic (internal fixed clock); no provider call.
