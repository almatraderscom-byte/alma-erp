# SPEC-056 Contract — Episodic memory
`EpisodeRecord {id,identity,action,outcome,summary,atMs}`, `EpisodicMemory` (record/recall by action+outcome, most-recent-first, tenant-scoped, fail-closed). Rollback: `git revert --no-edit <SPEC-056 commit>`.
