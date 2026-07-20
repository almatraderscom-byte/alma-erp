# SPEC-173 Test Results — Marketing workflow templates

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/specialists src/agent/workflow-templates

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  3 passed (3)
      Tests  18 passed (18)
   Start at  15:52:50
   Duration  613ms (transform 341ms, setup 0ms, import 485ms, tests 29ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/specialists/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

