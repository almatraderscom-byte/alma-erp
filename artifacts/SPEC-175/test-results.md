# SPEC-175 Test Results — Finance and invoice workflow templates

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/specialists src/agent/workflow-templates

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  5 passed (5)
      Tests  28 passed (28)
   Start at  15:54:19
   Duration  827ms (transform 419ms, setup 0ms, import 647ms, tests 53ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/specialists/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

