# SPEC-036 Contract — Model-call budget
`modelCallBudget(correlationId, stepId, limit)` (scope model_call). Rejects any single call over ceiling (fail-closed). Rollback: `git revert --no-edit <SPEC-036 commit>`.
