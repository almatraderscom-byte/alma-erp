# SPEC-129 — Architecture scan
`audit-finalization.ts` imports `@/agent/contracts` (AuditEvent), `@/agent/budgets/
budget` (BudgetStore type), relative. The audit sink + budget store are seams
(deterministic, INV-01), no LLM/IO/clock/random. No ERP→agent import. Ownership
diff: only tool-gateway + artifacts/SPEC-129. PASS.
