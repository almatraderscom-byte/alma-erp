# SPEC-159 Rollback Proof — Provider failover rules

Additive change; nothing in production imports it; revert restores the exact
parent tree.

```text
parent(pre-spec) tree: 789b2373d06bf5dce4fa258cbb1f5995be54bf35
post-revert   tree:    789b2373d06bf5dce4fa258cbb1f5995be54bf35
RESULT: MATCH — revert restores exact pre-spec baseline
```

Rollback command: `git revert --no-edit <SPEC-159 commit>` (drill executed live post-commit).
