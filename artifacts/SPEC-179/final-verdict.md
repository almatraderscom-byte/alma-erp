# SPEC-179 Final Verdict
**Verdict: PASS**

runWithRepair: bounded schema-repair loop — on off-schema output (SPEC-172 RETRYABLE) it re-asks up to MAX_REPAIR_ATTEMPTS, feeding the exact violations back as constraints; returns the first COMPLETED result or FAILED_FINAL once the budget is spent (never an unbounded loop, never passes malformed output through); a non-schema failure is terminal at once, and the caller budget is clamped to the hard max.
vitest: 5 passed (zone suite green) ; typecheck rc=0 ; forbidden-import gate clean ; rollback drill MATCH ; deterministic (INV-01), fail-closed (INV-05). 10/10 proof artifacts.
