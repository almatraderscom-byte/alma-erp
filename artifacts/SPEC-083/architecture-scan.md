# SPEC-083 — Architecture scan
`tool-map.ts` imports `@/agent/contracts`, `@/agent/tools/manifests` (decoupled G08
loader — no prisma/network), `zod`, relative. INV-01 (index lookup, no LLM). No
ERP→agent import. Ownership diff: only capabilities + artifacts/SPEC-083. PASS.
