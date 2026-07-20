# SPEC-095 — Security proof
INV-07: the boundary returns only {evidenceId, sizeBytes} — the payload (incl. a
`secret_body` in the test) is never echoed back, while the full payload is retained
in the store for authorized audit/reconciliation. Evidence ids are content hashes
(no id-guessing reveals content). `storeEvidence` enforces identity, correlates via
identity.correlationId, and never throws. Secret scan of source: none. PASS.
