# SPEC-066 Test Results — Semantic read-only response cache

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/cache

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  6 passed (6)
      Tests  27 passed (27)
   Start at  10:54:11
   Duration  647ms (transform 330ms, setup 0ms, import 484ms, tests 36ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/cache/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

