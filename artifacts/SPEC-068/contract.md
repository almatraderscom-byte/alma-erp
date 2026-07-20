# SPEC-068 Contract — Cache exclusions
`isCacheable({intent, risk, hasSideEffect, permissionDependent})` -> `{cacheable, reason}`. FAIL-CLOSED: side-effect/permission/HIGH-risk/non-read-only => never cache. Rollback: `git revert --no-edit <SPEC-068 commit>`.
