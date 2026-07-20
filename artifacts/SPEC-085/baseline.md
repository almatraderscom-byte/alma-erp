# SPEC-085 — Baseline (capability cost & model-tier metadata)
Parent: SPEC-084 (`cbfdad7b`). Owned zones: capabilities, prisma/agent-capability.

The catalog carries cost.tier/class (seeded in SPEC-081) but nothing maps a tier to
a Cost Governor model hint, and nothing proves the tier is CONSISTENT with the
real cost drivers of the capability's G08 tools.

Discovery:
```
$ grep -n "tier\|cost" src/agent/capabilities/capability.schema.ts
$ grep -rn "expectedTier\|TIER_HINTS" src/agent/capabilities  # none before this spec
```
Migration boundary: canonical tier derivation from tool side-effects/risk + a
tier→model-hint table + consistency check.
Files: cost-tier.ts, tests, index.ts update.
