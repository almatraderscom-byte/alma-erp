# SPEC-004 Test Results — Canonical execution identity contract

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/contracts

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  4 passed (4)
      Tests  43 passed (43)
   Start at  21:25:27
   Duration  523ms (transform 282ms, setup 0ms, import 398ms, tests 47ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/contracts/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

