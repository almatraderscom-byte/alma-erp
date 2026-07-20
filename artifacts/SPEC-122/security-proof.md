# SPEC-122 — Security proof
FAIL-CLOSED (INV-05): unknown tool / unregistered schema / oversized / invalid args
DENY the entire gateway call at stage 1 — no policy/cost/execution stage runs, so a
handler never sees unvalidated input. Never throws. Secret scan: none. PASS.
