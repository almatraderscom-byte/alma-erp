# SPEC-093 — Architecture scan
`schema-minimizer.ts` imports `@/agent/contracts`, `@/agent/finops/tokens`
(deterministic estimator), `@/agent/tools/manifests`, `@/agent/tools/registry/io-schema`
(explicit decoupled path, NOT the monolith file), `zod`. INV-01 (heuristic token
count, no LLM). No prisma/network. No ERP→agent import. Ownership diff: only
selection + artifacts/SPEC-093. PASS.
