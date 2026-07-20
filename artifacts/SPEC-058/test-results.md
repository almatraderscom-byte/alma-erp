# SPEC-058 Test Results — Memory privacy and tenant isolation

Executable evidence. Runner: vitest (`vitest.config.ts`).

## Unit / contract tests

```text
$ npx vitest run src/agent/memory

 RUN  v4.1.9 /home/user/alma-erp


 Test Files  8 passed (8)
      Tests  39 passed (39)
   Start at  10:34:59
   Duration  849ms (transform 342ms, setup 0ms, import 632ms, tests 75ms, environment 1ms)
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

