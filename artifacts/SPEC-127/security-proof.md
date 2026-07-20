# SPEC-127 — Security proof
Execution happens only after schema + identity + policy + cost + approval all
passed, and only through the adapter seam — no side effect can precede those gates.
An unknown external outcome is surfaced (UNKNOWN_OUTCOME) for reconciliation, never
blindly retried (INV-06). Missing adapter fails closed. Never throws. Secret scan:
none. PASS.
