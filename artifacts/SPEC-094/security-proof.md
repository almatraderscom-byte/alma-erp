# SPEC-094 — Security proof
FAIL-CLOSED (INV-05): unknown tool, unregistered schema, oversized args, or any
schema violation DENY — a handler never runs on unvalidated input. Argument size is
hard-bounded (64 KiB) before parse. `admitToolCall` enforces identity and never
throws. Secret scan: none. PASS.
