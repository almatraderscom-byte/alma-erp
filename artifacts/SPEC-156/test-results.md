# SPEC-156 Test Results — Frontier escalation T4 tier

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/models src/agent/providers/runtime

 Test Files  9 passed (9)
      Tests  56 passed (56)
   Start at  11:00:51
   Duration  1.43s (transform 926ms, setup 0ms, import 1.52s, tests 99ms, environment 1ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/models/tsconfig.json            → exit 0
$ npx tsc --noEmit -p src/agent/providers/runtime/tsconfig.json → exit 0
```
