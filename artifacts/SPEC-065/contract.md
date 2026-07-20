# SPEC-065 Contract — Response cache
`CachedResponse {key, response, storedAtMs, savedNanoUsd}`, `ResponseCache` (get/put/size), `InMemoryResponseCache` (+stats hits/misses, copy-on-read). Tenant isolation via the key. Rollback: `git revert --no-edit <SPEC-065 commit>`.
