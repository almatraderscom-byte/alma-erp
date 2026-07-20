# SPEC-128 — Security proof
INV-07: the model receives only a bounded, secret-redacted, obligation-redacted,
provenanced view; the full payload stays in evidence (access-controlled). Policy
obligations are applied BEFORE bounding, so a redacted field cannot leak through a
truncated preview (test: phone '01700' absent from the view, present in evidence).
Fail-closed when there is nothing to capture. Never throws. Secret scan: none. PASS.
