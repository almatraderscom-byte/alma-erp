# SPEC-125 — Architecture scan
`cost-authorization.ts` imports `@/agent/contracts`, `@/agent/budgets/budget`
(types + store), relative. Deterministic — budget arithmetic, no LLM/IO/clock/random
(INV-01). Every spend is pre-authorized by the Cost Governor (INV-03), no bypass.
No ERP→agent import. Ownership diff: only tool-gateway + artifacts/SPEC-125. PASS.
