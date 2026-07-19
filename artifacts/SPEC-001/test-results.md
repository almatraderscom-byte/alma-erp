# SPEC-001 Test Results — Architecture inventory and request-path map

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/contracts/__tests__/component.test.ts

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  21:12:48
   Duration  302ms (transform 41ms, setup 0ms, import 61ms, tests 11ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/contracts/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

