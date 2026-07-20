# SPEC-030 Contract — Pricing freshness
`checkPricingFreshness(nowMs, {maxAgeDays?, registry?})` → `FreshnessReport
{ok, issues, checked}`. UNVERIFIED=warn, STALE/NO_SOURCE=error (fail gate).
Runner: src/agent/providers/pricing/check-pricing-freshness.mjs (CI entrypoint;
authoritative tested logic in freshness.ts). Rollback: `git revert --no-edit <SPEC-030 commit>`.
