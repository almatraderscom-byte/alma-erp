# SPEC-052 Test Results — Structured active-session state

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/memory

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  2 passed (2)
      Tests  10 passed (10)
   Start at  10:30:16
   Duration  402ms (transform 217ms, setup 0ms, import 305ms, tests 17ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/memory/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

