# SPEC-091 — Architecture scan
`retrieval.ts` imports `@/agent/contracts`, `@/agent/control-plane/admission/intent`,
`@/agent/capabilities` (G09 resolver), `@/agent/tools/manifests` (decoupled G08),
`zod`. NO monolith file, NO prisma/network/model. INV-01 (set union, no LLM). No
ERP→agent import. Ownership diff: only selection + artifacts/SPEC-091. PASS.
