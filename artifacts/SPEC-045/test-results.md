# SPEC-045 Test Results — Structured workflow-state insertion

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/context

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  5 passed (5)
      Tests  17 passed (17)
   Start at  10:21:04
   Duration  553ms (transform 183ms, setup 0ms, import 265ms, tests 27ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/context/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

