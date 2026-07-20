# SPEC-140 Test Results — Workflow durability chaos tests

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/workflows src/worker/workflows

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  10 passed (10)
      Tests  80 passed (80)
   Start at  15:30:51
   Duration  1.21s (transform 440ms, setup 0ms, import 735ms, tests 105ms, environment 2ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/workflows/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

