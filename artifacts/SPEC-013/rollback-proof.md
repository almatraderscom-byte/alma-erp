# SPEC-013 Rollback Proof

## Drill (executed against the real SPEC-013 commit)

Rollback contract: reverting the spec commit must restore the exact prior tree.
The change is additive and nothing in production imports it, so revert is clean
and side-effect-free.

```text
parent(pre-spec) tree: 9680774a97b21eb8d75feb75d5b7efd4cc94c903
post-revert   tree:    9680774a97b21eb8d75feb75d5b7efd4cc94c903
RESULT: MATCH — revert restores exact pre-spec baseline
```

## Result

**PASS.** `git revert` of the SPEC-013 commit yields a tree
byte-identical to its parent (the pre-spec baseline). Rollback command:

```
git revert --no-edit <SPEC-013 commit>
```
