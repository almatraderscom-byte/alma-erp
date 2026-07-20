# SPEC-030 Baseline — Pricing freshness & verification job
No freshness/verification check existed for the pricing registry. New:
checkPricingFreshness (stale/unverified/no-source) + CI runner. Unverified =
warning (day-1 estimates); stale/no-source = error. Deterministic (nowMs param).
