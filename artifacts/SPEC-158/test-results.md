# SPEC-158 Test Results — Provider timeout and quota controls

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/models src/agent/providers/runtime

 Test Files  13 passed (13)
      Tests  70 passed (70)
   Start at  11:06:08
   Duration  1.55s (transform 744ms, setup 0ms, import 1.43s, tests 139ms, environment 2ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/models/tsconfig.json            → exit 0
$ npx tsc --noEmit -p src/agent/providers/runtime/tsconfig.json → exit 0
```
