# SPEC-142 rollback proof
`git revert --no-edit HEAD` removes fairness.ts and the barrel line; tree equals parent exactly (MATCH); `git reset --hard <spec-commit>` restores. One commit. Runtime: fairness is additive over SPEC-141 FIFO; `off` mode keeps plain per-tenant FIFO.
