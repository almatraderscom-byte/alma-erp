# SPEC-078 — Rollback proof

The spec is one additive commit confined to owned zones. Rollback = `git revert`
of that commit, which must restore the parent tree exactly.

## Drill
```
PARENT_TREE=$(git rev-parse 'HEAD~1^{tree}')
git revert --no-edit HEAD ; REVERT_TREE=$(git rev-parse 'HEAD^{tree}')
test "$REVERT_TREE" = "$PARENT_TREE" && echo OK ; git reset --hard HEAD~1
```

## Result (actual)
```
parent_tree = c51f1bd901d1f0b9bfcf5058f40837ea82409153
revert_tree = c51f1bd901d1f0b9bfcf5058f40837ea82409153
ROLLBACK OK: tree restored exactly (parent_tree == revert_tree)
```
Verdict: **PASS** — git revert reproduced the parent tree; the spec commit was
then restored (git reset --hard), leaving exactly one commit for SPEC-078.
