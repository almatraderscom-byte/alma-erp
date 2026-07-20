# SPEC-013 Contract — Fast-path router
`FAST_PATH_COMMANDS` map, `resolveFastPath(normalized)` → `FastPathHit|null`
(deterministic, no model), `fastPathStage` annotates ctx.fastPath. Unknown/absent
command falls through to classification. Rollback: `git revert --no-edit <SPEC-013 commit>`.
