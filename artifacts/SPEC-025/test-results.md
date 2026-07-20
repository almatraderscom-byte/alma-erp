# SPEC-025 Test Results — Pre-call normal cost estimator

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/finops

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  5 passed (5)
      Tests  31 passed (31)
   Start at  08:47:53
   Duration  695ms (transform 264ms, setup 0ms, import 440ms, tests 46ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/finops/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

