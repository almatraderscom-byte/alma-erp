# SPEC-144 rollback proof
`git revert --no-edit HEAD` removes scheduling.ts + barrel line; tree == parent (MATCH); reset --hard restores. One commit. Runtime: `off` = FIFO (SPEC-141), `enforce` = priority/EDF.
