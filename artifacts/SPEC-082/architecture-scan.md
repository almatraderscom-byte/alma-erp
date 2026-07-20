# SPEC-082 — Architecture scan
`intent-map.ts` imports `@/agent/contracts`, `@/agent/control-plane/admission/intent`
(const), `zod`, relative — NO monolith/prisma/network/model. INV-01 (index lookup,
no LLM). No ERP→agent import. Ownership diff: only capabilities + artifacts/SPEC-082.
PASS.
