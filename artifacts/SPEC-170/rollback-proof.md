# SPEC-170 Rollback Proof — Routing and head-isolation regression gate

Additive change; nothing in production imports it; revert restores the exact parent tree.

```text
parent(pre-spec) tree: 7753eee6a870ca1eeb4600bfdbec4f751ef239fc
post-revert   tree:    7753eee6a870ca1eeb4600bfdbec4f751ef239fc
RESULT: MATCH — revert restores exact pre-spec baseline
```

Rollback command: `git revert --no-edit <SPEC-170 commit>` (drill executed live post-commit).
