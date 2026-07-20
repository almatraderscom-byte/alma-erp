# SPEC-056 Test Results — Episodic execution memory

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/memory

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  6 passed (6)
      Tests  29 passed (29)
   Start at  10:33:27
   Duration  639ms (transform 361ms, setup 0ms, import 581ms, tests 55ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/memory/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

