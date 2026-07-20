# SPEC-138 Test Results — Compensation and saga actions

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/workflows src/worker/workflows

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  8 passed (8)
      Tests  68 passed (68)
   Start at  15:28:16
   Duration  906ms (transform 327ms, setup 0ms, import 540ms, tests 90ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/workflows/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

