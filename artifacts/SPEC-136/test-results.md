# SPEC-136 Test Results — Idempotency keys

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/workflows src/worker/workflows

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  6 passed (6)
      Tests  56 passed (56)
   Start at  15:26:11
   Duration  736ms (transform 292ms, setup 0ms, import 453ms, tests 66ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/workflows/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

