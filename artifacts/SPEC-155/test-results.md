# SPEC-155 Test Results — Standard reasoner T3 tier

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/models src/agent/providers/runtime

 Test Files  8 passed (8)
      Tests  50 passed (50)
   Start at  10:58:21
   Duration  1.14s (transform 769ms, setup 0ms, import 1.21s, tests 82ms, environment 1ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/models/tsconfig.json            → exit 0
$ npx tsc --noEmit -p src/agent/providers/runtime/tsconfig.json → exit 0
```
