# SPEC-161 Test Results — Task-class model performance records

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/routing src/agent/runtime

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  12:33:02
   Duration  500ms (transform 72ms, setup 0ms, import 107ms, tests 20ms, environment 0ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/routing/tsconfig.json  → exit 0
$ npx tsc --noEmit -p src/agent/runtime/tsconfig.json  → exit 0
```
