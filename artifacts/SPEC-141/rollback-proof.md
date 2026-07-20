# SPEC-141 rollback proof

Drill: after committing SPEC-141, `git revert --no-edit HEAD` removes the entire `src/worker/queues` addition; tree then equals the parent commit exactly (`git diff <parent> HEAD` empty). Then `git reset --hard <spec-commit>` restores the commit. Net: one commit. MATCH confirmed (see group log).

Runtime rollback: the queue path is feature-flagged via G01 `feature-flag.ts`; `rollback`/`off` modes disable the new authoritative path with no legacy dependency to break (additive zone).
