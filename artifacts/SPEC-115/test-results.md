# SPEC-115 Test Results — HR and staff action approval rules

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/autonomy src/agent/approvals

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  5 passed (5)
      Tests  52 passed (52)
   Start at  13:59:25
   Duration  1.11s (transform 783ms, setup 0ms, import 1.15s, tests 71ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/autonomy/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

