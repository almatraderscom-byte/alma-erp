# SPEC-148 contract — Browser replan limits

## Public contract
- Types: `ReplanState` {replans,stalls,lastSignature}, `ReplanCaps` {maxReplans,maxStalls}.
- Fns: `requestReplan` (→ ComponentResult<{replans}> + state), `recordStep` (→ ComponentResult<{stalls}> + state), `stepSignature`, `emptyReplanState`.
- Reason codes: REPLAN_LIMIT_REACHED, STALLED_NO_PROGRESS, MALFORMED.

## Behavior
requestReplan hard-stops FAILED_FINAL at maxReplans. recordStep fingerprints cursor+observationHash; identical fingerprint ⇒ stall++, distinct ⇒ reset; stalls>maxStalls ⇒ FAILED_FINAL/STALLED. Both are fail-closed hard-stops against runaway loops.

## Invariants
INV-01 deterministic (caps/signatures injected). INV-05 fail-closed hard-stops. No boolean success; no throw.
