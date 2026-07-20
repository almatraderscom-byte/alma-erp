# SPEC-038 Contract — Browser-task budget
`browserTaskBudget(taskId, limit)` (scope browser_task). Fail-closed past cap, keyed per task. Rollback: `git revert --no-edit <SPEC-038 commit>`.
