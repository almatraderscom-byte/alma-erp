# SPEC-094 — Architecture scan
`arg-validation.ts` imports `@/agent/contracts`, `@/agent/tools/manifests`,
`@/agent/tools/registry/io-schema` (explicit decoupled path), `zod`. INV-01 (Ajv
over frozen schema, no LLM). No prisma/network. No ERP→agent import. Ownership diff:
only selection + artifacts/SPEC-094. PASS.
