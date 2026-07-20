# SPEC-070 Test Results — Cache savings and correctness dashboard

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/cache

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  10 passed (10)
      Tests  44 passed (44)
   Start at  10:56:34
   Duration  906ms (transform 400ms, setup 0ms, import 610ms, tests 54ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/cache/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

