# SPEC-080 — Architecture scan
`removal-gate.ts` imports `@/agent/contracts`, `zod`, and the G08 facet engines —
NO monolith import, and crucially NO filesystem delete / no edit of registry.ts.
INV-01 (no LLM; the gate is boolean arithmetic over the facet checks). INV-09
upheld: the gate is fail-closed and cannot green-light removal while the monolith
is authoritative. No ERP→agent import. Ownership diff: only registry +
artifacts/SPEC-080. PASS.
