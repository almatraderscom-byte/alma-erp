# SPEC-050 Contract — Provenance & replay
`ContextReplayRecord {contractVersion, bundles, totalTokens, cacheablePrefixTokens, contentHash}`, `hashContext(text)` (sha256), `buildReplayRecord(compiled)`, `verifyReplay(record, recompiled)`. Deterministic replay verification. Rollback: `git revert --no-edit <SPEC-050 commit>`.
