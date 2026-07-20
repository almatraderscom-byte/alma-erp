# SPEC-032 Contract — Business budget
`businessBudget(tenant, business, yearMonth, limit)` (scope 'business', isolated key),
`DEFAULT_BUDGET_LIMITS.business` (owner-tunable placeholder). Enforced by governor.
Rollback: `git revert --no-edit <SPEC-032 commit>`.
