# SPEC-044 Test Results — Policy bundle insertion

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/context

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  4 passed (4)
      Tests  14 passed (14)
   Start at  10:20:30
   Duration  856ms (transform 291ms, setup 0ms, import 397ms, tests 45ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/context/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

