# SPEC-167 Test Results — De-escalation after planning

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/routing src/agent/runtime

 Test Files  7 passed (7)
      Tests  42 passed (42)
   Start at  12:42:26
   Duration  865ms (transform 691ms, setup 0ms, import 1.06s, tests 62ms, environment 1ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/routing/tsconfig.json  → exit 0
$ npx tsc --noEmit -p src/agent/runtime/tsconfig.json  → exit 0
```
