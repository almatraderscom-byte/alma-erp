# SPEC-145 security proof
- Double-effect safety (INV-06): a crashed side-effecting task is NEVER blindly requeued; recovery requeues only on a verified effect_absent and escalates indeterminate-exhausted to dead-letter.
- Lease integrity: a still-LIVE lease cannot be stolen (DENIED/LEASE_STILL_LIVE) — at most one live worker per task.
- Fail-closed: not-leased / malformed inputs deny. Identity preserved through recovery.
