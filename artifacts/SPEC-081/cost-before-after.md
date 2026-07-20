# SPEC-081 — Cost before/after
All request-path metrics 0 → 0. The store validates + indexes 63 capabilities in
memory once at load; queries are Map lookups / one pass. No model/provider/DB/
network call (INV-01/03). Generator is dev-time only. PASS.
