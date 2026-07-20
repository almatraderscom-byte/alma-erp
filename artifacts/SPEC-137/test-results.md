# SPEC-137 Test Results — Unknown-outcome reconciliation

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/workflows src/worker/workflows

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  7 passed (7)
      Tests  63 passed (63)
   Start at  15:27:11
   Duration  891ms (transform 305ms, setup 0ms, import 490ms, tests 73ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/workflows/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

