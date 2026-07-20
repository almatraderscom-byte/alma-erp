# SPEC-080 — Security proof
- Fail-CLOSED: `canRemove` is true only when EVERY precondition passes; the default
  (no cutover) is BLOCKED, so the gate can never accidentally authorize deleting a
  still-authoritative monolith (INV-09).
- The gate performs NO destructive action — it deletes/edits nothing; removal is a
  documented, human-run integration step (`PROPOSED_REMOVAL_PLAN`).
- `queryRemovalGate` enforces identity and never throws. Secret scan: none. PASS.
