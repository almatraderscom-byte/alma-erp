# SPEC-007 Test Results — Architecture decision record process

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/contracts

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  7 passed (7)
      Tests  68 passed (68)
   Start at  21:29:25
   Duration  708ms (transform 236ms, setup 0ms, import 395ms, tests 65ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/contracts/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

