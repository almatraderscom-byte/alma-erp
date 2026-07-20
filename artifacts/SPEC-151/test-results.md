# SPEC-151 Test Results

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Owned-zone tests
```text
$ npx vitest run src/agent/models src/agent/providers/runtime

 Test Files  4 passed (4)
      Tests  27 passed (27)
   Start at  10:49:30
   Duration  568ms (transform 427ms, setup 0ms, import 572ms, tests 40ms, environment 0ms)
```

Suites: `tiers.test.ts`, `contract.test.ts`, `fabric.test.ts` (models),
`fake-adapter.test.ts` (providers/runtime). Coverage: valid input, malformed
input, missing tenant, missing actor path, oversized input, provider TIMEOUT /
RETRYABLE / FINAL / UNKNOWN mapping, output-oversize, budget denial (no provider
call), stable reason-code mapping, deterministic fake adapter.

## Scoped typecheck
```text
$ npx tsc --noEmit -p src/agent/models/tsconfig.json            → exit 0
$ npx tsc --noEmit -p src/agent/providers/runtime/tsconfig.json → exit 0
```
