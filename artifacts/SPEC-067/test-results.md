# SPEC-067 Test Results — Tool-result cache with freshness

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/cache

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  7 passed (7)
      Tests  31 passed (31)
   Start at  10:54:45
   Duration  727ms (transform 340ms, setup 0ms, import 512ms, tests 50ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/cache/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

