# SPEC-088 — Architecture scan
`resolver.ts` imports `@/agent/contracts`, `@/agent/control-plane/admission/intent`
(const), `zod`, relative facets. INV-01 (ranking is a comparator, no LLM). Fail-
closed filters (INV-05). No ERP→agent import. Ownership diff: only capabilities +
artifacts/SPEC-088. PASS.
