# SPEC-026 Contract — Worst-case estimator
`WorstCaseBounds {maxInputTokens, maxOutputTokens, maxReasoningTokens?, maxToolCalls?}`,
`estimateWorstCaseCost(price, bounds)` (basis 'worst_case'; cachedInputTokens=0;
clamps negatives). Never < normal for same tokens. Rollback: `git revert --no-edit <SPEC-026 commit>`.
