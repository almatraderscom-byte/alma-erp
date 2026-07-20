# SPEC-023 Test Results — Cached-input pricing support

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/finops

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  3 passed (3)
      Tests  22 passed (22)
   Start at  08:45:24
   Duration  453ms (transform 206ms, setup 0ms, import 297ms, tests 34ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/finops/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

