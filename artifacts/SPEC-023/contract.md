# SPEC-023 Contract — Cost calc (cached input)
`perMTokCost(tokens, rate)`, `costForTokens(price, {inputTokens, cachedInputTokens,
outputTokens})` → `CostBreakdown` (input/cachedInput/output/total nano-USD).
Cached billed at cached rate, clamped ≤ input; non per_mtok → 0 (media priced
elsewhere). Integer nano-USD only. Rollback: `git revert --no-edit <SPEC-023 commit>`.
