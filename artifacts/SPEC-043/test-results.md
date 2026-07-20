# SPEC-043 Test Results — Domain skill bundle

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/context

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  3 passed (3)
      Tests  12 passed (12)
   Start at  10:18:02
   Duration  319ms (transform 153ms, setup 0ms, import 206ms, tests 17ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/context/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

