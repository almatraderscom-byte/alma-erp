# SPEC-200 test results

## Commands
- `npx vitest run src/agent/release` → `Test Files 5 passed (5)` — `Tests 28 passed (28)` (12 new certification tests).
- `npx tsc --noEmit` → exit 0 (whole repo).
- `npx vitest run src/worker/queues src/agent/browser-runtime` → `Tests 106 passed (106)` (re-verification that SPEC-141..150 verdict repair is backed by executable proof).
- `node scripts/architecture/certify-architecture.mjs` → all 9 gate steps PASS; CERTIFIED (see certification.json).

## Covered paths
valid input; malformed input (bad SHA); missing tenant/identity; oversized input (1001 spec proofs rejected by schema and boundary); contract-version mismatch; missing required gate step; failed gate step; incomplete spec set (deleted proof dir); PARTIAL verdict + missing artifact; unsatisfied checklist item; blank evidenceRef; hostile input never throws; digest determinism (same evidence ⇒ same digest, changed evidence ⇒ different digest).
