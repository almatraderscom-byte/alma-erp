# SPEC-188 Test Results — Prompt-injection test suite

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/verification src/agent/evals tests/agent-security

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  7 passed (7)
      Tests  30 passed (30)
   Start at  16:08:43
   Duration  915ms (transform 280ms, setup 0ms, import 474ms, tests 61ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/verification/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

