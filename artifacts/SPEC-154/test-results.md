# SPEC-154 Test Results — Cheap specialist T2 tier

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/models src/agent/providers/runtime

 Test Files  7 passed (7)
      Tests  45 passed (45)
   Start at  10:56:05
   Duration  971ms (transform 598ms, setup 0ms, import 943ms, tests 67ms, environment 1ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/models/tsconfig.json            → exit 0
$ npx tsc --noEmit -p src/agent/providers/runtime/tsconfig.json → exit 0
```
