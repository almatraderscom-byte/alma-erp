# SPEC-046 Test Results — Relevant memory insertion

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/context

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  6 passed (6)
      Tests  20 passed (20)
   Start at  10:21:36
   Duration  586ms (transform 223ms, setup 0ms, import 324ms, tests 32ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/context/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

