# SPEC-185 Test Results — Routing evaluation

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/verification src/agent/evals tests/agent-security

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  5 passed (5)
      Tests  23 passed (23)
   Start at  16:06:22
   Duration  660ms (transform 208ms, setup 0ms, import 340ms, tests 40ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/verification/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

