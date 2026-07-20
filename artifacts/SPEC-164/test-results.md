# SPEC-164 Test Results — Measured model router

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/routing src/agent/runtime

 Test Files  4 passed (4)
      Tests  25 passed (25)
   Start at  12:37:56
   Duration  621ms (transform 407ms, setup 0ms, import 556ms, tests 43ms, environment 0ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/routing/tsconfig.json  → exit 0
$ npx tsc --noEmit -p src/agent/runtime/tsconfig.json  → exit 0
```
