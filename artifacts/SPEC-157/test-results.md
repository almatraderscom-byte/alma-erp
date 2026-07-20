# SPEC-157 Test Results — Provider capability discovery

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/models src/agent/providers/runtime

 Test Files  11 passed (11)
      Tests  62 passed (62)
   Start at  11:02:53
   Duration  1.29s (transform 872ms, setup 0ms, import 1.42s, tests 113ms, environment 1ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/models/tsconfig.json            → exit 0
$ npx tsc --noEmit -p src/agent/providers/runtime/tsconfig.json → exit 0
```
