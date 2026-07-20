# SPEC-090 — Security proof
Fail-CLOSED: `certified` is true only when all 8 facet checks pass with zero
issues; one broken/unbrokerable capability blocks certification. The BROKERABLE
check proves an executable, permitted, healthy path exists for every capability —
no capability is left as a dead end. `queryCertificationGate` enforces identity and
never throws. Secret scan: none. PASS.
