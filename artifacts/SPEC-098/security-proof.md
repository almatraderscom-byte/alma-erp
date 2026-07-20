# SPEC-098 — Security proof
URL sanitisation is allow-list (http/https only), so javascript:/data: and other
scheme-based injection urls are dropped from the model-visible view. Titles/snippets
are length-capped. `normalizeResults` enforces identity and never throws. Secret
scan: none. PASS.
