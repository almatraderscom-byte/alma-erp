# SPEC-039 Contract — Denial policy
`DenialPolicy` (deny|degrade), `DEFAULT_DENIAL_POLICY=deny`, `resolveDenial(policy, ctx)` -> DENY|DEGRADE. DEGRADE only when policy=degrade AND a supplied option fits budget; else DENY. Rollback: `git revert --no-edit <SPEC-039 commit>`.
