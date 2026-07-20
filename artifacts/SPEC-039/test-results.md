# SPEC-039 Test Results — Cost denial and degradation policy

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/budgets src/agent/control-plane/cost

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  10 passed (10)
      Tests  29 passed (29)
   Start at  10:04:58
   Duration  919ms (transform 376ms, setup 0ms, import 735ms, tests 50ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/budgets/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

