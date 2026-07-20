# SPEC-168 Test Results — Frontier head planner contract

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/routing src/agent/runtime

 Test Files  8 passed (8)
      Tests  48 passed (48)
   Start at  12:43:54
   Duration  1.14s (transform 929ms, setup 0ms, import 1.42s, tests 79ms, environment 1ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/routing/tsconfig.json  → exit 0
$ npx tsc --noEmit -p src/agent/runtime/tsconfig.json  → exit 0
```
