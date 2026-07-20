# SPEC-031 Test Results — Organization monthly budget

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/budgets src/agent/control-plane/cost

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  2 passed (2)
      Tests  12 passed (12)
   Start at  09:58:59
   Duration  416ms (transform 170ms, setup 0ms, import 227ms, tests 13ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/budgets/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

