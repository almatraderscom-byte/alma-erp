# SPEC-019 Test Results — Request deduplication and replay protection

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/control-plane

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  9 passed (9)
      Tests  59 passed (59)
   Start at  07:51:28
   Duration  792ms (transform 382ms, setup 0ms, import 609ms, tests 60ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/control-plane/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

