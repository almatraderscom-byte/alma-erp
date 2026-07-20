# SPEC-095 — Architecture scan
`evidence-store.ts` imports `@/agent/contracts`, `node:crypto` (local hash, no
network), `zod`. INV-01 (content hash is deterministic, no LLM/clock/randomness).
No prisma/network. No ERP→agent import. Ownership diff: only results +
artifacts/SPEC-095. PASS.
