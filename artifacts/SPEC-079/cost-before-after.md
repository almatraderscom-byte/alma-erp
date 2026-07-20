# SPEC-079 — Cost before/after
All request-path metrics 0 → 0. Building the registry is an in-memory map over 326
manifests; no model/provider/DB/network call (INV-01/03). The model-facing
definitions are the SAME count (326) as the monolith's TOOL_DEFINITIONS, so there
is no token/context cost change when it eventually becomes authoritative. PASS.
