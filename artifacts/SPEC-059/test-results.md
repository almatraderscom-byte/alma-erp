# SPEC-059 Test Results — Memory expiration and correction

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/memory

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  9 passed (9)
      Tests  44 passed (44)
   Start at  10:35:47
   Duration  832ms (transform 345ms, setup 0ms, import 640ms, tests 79ms, environment 1ms)
```

## Scoped typecheck

```text
$ npx tsc --noEmit -p src/agent/memory/tsconfig.json
src/agent/memory/__tests__/privacy.test.ts(31,15): error TS2352: Conversion of type 'MemoryView' to type 'Record<string, unknown>' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
  Index signature for type 'string' is missing in type 'MemoryView'.
(TYPE ERRORS)
```

All required cases (valid, malformed, missing-tenant, missing-actor,
oversized, version-mismatch, reason-code mapping) are covered by the suite above.

