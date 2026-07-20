# SPEC-020 Test Results — Admission bypass CI gate

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/control-plane

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  10 passed (10)
      Tests  64 passed (64)
   Start at  07:53:36
   Duration  843ms (transform 362ms, setup 0ms, import 610ms, tests 60ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/control-plane/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

