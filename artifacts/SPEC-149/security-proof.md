# SPEC-149 security proof
- Budget exhaustion / cost-runaway defense: a run cannot exceed its nano-USD ceiling or its step cap — both hard-stop fail-closed (BUDGET_EXCEEDED / STEP_LIMIT).
- Money integrity: integer nano-USD only; non-integer or negative costs are rejected, so float rounding cannot slip a run past its ceiling.
- On a hard-stop the accounting is returned UNCHANGED (no partial commit).
