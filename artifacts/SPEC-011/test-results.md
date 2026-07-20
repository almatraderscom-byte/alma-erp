# SPEC-011 Test Results — Single admission gateway

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/control-plane

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  07:27:35
   Duration  347ms (transform 103ms, setup 0ms, import 142ms, tests 9ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/control-plane/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

