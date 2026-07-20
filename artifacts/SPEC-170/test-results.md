# SPEC-170 Test Results — Routing and head-isolation regression gate

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/routing src/agent/runtime

 Test Files  10 passed (10)
      Tests  59 passed (59)
   Start at  12:47:23
   Duration  1.03s (transform 686ms, setup 0ms, import 1.29s, tests 90ms, environment 1ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/routing/tsconfig.json  → exit 0
$ npx tsc --noEmit -p src/agent/runtime/tsconfig.json  → exit 0
```
