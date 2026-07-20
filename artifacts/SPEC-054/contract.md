# SPEC-054 Contract — Compaction
`planCompaction(entries, {triggerAt, keepRecent})` -> `{needed, keep, compact}`. Deterministic; system entries always kept. Summary generation is a seam (not in this module). Rollback: `git revert --no-edit <SPEC-054 commit>`.
