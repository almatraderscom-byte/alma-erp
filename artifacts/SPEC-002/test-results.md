# SPEC-002 Test Results — Architecture invariants and forbidden dependency rules

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/contracts

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  2 passed (2)
      Tests  22 passed (22)
   Start at  21:20:37
   Duration  326ms (transform 123ms, setup 0ms, import 160ms, tests 23ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/contracts/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

