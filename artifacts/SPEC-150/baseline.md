# SPEC-150 baseline — Queue and browser chaos verification

## Discovery commands
- `ls src/worker/queues` → 141..145 present. `ls src/agent/browser-runtime` → 146..149 present.
- `sed -n '1,40p' src/agent/workflows/chaos.ts` → G14 chaos pattern (`runWorkflowChaosSuite()` composing the whole stack + injected failures, asserted by a test). Mirrored here.
- No chaos suite exists for the G15 queue/browser zones yet.

## Current implementation
None. Specs 141–149 are individually tested. This spec composes each zone end-to-end and injects the failures a real system suffers (duplicate delivery, cross-tenant attempt, backpressure, starvation pressure, deadline miss, crash mid-effect/unknown outcome, dead-letter; browser: hallucinated target, secret leak attempt, oversize view, runaway replans/stalls/cost/steps) and asserts each invariant holds by DRIVING the stack (INV-10). Deterministic + self-contained (INV-01).

## Callers / downstream
Red-team gate for the group; run by the group integration checkpoint. Two suites: `runQueueChaosSuite()` (worker/queues) + `runBrowserChaosSuite()` (agent/browser-runtime).

## Direct provider/model/tool/DB calls
None. All timestamps/inputs/findings are constants; probe + model + browser are the same deterministic seams used by 141–149.

## Tenant / permission / audit propagation
Chaos explicitly exercises cross-tenant rejection and per-tenant fairness/concurrency isolation.

## Likely bypass paths
Chaos IS the bypass hunt: it asserts blind-retry, cross-tenant, hallucinated-target, secret-leak, and runaway paths are all closed.

## Proposed migration boundary
Verification-only; no production path changes.

## Files expected to change
`src/worker/queues/{chaos.ts,__tests__/chaos.test.ts}` + `src/agent/browser-runtime/{chaos.ts,__tests__/chaos.test.ts}` + barrels — additive.
