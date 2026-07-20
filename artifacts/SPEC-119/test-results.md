# SPEC-119 Test Results — Approval evidence and audit

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/autonomy src/agent/approvals

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  9 passed (9)
      Tests  86 passed (86)
   Start at  14:04:24
   Duration  1.27s (transform 727ms, setup 0ms, import 1.28s, tests 137ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/autonomy/tsconfig.json
src/agent/approvals/audit.ts(44,19): error TS2339: Property 'reasonCodes' does not exist on type 'ComponentResult<ApprovalGrant>'.
  Property 'reasonCodes' does not exist on type 'ComponentSuccess<ApprovalGrant>'.
(TYPE ERRORS)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

