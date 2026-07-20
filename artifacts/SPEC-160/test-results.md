# SPEC-160 Test Results — Model adapter conformance tests

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/models src/agent/providers/runtime

 Test Files  15 passed (15)
      Tests  84 passed (84)
   Start at  11:10:10
   Duration  1.79s (transform 1.02s, setup 0ms, import 1.83s, tests 154ms, environment 2ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/models/tsconfig.json            → exit 0
$ npx tsc --noEmit -p src/agent/providers/runtime/tsconfig.json → exit 0
```
