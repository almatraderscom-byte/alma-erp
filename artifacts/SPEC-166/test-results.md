# SPEC-166 Test Results — Escalation budget enforcement

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/routing src/agent/runtime

 Test Files  6 passed (6)
      Tests  37 passed (37)
   Start at  12:40:58
   Duration  800ms (transform 635ms, setup 0ms, import 952ms, tests 59ms, environment 1ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/routing/tsconfig.json  → exit 0
$ npx tsc --noEmit -p src/agent/runtime/tsconfig.json  → exit 0
```
