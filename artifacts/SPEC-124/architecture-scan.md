# SPEC-124 — Architecture scan
`policy-decision.ts` imports `@/agent/contracts`, `@/agent/policy` (decidePolicy),
relative. Deterministic — the policy engine is pure (INV-01), no LLM/IO. Every
authorization goes through G11, not an ad-hoc check (INV: no authorization bypass).
No ERP→agent import. Ownership diff: only tool-gateway + artifacts/SPEC-124. PASS.
