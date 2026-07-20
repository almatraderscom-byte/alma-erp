# SPEC-047 Test Results — Exact tool-schema insertion

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/context

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  7 passed (7)
      Tests  22 passed (22)
   Start at  10:22:05
   Duration  1.05s (transform 360ms, setup 0ms, import 506ms, tests 61ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/context/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

