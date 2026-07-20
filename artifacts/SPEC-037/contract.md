# SPEC-037 Contract — Tool-loop budget
`toolLoopBudget(workflowId, limit)` (scope tool_loop). Repeated calls stop at the loop cap (runaway protection). Rollback: `git revert --no-edit <SPEC-037 commit>`.
