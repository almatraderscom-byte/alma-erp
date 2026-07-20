# SPEC-162 Test Results — Cost-quality model score

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/routing src/agent/runtime

 Test Files  2 passed (2)
      Tests  11 passed (11)
   Start at  12:34:19
   Duration  295ms (transform 95ms, setup 0ms, import 134ms, tests 20ms, environment 0ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/routing/tsconfig.json  → exit 0
$ npx tsc --noEmit -p src/agent/runtime/tsconfig.json  → exit 0
```
