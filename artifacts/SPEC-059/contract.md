# SPEC-059 Contract — Lifecycle
`isExpired(expiresAtMs, nowMs)`, `MemoryLifecycleIndex` (setExpiry/supersede/isActive/currentId/filterActive). Corrections supersede (never mutate); rejects self-supersession. Rollback: `git revert --no-edit <SPEC-059 commit>`.
