# SPEC-024 Contract — Usage cost
`costForUsage(price, TokenUsage)` → `FullCostBreakdown` (input/cached/output/
reasoning/toolCalls/total nano-USD). Reasoning at reasoning rate (fallback output);
tool calls at perToolCallNanoUsd. Integer nano-USD. Rollback: `git revert --no-edit <SPEC-024 commit>`.
