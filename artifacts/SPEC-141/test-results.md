# SPEC-141 test results

## Command
`npx vitest run src/worker/queues` and `npx tsc -p src/worker/queues/tsconfig.json`

## Vitest
`Test Files 1 passed (1)` — `Tests 15 passed (15)`.

## tsc
`TSC_EXIT=0` (clean typecheck of the zone incl. imported contracts + workflows).

## Coverage of required cases
valid input ✓; malformed input ✓; unknown domain ✓; bad priority ✓; missing identity ✓; cross-tenant reject ✓; empty-queue RETRYABLE (fail-closed, no throw) ✓; duplicate/replay dedupe ✓; NOT_FOUND on complete ✓; FIFO determinism ✓; audit carries no payload ✓.
