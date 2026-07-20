# SPEC-177 Test Results — Research workflow templates

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/specialists src/agent/workflow-templates

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  7 passed (7)
      Tests  36 passed (36)
   Start at  15:55:38
   Duration  973ms (transform 472ms, setup 0ms, import 764ms, tests 72ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/specialists/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

