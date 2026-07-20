# SPEC-193 Test Results — Cost and quality dashboard

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/observability src/agent/release

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  3 passed (3)
      Tests  11 passed (11)
   Start at  16:19:32
   Duration  386ms (transform 147ms, setup 0ms, import 207ms, tests 22ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/observability/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

