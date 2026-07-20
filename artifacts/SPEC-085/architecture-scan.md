# SPEC-085 — Architecture scan
`cost-tier.ts` imports `@/agent/contracts`, `@/agent/tools/manifests` (decoupled),
`zod`, relative. INV-01 (tier is a fold over tool metadata, no LLM). INV-03: the
tier is a CEILING hint for the Cost Governor and never selects a stronger model on
its own. No ERP→agent import. Ownership diff: only capabilities + artifacts/SPEC-085.
PASS.
