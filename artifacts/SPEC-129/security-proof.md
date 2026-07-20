# SPEC-129 — Security proof
Exactly one audit event per completed gateway call, carrying the full
ExecutionIdentity (exact correlation) + evidenceIds — a complete, tamper-evident
trail. Cost is reconciled to actual (clamped to reserved), and a reservation is
released on any abort, so a caller cannot exhaust a budget via aborted calls. Never
throws. Secret scan: none. PASS.
