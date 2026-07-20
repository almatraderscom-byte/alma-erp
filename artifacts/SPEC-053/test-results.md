# SPEC-053 Test Results — Pending-decision and approval state

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/memory

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  3 passed (3)
      Tests  15 passed (15)
   Start at  10:31:06
   Duration  436ms (transform 294ms, setup 0ms, import 452ms, tests 29ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/memory/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

