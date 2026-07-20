# SPEC-067 Contract — Tool-result cache
`ToolResultEntry {key, result, storedAtMs, ttlMs}`, `ToolResultCache` (put[skips ttl<=0]/get[evicts stale]). Freshness-guaranteed. Rollback: `git revert --no-edit <SPEC-067 commit>`.
