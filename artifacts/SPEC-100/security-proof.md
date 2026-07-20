# SPEC-100 — Security proof
Fail-CLOSED: `certified` requires all 8 invariants, including SECRET_REDACTED (a
planted `sk-SECRET` must not appear in the model view) and VIEW_BOUNDED (hard byte
cap). The gate literally proves no secret leaks and no unbounded blob reaches the
model (INV-07). It caught a genuine bound-escape bug before certification.
`queryFirewallGate` enforces identity and never throws. Secret scan: none. PASS.
