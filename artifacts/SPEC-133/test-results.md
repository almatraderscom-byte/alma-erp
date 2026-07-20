# SPEC-133 Test Results — Durable workflow state

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/workflows src/worker/workflows

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  3 passed (3)
      Tests  31 passed (31)
   Start at  15:22:57
   Duration  480ms (transform 245ms, setup 0ms, import 325ms, tests 34ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/workflows/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

