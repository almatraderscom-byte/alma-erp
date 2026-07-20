# SPEC-096 — Architecture scan
`model-view.ts` imports `@/agent/contracts`, `zod`, relative (evidence-store).
INV-01 (redact/cap are pure, no LLM). No prisma/network. No ERP→agent import.
Ownership diff: only results + artifacts/SPEC-096. PASS.
