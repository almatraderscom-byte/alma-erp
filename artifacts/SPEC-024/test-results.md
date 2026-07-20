# SPEC-024 Test Results — Reasoning and tool-call cost accounting

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/finops

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  4 passed (4)
      Tests  28 passed (28)
   Start at  08:46:39
   Duration  785ms (transform 262ms, setup 0ms, import 396ms, tests 32ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/finops/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

