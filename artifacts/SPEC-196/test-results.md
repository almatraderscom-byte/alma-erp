# SPEC-196 Test Results — Canary-release framework

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/observability src/agent/release

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  6 passed (6)
      Tests  22 passed (22)
   Start at  16:21:11
   Duration  639ms (transform 224ms, setup 0ms, import 344ms, tests 45ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/observability/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

