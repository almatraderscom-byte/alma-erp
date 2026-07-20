# SPEC-061 Test Results — Stable-prefix hashing

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/cache

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  10:51:01
   Duration  717ms (transform 102ms, setup 0ms, import 138ms, tests 8ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/cache/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

