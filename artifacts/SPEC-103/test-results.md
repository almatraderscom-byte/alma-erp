# SPEC-103 Test Results — Workflow principal

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/policy src/agent/identity

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  3 passed (3)
      Tests  10 passed (10)
   Start at  12:09:27
   Duration  305ms (transform 111ms, setup 0ms, import 178ms, tests 19ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/policy/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

