# SPEC-081 — Architecture scan
Runtime imports (owned zone): `@/agent/contracts`, `@/agent/control-plane/admission/intent`
(const only; its own imports are type-only), `zod`, relative. NO monolith, NO
prisma, NO network, NO model. Generator imports the G08 manifest loader at DEV
time only. INV-01 holds (pure data + zod). No ERP→agent import (files are agent-side).
Ownership diff: only `src/agent/capabilities/`, `prisma/agent-capability/`,
`artifacts/SPEC-081/`. PASS.
