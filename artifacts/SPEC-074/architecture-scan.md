# SPEC-074 — Architecture scan
`io-schema.ts` imports: `ajv`, `@/agent/contracts`, `zod`, generated data —
NO monolith (verified). Generator reads only the decoupled manifest loader.
INV-01 holds (no LLM; deterministic validation). No ERP→agent import.
Ownership diff: only `src/agent/tools/registry/` + `artifacts/SPEC-074/`. PASS.
