# SPEC-123 — Security proof
INV-02 enforced in-pipeline (full identity required) and tenant isolation enforced
(CROSS_TENANT deny). Fail-closed (INV-05): any gap DENIES; no later stage runs.
Defense-in-depth over the boundary. Never throws. Secret scan: none. PASS.
