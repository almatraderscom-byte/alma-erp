# SPEC-075 — Architecture scan
`risk-classification.ts` imports: `@/agent/contracts`, `zod`, manifest schema/
loader — NO monolith. INV-01: classification is arithmetic on frozen tables, no
LLM. The policy hints are exactly the INV-03/04/06 obligations expressed as data.
No ERP→agent import. Ownership diff: only registry + artifacts/SPEC-075. PASS.
