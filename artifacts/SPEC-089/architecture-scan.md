# SPEC-089 — Architecture scan
`broker.ts` imports `@/agent/contracts`, `@/agent/control-plane/admission/intent`,
`@/agent/tools/manifests`, `@/agent/tools/registry/deprecation` (all decoupled G08
package paths — NOT the monolith file), `zod`, relative. INV-01 (selection is
ranking, no LLM). No ERP→agent import. Ownership diff: only capabilities +
artifacts/SPEC-089. PASS.
