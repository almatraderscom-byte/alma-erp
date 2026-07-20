# SPEC-063 Test Results — Cache-break diagnostics

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/cache

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  3 passed (3)
      Tests  12 passed (12)
   Start at  10:52:17
   Duration  383ms (transform 196ms, setup 0ms, import 267ms, tests 15ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/cache/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

