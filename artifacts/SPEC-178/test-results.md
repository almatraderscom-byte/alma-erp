# SPEC-178 Test Results — External communication workflows

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/specialists src/agent/workflow-templates

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  8 passed (8)
      Tests  40 passed (40)
   Start at  15:56:14
   Duration  1.13s (transform 436ms, setup 0ms, import 709ms, tests 103ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/specialists/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

