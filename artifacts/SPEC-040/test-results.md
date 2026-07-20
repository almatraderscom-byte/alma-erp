# SPEC-040 Test Results — Budget bypass and overspend test gate

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/budgets src/agent/control-plane/cost

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  11 passed (11)
      Tests  31 passed (31)
   Start at  10:06:04
   Duration  1.44s (transform 546ms, setup 0ms, import 1.06s, tests 145ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/budgets/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

