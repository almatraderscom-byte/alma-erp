# SPEC-063 Contract — Break diagnostics
`diagnoseBreak(prev, cur)` -> `CacheBreakReason[]` (added/removed/version_changed), `explainBreak` -> {broke, reasons}. Deterministic, sorted. Rollback: `git revert --no-edit <SPEC-063 commit>`.
