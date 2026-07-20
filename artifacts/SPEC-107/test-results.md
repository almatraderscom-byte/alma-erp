# SPEC-107 Test Results — ABAC policy layer

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/policy src/agent/identity

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  7 passed (7)
      Tests  60 passed (60)
   Start at  12:20:01
   Duration  819ms (transform 404ms, setup 0ms, import 662ms, tests 81ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/policy/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

