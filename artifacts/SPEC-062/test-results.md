# SPEC-062 Test Results — Provider prompt-cache adapter

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/cache

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  2 passed (2)
      Tests  8 passed (8)
   Start at  10:51:41
   Duration  326ms (transform 94ms, setup 0ms, import 134ms, tests 12ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/cache/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

