# SPEC-100 — Architecture scan
`regression-gate.ts` imports `@/agent/contracts`, `@/agent/tools/selection`,
`@/agent/tools/manifests`, `zod`, relative results modules. INV-01 (the gate is
composition of deterministic checks, no LLM). No prisma/network. No ERP→agent
import. Ownership diff: only selection/results + artifacts/SPEC-100. PASS.
