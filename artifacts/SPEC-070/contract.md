# SPEC-070 Contract — Savings dashboard
`CacheEvent {kind, hit, savedNanoUsd, correctnessVerified}`, `computeSavings(events)` -> `CacheSavingsReport {total,hits,misses,hitRate,savedNanoUsd,byKind,verifiedHitRate}`. Rollback: `git revert --no-edit <SPEC-070 commit>`.
