# SPEC-179 Test Results — Specialist retry and repair policy

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/specialists src/agent/workflow-templates

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  9 passed (9)
      Tests  45 passed (45)
   Start at  15:57:07
   Duration  1.12s (transform 469ms, setup 0ms, import 828ms, tests 90ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/specialists/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

