# SPEC-084 — Security proof
Fail-CLOSED throughout (INV-05): no roles / insufficient privilege / disabled /
kill-switched / unknown capability all DENY. defaultDecision is fixed to 'deny' and
integrity-checked across the catalog. `authorizeCapability` returns the DENIED
union (never a throw, never default-allow) and enforces identity. Secret scan: none.
PASS.
