# SPEC-192 Test Results — Agent operational SLOs

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/observability src/agent/release

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  2 passed (2)
      Tests  8 passed (8)
   Start at  16:18:58
   Duration  366ms (transform 91ms, setup 0ms, import 131ms, tests 16ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/observability/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

