# SPEC-191 Test Results — End-to-end trace model

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/observability src/agent/release

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  16:18:22
   Duration  376ms (transform 46ms, setup 0ms, import 72ms, tests 10ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/observability/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

