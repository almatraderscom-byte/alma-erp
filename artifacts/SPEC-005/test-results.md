# SPEC-005 Test Results — Tenant and business context propagation contract

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/contracts

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  5 passed (5)
      Tests  51 passed (51)
   Start at  21:26:32
   Duration  564ms (transform 226ms, setup 0ms, import 366ms, tests 52ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/contracts/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

