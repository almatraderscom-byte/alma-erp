# SPEC-121 — Security proof
Fail-closed by construction (INV-05): the composer returns the FIRST non-success
verbatim and never proceeds; `invokeTool` enforces the full ExecutionIdentity via
G01 validateRequest (missing tenant → FAILED_FINAL) and never throws. No boolean
success, no thrown error crosses the boundary. Secret scan: none. PASS.
