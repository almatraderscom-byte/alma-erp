# SPEC-139 Test Results — Dead-letter and manual recovery

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/workflows src/worker/workflows

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  9 passed (9)
      Tests  77 passed (77)
   Start at  15:29:23
   Duration  1.54s (transform 574ms, setup 0ms, import 967ms, tests 136ms, environment 2ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/workflows/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

