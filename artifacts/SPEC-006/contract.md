# SPEC-006 Contract — Error taxonomy
`ERROR_TAXONOMY` (11 categories → status+reason+retry), `AiosError`,
`toComponentFailure`, `isRetryable`, `normalizeError(unknown)` (boundary net —
any throw → typed failure, never re-thrown). Zero model calls. Rollback:
`git revert --no-edit <SPEC-006 commit>`.
