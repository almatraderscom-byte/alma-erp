# SPEC-015 Test Results — Intent classification adapter

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/control-plane

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  5 passed (5)
      Tests  32 passed (32)
   Start at  07:45:02
   Duration  812ms (transform 455ms, setup 0ms, import 665ms, tests 43ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/control-plane/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

