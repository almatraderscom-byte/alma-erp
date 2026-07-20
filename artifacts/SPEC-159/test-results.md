# SPEC-159 Test Results — Provider failover rules

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/models src/agent/providers/runtime

 Test Files  14 passed (14)
      Tests  75 passed (75)
   Start at  11:08:22
   Duration  1.62s (transform 886ms, setup 0ms, import 1.66s, tests 159ms, environment 2ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/models/tsconfig.json            → exit 0
$ npx tsc --noEmit -p src/agent/providers/runtime/tsconfig.json → exit 0
```
