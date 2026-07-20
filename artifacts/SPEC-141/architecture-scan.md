# SPEC-141 architecture scan

- **Forbidden-import gate**: `node scripts/architecture/check-forbidden-imports.mjs` — new code lives in `src/worker/queues` (zone `other`) and imports only `@/agent/contracts`; no ERP→agent edge introduced. PASS (run at group checkpoint).
- **Direct model/provider/tool/DB scan**: `grep -rn 'fetch|anthropic|openai|gemini|prisma|redis|Date.now|Math.random' src/worker/queues` → none. Pure deterministic core.
- **Ownership-zone diff**: `git diff --stat` touches only `src/worker/queues/**`. No forbidden path (schema/money/api/app) touched.
- **Secret/payload leakage**: task holds `payloadRef` only; audit event excludes the ref value (test asserts `JSON.stringify(ev)` excludes payload).
