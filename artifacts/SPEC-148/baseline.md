# SPEC-148 baseline — Browser replan limits

## Discovery commands
- `ls src/agent/browser-runtime` → 146/147 present. No replan/loop-guard module.
- `grep -rln 'replan|stall|loop|no.?progress' src/agent/browser-runtime` → none. Greenfield.

## Current implementation
None. SPEC-146 can DENY an action (target not present) which in a live loop triggers a replan; without a bound the agent could replan forever, or loop on the same non-progressing state. This spec adds a deterministic bounded-replan counter and a stall (no-progress) detector that hard-stops fail-closed when limits are hit.

## Callers / downstream
Wraps the SPEC-146 decide loop. Consumed by 149 (hard-stops compose replan+cost+steps) + 150 chaos.

## Direct provider/model/tool/DB calls
None. Pure counters over an injected signature; caps injected (INV-01).

## Tenant / permission / audit propagation
Replan/stall state is per browser-task (scoped by the caller); no cross-task mixing. Signatures are opaque hashes (no secrets).

## Likely bypass paths
- Infinite replan / infinite loop (cost + wedge) → mitigated: replan count capped; repeated identical (cursor, observation) signature increments a stall counter that hard-stops.

## Proposed migration boundary
Feature-flag ladder; additive.

## Files expected to change
`src/agent/browser-runtime/{replan.ts,index.ts,__tests__/replan.test.ts}` — additive.
