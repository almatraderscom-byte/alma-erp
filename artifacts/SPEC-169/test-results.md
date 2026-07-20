# SPEC-169 Test Results — Head-model tool-loop prohibition

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/routing src/agent/runtime

 Test Files  9 passed (9)
      Tests  55 passed (55)
   Start at  12:45:15
   Duration  1.03s (transform 731ms, setup 0ms, import 1.24s, tests 88ms, environment 1ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/routing/tsconfig.json  → exit 0
$ npx tsc --noEmit -p src/agent/runtime/tsconfig.json  → exit 0
```
