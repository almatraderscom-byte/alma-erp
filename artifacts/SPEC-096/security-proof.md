# SPEC-096 — Security proof
INV-07 enforced two ways: secret-looking keys are redacted from the view, and the
view is hard byte-capped (oversize → truncated preview that references the
evidenceId, never the raw blob). The full payload stays only in the evidence store.
`compactModelView` enforces identity and never throws. Secret scan of source: none.
PASS.
