# SPEC-099 — Architecture scan
`provenance.ts` imports `@/agent/contracts`, `zod`, relative (model-view, evidence-
store). INV-01 (envelope build is pure, no LLM). No prisma/network. No ERP→agent
import. Ownership diff: only results + artifacts/SPEC-099. PASS.
