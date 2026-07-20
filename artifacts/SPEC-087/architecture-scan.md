# SPEC-087 — Architecture scan
`health.ts` imports `@/agent/contracts`, `zod`, relative. INV-01 (state machine is
a switch, no LLM). Availability is fail-closed (INV-05). No ERP→agent import.
Ownership diff: only capabilities + artifacts/SPEC-087. PASS.
