# SPEC-079 — Architecture scan
`runtime-registry.ts` imports `@/agent/contracts` (feature-flag decide), `zod`,
manifest loader + the registry facet engines — NO monolith. The registry is
DERIVED data (INV-01, no LLM). Feature-flag modes come from the frozen G01 ladder,
so this migration uses the same off→enforce→rollback discipline as every other
component (INV-08). No ERP→agent import. Ownership diff: only registry +
artifacts/SPEC-079. PASS.
