# SPEC-025 Contract — Normal estimator
`CostEstimate {provider, model, basis, nanoUsd, breakdown, priceVerified}`,
`estimateNormalCost(price, usage)` (basis 'normal'). Surfaces price.verified so
callers know it's an estimate. Rollback: `git revert --no-edit <SPEC-025 commit>`.
