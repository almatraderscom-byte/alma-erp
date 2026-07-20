# SPEC-128 — Architecture scan
`evidence-capture.ts` imports `@/agent/contracts`, `@/agent/tools/registry/io-schema`
(boundedOutputView), `@/agent/tools/results` (evidence store + Provenance),
`@/agent/policy` (via SPEC-126 helper), relative. Deterministic (INV-01), no
LLM/IO/clock/random (observedAtMs is caller-supplied). No ERP→agent import.
Ownership diff: only tool-gateway + artifacts/SPEC-128. PASS.
