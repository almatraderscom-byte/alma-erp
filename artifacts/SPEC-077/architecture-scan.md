# SPEC-077 — Architecture scan
`versioning.ts` imports `@/agent/contracts`, `zod`, manifest schema/loader — NO
monolith. INV-01: version math is arithmetic, no LLM. No ERP→agent import.
Ownership diff: only registry + artifacts/SPEC-077. PASS.
