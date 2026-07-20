# SPEC-090 — Architecture scan
`certification-gate.ts` imports `@/agent/contracts`, `zod`, and the G09 facet
modules (relative). INV-01 (composition of deterministic checks, no LLM). Fail-
closed (INV-05): certified only when every facet is clean. No ERP→agent import.
Ownership diff: only capabilities + artifacts/SPEC-090. PASS.
