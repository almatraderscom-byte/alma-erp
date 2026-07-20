# SPEC-028 Test Results — Cost event ledger

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/finops

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  8 passed (8)
      Tests  46 passed (46)
   Start at  08:51:29
   Duration  1.04s (transform 437ms, setup 0ms, import 735ms, tests 92ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/finops/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

