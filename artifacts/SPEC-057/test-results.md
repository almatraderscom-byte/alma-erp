# SPEC-057 Test Results — Memory relevance scoring

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/memory

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  7 passed (7)
      Tests  34 passed (34)
   Start at  10:34:10
   Duration  735ms (transform 337ms, setup 0ms, import 576ms, tests 66ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/memory/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

