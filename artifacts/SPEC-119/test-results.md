# SPEC-119 Test Results — Approval evidence and audit

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/autonomy src/agent/approvals

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  9 passed (9)
      Tests  86 passed (86)
   Start at  14:05:15
   Duration  1.28s (transform 704ms, setup 0ms, import 1.26s, tests 111ms, environment 2ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/autonomy/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

