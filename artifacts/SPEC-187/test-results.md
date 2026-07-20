# SPEC-187 Test Results — Cost-per-success evaluation

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/verification src/agent/evals tests/agent-security

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  7 passed (7)
      Tests  30 passed (30)
   Start at  16:08:00
   Duration  963ms (transform 292ms, setup 0ms, import 472ms, tests 55ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/verification/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

