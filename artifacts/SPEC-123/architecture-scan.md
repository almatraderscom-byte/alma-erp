# SPEC-123 — Architecture scan
`identity-validation.ts` imports `@/agent/contracts`, relative. Deterministic, no
LLM/IO/clock/random (INV-01). No ERP→agent import. Ownership diff: only tool-gateway
+ artifacts/SPEC-123. PASS.
