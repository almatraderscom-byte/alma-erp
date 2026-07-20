# SPEC-086 — Architecture scan
`runtime-owner.ts` imports `@/agent/contracts` (resolveOwner), `@/agent/tools/manifests`
(decoupled), `zod`, relative. INV-01 (set comparison, no LLM). Reuses the frozen
G01 zone registry so capability ownership can't diverge from repo ownership. No
ERP→agent import. Ownership diff: only capabilities + artifacts/SPEC-086. PASS.
