# SPEC-049 Contract — Allocator
`TRUNCATE_PRIORITY`, `MUST_KEEP`, `allocate(bundles, maxTokens, estimator?)` -> `{compiled, status(FIT|TRUNCATED|OVERFLOW), droppedKinds, maxTokens}`. Deterministic. Rollback: `git revert --no-edit <SPEC-049 commit>`.
