# SPEC-126 — Security proof
Fail-closed (INV-05): no autonomy engine OR NEEDS_APPROVAL ⇒ the gateway returns
NEEDS_APPROVAL and NO tool executes (execution stage never runs); an unknown state
⇒ DENY. High-risk/big-money actions therefore cannot self-execute without owner
approval. Policy obligations (redact/mask) are applied to the result view (SPEC-128)
so the model never sees data it must not. Never throws. Secret scan: none. PASS.
