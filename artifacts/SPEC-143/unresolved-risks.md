# SPEC-143 unresolved risks
- The gate is advisory: a caller that bypasses `admitDequeue` and calls `dequeue` directly is not capped. Enforcement is a wiring concern (the scheduler must call the gate). 0 critical risks in the deterministic core.
