# SPEC-153 Test Results — Classifier and extractor T1 tier

Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/models src/agent/providers/runtime

 Test Files  6 passed (6)
      Tests  39 passed (39)
   Start at  10:54:47
   Duration  896ms (transform 578ms, setup 0ms, import 877ms, tests 65ms, environment 1ms)
```

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/models/tsconfig.json            → exit 0
$ npx tsc --noEmit -p src/agent/providers/runtime/tsconfig.json → exit 0
```
