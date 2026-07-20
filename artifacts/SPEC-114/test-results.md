# SPEC-114 Test Results — External publishing approval rules

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/autonomy src/agent/approvals

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  4 passed (4)
      Tests  44 passed (44)
   Start at  13:57:58
   Duration  6.27s (transform 744ms, setup 0ms, import 1.17s, tests 72ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/autonomy/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

