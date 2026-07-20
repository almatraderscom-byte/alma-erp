# SPEC-197 Test Results — Automatic rollback thresholds

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/observability src/agent/release

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  7 passed (7)
      Tests  26 passed (26)
   Start at  16:21:48
   Duration  855ms (transform 270ms, setup 0ms, import 396ms, tests 48ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/observability/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

