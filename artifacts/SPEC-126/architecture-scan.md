# SPEC-126 — Architecture scan
`approval-obligation.ts` imports `@/agent/contracts`, `@/agent/policy`
(applyObligations), relative. The autonomy engine is a SEAM (deps.autonomyEngine),
so the gateway stays deterministic (INV-01) and G12-decoupled until it lands.
No LLM/IO/clock/random. No ERP→agent import. Ownership diff: only tool-gateway +
artifacts/SPEC-126. PASS.
