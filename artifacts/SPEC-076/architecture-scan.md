# SPEC-076 — Architecture scan
`ownership-metadata.ts` imports `@/agent/contracts` (resolveOwner, OwnershipZone),
`zod`, manifest schema — NO monolith. Reuses the frozen G01 zone registry, so tool
ownership and repo ownership can never diverge. INV-01 (no LLM). No ERP→agent
import. Ownership diff: only registry + artifacts/SPEC-076. PASS.
