# SPEC-095 — Cost before/after
0 → 0. Storage is an in-memory Map put + a local SHA-256; no model/provider/DB/
network call (INV-01/03). Content dedupe avoids re-storing identical payloads. PASS.
