# SPEC-168 Contract — Frontier head planner contract
- `PlanRequest{identity, taskClass, planningTier}`, `PlanStep{stepId, taskClass, executionTier}`,
  `HeadPlan{planningTier, steps}`. `HeadPlannerFn` = pure injected head (real call is a seam).
- `runHeadPlanner(req, {planner})` → validate identity (fail-closed, planner not invoked on
  bad identity) → run planner → `validateHeadPlan`.
- `validateHeadPlan`: non-empty, unique step ids, EVERY step de-escalated + non-frontier
  (propagates SPEC-167 `EXEC_FRONTIER_FORBIDDEN`/`EXEC_NOT_DEESCALATED`). The head is a
  planner only — never the default executor.
