# SPEC-143 rollback proof
`git revert --no-edit HEAD` removes concurrency.ts + barrel line; tree == parent (MATCH); `git reset --hard <spec-commit>` restores. One commit. Runtime: `off` mode = unbounded legacy behaviour, `enforce` = caps active.
