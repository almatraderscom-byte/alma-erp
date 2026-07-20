# SPEC-078 — Architecture scan
`deprecation.ts` imports `@/agent/contracts`, `zod`, manifest schema/loader,
`./versioning` — NO monolith. INV-01 (no LLM). Migration resolution is cycle-safe
(bounded by a seen-set), so it can never loop. No ERP→agent import. Ownership
diff: only registry + artifacts/SPEC-078. PASS.
