# SPEC-108 Test Results — Relationship authorization layer

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/policy src/agent/identity

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  8 passed (8)
      Tests  72 passed (72)
   Start at  12:21:58
   Duration  782ms (transform 390ms, setup 0ms, import 668ms, tests 85ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/policy/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

