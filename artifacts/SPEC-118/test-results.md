# SPEC-118 Test Results — Approval expiry and revocation

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/autonomy src/agent/approvals

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  8 passed (8)
      Tests  80 passed (80)
   Start at  14:03:10
   Duration  1.61s (transform 1.33s, setup 0ms, import 2.08s, tests 129ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/autonomy/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

