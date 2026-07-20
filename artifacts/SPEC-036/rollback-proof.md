# SPEC-036 Rollback Proof

## Drill (executed against the real SPEC-036 commit)

Rollback contract: reverting the spec commit must restore the exact prior tree.
The change is additive and nothing in production imports it, so revert is clean
and side-effect-free.

```text
parent(pre-spec) tree: b56942cb201da648f9aa545e69048d612bde9fb6
post-revert   tree:    b56942cb201da648f9aa545e69048d612bde9fb6
RESULT: MATCH — revert restores exact pre-spec baseline
```

## Result

**PASS.** `git revert` of the SPEC-036 commit yields a tree
byte-identical to its parent (the pre-spec baseline). Rollback command:

```
git revert --no-edit <SPEC-036 commit>
```
