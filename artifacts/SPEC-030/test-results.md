# SPEC-030 Test Results — Pricing freshness and provider-doc verification job

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/finops

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  10 passed (10)
      Tests  57 passed (57)
   Start at  08:54:26
   Duration  1.12s (transform 397ms, setup 0ms, import 700ms, tests 76ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/finops/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

