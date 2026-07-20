# SPEC-147 rollback proof
`git revert --no-edit HEAD` removes observation-state.ts + barrel line; tree == parent (MATCH); reset --hard restores. One commit. Additive; `off` mode = pass-through disabled (no compaction), enforce = compacted view.
