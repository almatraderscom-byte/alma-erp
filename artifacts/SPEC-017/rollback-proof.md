# SPEC-017 Rollback Proof

## Drill (executed against the real SPEC-017 commit)

Rollback contract: reverting the spec commit must restore the exact prior tree.
The change is additive and nothing in production imports it, so revert is clean
and side-effect-free.

```text
parent(pre-spec) tree: 2d9b137976dfc03fd0f3d71a0ddf91ec1367e7e3
post-revert   tree:    2d9b137976dfc03fd0f3d71a0ddf91ec1367e7e3
RESULT: MATCH — revert restores exact pre-spec baseline
```

## Result

**PASS.** `git revert` of the SPEC-017 commit yields a tree
byte-identical to its parent (the pre-spec baseline). Rollback command:

```
git revert --no-edit <SPEC-017 commit>
```
