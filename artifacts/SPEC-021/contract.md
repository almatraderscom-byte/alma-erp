# SPEC-021 Contract — Pricing registry
`ProviderPrice` (nano-USD; per_mtok/per_minute/per_1k_char/per_image), `NANO_PER_USD`,
`usdToNano`/`nanoToUsd`, `PRICING_REGISTRY` (seeded ESTIMATES, verified:false),
`getPrice(provider,model,version?)`, `validateRegistry()`, zod schema. Integer
nano-USD only (no float, no BDT). Rollback: `git revert --no-edit <SPEC-021 commit>`.
