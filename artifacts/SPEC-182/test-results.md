# SPEC-182 Test Results — Evidence-backed claim verifier

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/verification src/agent/evals tests/agent-security

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  2 passed (2)
      Tests  10 passed (10)
   Start at  16:04:06
   Duration  847ms (transform 345ms, setup 0ms, import 436ms, tests 35ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/verification/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

