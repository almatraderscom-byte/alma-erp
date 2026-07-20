# SPEC-022 Test Results — Tokenizer abstraction and token estimation

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/finops

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  2 passed (2)
      Tests  14 passed (14)
   Start at  08:43:53
   Duration  391ms (transform 109ms, setup 0ms, import 152ms, tests 21ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/finops/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

