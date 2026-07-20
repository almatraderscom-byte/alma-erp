# SPEC-085 — Contract (cost-tier.ts, v1.0.0)
- `expectedTier(toolNames): 'light'|'standard'|'heavy'` — model_invocation→heavy;
  external/high-risk→standard; else light.
- `expectedClass(tier)` — light→free, standard→metered, heavy→premium.
- `TIER_HINTS: Record<tier, {modelClass, maxUsdPerCall}>` — Cost Governor hint
  (INV-03); strictly increasing USD ceiling, never a silent upgrade.
- `checkCostMetadata(c)/checkAllCostMetadata(set): CostIssue[]` —
  TIER_MISMATCH | CLASS_MISMATCH | UNKNOWN_TIER.
- Boundary `queryCostTier(raw): ComponentResult` — hint|check; identity-enforced;
  never throws.
