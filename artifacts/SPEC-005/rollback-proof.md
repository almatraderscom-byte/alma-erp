# SPEC-005 Rollback Proof

## Drill (executed against the real SPEC-005 commit)

Rollback contract: reverting the spec commit must restore the exact prior tree.
The change is additive and nothing in production imports it, so revert is clean
and side-effect-free.

```text
parent(pre-spec) tree: 9cf62422abf87271816080191be9f0e6ca3ac39f
post-revert   tree:    9cf62422abf87271816080191be9f0e6ca3ac39f
RESULT: MATCH — revert restores exact pre-spec baseline
```

## Result

**PASS.** `git revert` of the SPEC-005 commit yields a tree
byte-identical to its parent (the pre-spec baseline). Rollback command:

```
git revert --no-edit <SPEC-005 commit>
```
