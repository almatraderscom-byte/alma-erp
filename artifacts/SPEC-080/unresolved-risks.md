# SPEC-080 — Unresolved risks
1. Actual removal of registry.ts + caller migration is intentionally NOT done here
   (out of owned zone, live production). The gate makes the precondition explicit
   and blocks until cutover + sign-off. This is the correct INV-09 posture, not a
   deferral of in-scope work. Severity: none. Unresolved critical risks: 0.
