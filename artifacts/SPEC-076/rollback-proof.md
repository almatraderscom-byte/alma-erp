# SPEC-076 — Rollback proof

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
parent_tree = f05845277a8a759f91a47640a861241c8420990a
revert_tree = f05845277a8a759f91a47640a861241c8420990a
ROLLBACK OK: tree restored exactly (parent_tree == revert_tree)
```
Verdict: **PASS** — git revert reproduced the parent tree; the spec commit was
then restored (git reset --hard), leaving exactly one commit for SPEC-076.
