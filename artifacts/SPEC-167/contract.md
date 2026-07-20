# SPEC-167 Contract — De-escalation after planning
- `deEscalatedExecutionTier(planningTier)` → execution ceiling = one tier below
  planning, floored at T1, never T4 (T4→T3, T3→T2, T2→T1, T1→T1).
- `assertDeEscalated(planningTier, executionTier)` → `ComponentResult`: fail-closed
  `EXEC_FRONTIER_FORBIDDEN` (execution at T4) / `EXEC_NOT_DEESCALATED` (above ceiling).
  Deterministic; execution may be T0 (deterministic) or any tier ≤ ceiling.
