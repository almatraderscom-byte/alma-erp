# SPEC-097 — Architecture scan
`summarize.ts` imports `@/agent/contracts`, `zod`. INV-01 — the summarizer is a
pure recursive fold with ZERO model calls (that is the spec's defining constraint).
No prisma/network. No ERP→agent import. Ownership diff: only results +
artifacts/SPEC-097. PASS.
