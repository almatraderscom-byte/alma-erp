# SPEC-093 — Security proof
Minimization only REMOVES annotation keys and trims descriptions; the contract-
bearing keys (type/properties/required/enum) are preserved, so a minimized schema
can never accept MORE than the original (no validation weakening). Deterministic;
`minimizeToolSchemas` enforces identity and never throws. Secret scan: none. PASS.
