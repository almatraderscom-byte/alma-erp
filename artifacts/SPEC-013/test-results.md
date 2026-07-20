# SPEC-013 Test Results — Deterministic fast-path command router

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/control-plane

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  3 passed (3)
      Tests  20 passed (20)
   Start at  07:36:11
   Duration  409ms (transform 253ms, setup 0ms, import 349ms, tests 20ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/control-plane/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

