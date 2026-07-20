# SPEC-069 Contract — Isolation guard
`assertKeyTenant(key, callerTenantId)` -> `{ok, reason}` (fail-closed on unrecoverable/mismatch), `authorizedKeys(keys, caller)`. Rollback: `git revert --no-edit <SPEC-069 commit>`.
