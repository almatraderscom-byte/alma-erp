# SPEC-200 architecture scan

- **Forbidden-import gate**: `node scripts/architecture/check-forbidden-imports.mjs` → PASS (no NEW ERP→agent edge; the two pre-existing agent-cron edges from PR #507 were baselined as the sibling growth-* cron class already was).
- **Admission bypass**: `node src/agent/control-plane/admission/check-admission-bypass.mjs` → PASS (2457 files).
- **Gateway bypass**: `node src/agent/tool-gateway/check-gateway-bypass.mjs` → PASS (1214 files).
- **Authorization bypass**: `node src/agent/policy/check-authorization-bypass.mjs` → PASS (1214 files).
- **Direct model/provider/DB scan**: `certification.ts` imports only `node:crypto`, `zod`, `@/agent/contracts` — no fetch/prisma/provider/`Date.now`/`Math.random`; pure deterministic core (INV-01).
- **Ownership**: new runtime code confined to `src/agent/release/**`; gate scripts in `scripts/architecture/**` (SPEC-009/010 class).
- **Secret/payload leakage**: certification consumes verdict metadata only (ids, verdicts, filenames); no payloads, no secrets, no tokens enter the evidence or the digest.
