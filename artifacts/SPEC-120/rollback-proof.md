# SPEC-120 Rollback Proof

## Drill (executed against the real SPEC-120 commit)

Rollback contract: reverting the spec commit must restore the exact prior tree.
The change is additive and nothing in production imports it, so revert is clean
and side-effect-free.

```text
parent(pre-spec) tree: 027ca71a00b4a7b2d3c141b9126eaf930b7789f4
post-revert   tree:    027ca71a00b4a7b2d3c141b9126eaf930b7789f4
RESULT: MATCH — revert restores exact pre-spec baseline
```

## Result

**PASS.** `git revert` of the SPEC-120 commit yields a tree
byte-identical to its parent (the pre-spec baseline). Rollback command:

```
git revert --no-edit <SPEC-120 commit>
```
