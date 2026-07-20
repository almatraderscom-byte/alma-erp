# SPEC-036 Test Results — Individual model-call budget

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/budgets src/agent/control-plane/cost

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  7 passed (7)
      Tests  22 passed (22)
   Start at  10:02:46
   Duration  802ms (transform 382ms, setup 0ms, import 669ms, tests 37ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/budgets/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

