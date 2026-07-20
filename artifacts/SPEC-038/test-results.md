# SPEC-038 Test Results — Browser-task cost budget

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/budgets src/agent/control-plane/cost

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  9 passed (9)
      Tests  24 passed (24)
   Start at  10:03:54
   Duration  893ms (transform 402ms, setup 0ms, import 765ms, tests 40ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/budgets/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

