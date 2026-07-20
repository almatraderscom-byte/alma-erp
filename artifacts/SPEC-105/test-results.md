# SPEC-105 Test Results — Unified policy decision API

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/policy src/agent/identity

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  5 passed (5)
      Tests  30 passed (30)
   Start at  12:15:33
   Duration  629ms (transform 334ms, setup 0ms, import 511ms, tests 44ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/policy/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

