# SPEC-181 Test Results — Deterministic postcondition verifier

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/verification src/agent/evals tests/agent-security

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  16:03:23
   Duration  466ms (transform 107ms, setup 0ms, import 134ms, tests 9ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/verification/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

