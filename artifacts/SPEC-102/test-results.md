# SPEC-102 Test Results — Agent principal

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/policy src/agent/identity

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  2 passed (2)
      Tests  8 passed (8)
   Start at  12:09:01
   Duration  281ms (transform 63ms, setup 0ms, import 105ms, tests 12ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/policy/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

