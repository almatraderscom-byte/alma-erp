# SPEC-033 Contract — User budget
`userBudget(tenant, actorId, yearMonth, limit)` (scope 'user', isolated per actor).
Enforced by governor, fail-closed. Rollback: `git revert --no-edit <SPEC-033 commit>`.
