# SPEC-163 Test Results — Latency and availability score

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/routing src/agent/runtime

 Test Files  3 passed (3)
      Tests  17 passed (17)
   Start at  12:35:29
   Duration  363ms (transform 207ms, setup 0ms, import 278ms, tests 26ms, environment 0ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/routing/tsconfig.json  → exit 0
$ npx tsc --noEmit -p src/agent/runtime/tsconfig.json  → exit 0
```
