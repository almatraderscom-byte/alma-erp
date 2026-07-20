# SPEC-084 — Architecture scan
`permission.ts` imports `@/agent/contracts`, `zod`, relative. INV-01 (decision is a
lattice comparison, no LLM). INV-05 (permissions fail closed) is the core of this
module. No ERP→agent import. Ownership diff: only capabilities + artifacts/SPEC-084.
PASS.
