# SPEC-165 Test Results — Explicit escalation reason contract

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/routing src/agent/runtime

 Test Files  5 passed (5)
      Tests  32 passed (32)
   Start at  12:39:18
   Duration  677ms (transform 600ms, setup 0ms, import 811ms, tests 50ms, environment 0ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/routing/tsconfig.json  → exit 0
$ npx tsc --noEmit -p src/agent/runtime/tsconfig.json  → exit 0
```
