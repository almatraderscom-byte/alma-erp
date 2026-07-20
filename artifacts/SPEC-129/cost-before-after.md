# SPEC-129 — Cost before/after
0 → 0 in gateway logic. This stage RECONCILES the reservation to actual spend
(commit) and releases on abort, so the ledger reflects true usage and never leaks a
reservation. No model/provider/DB/network call (INV-01/03). PASS.
