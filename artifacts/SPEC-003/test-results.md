# SPEC-003 Test Results — Repository ownership zones and CODEOWNERS model

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/contracts

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  3 passed (3)
      Tests  32 passed (32)
   Start at  21:23:13
   Duration  307ms (transform 176ms, setup 0ms, import 242ms, tests 27ms, environment 0ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/contracts/tsconfig.json
(exit 0 — 0 type errors)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

