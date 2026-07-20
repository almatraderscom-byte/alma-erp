# SPEC-092 — Architecture scan
`shortlist.ts` imports `@/agent/contracts`, `@/agent/control-plane/admission/intent`,
`@/agent/capabilities`, `@/agent/tools/manifests` (decoupled), `zod`, relative.
INV-01 (comparator ranking, no LLM). No monolith/prisma/network. No ERP→agent
import. Ownership diff: only selection + artifacts/SPEC-092. PASS.
