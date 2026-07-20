# SPEC-152 Test Results — Deterministic T0 path

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/models src/agent/providers/runtime

 Test Files  5 passed (5)
      Tests  33 passed (33)
   Start at  10:53:00
   Duration  890ms (transform 682ms, setup 0ms, import 930ms, tests 57ms, environment 1ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/models/tsconfig.json            → exit 0
$ npx tsc --noEmit -p src/agent/providers/runtime/tsconfig.json → exit 0
```
