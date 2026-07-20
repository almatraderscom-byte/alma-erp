# SPEC-122 — Architecture scan
`schema-validation.ts` imports `@/agent/tools/selection/arg-validation` (explicit
decoupled path), `@/agent/contracts`, relative. Deterministic (Ajv, INV-01). No
Date.now/random/fetch/prisma. No ERP→agent import. Ownership diff: only tool-gateway
+ artifacts/SPEC-122. PASS.
