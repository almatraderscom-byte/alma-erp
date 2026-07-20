# SPEC-087 — Security proof
Availability is FAIL-CLOSED (INV-05): disabled, kill-switched, or unknown-state
capabilities are unavailable; the kill-switch cannot be cleared by an 'ok' signal
(only an explicit 'restore'). The override store lets an operator disable a
capability at runtime without shipping code. `queryHealth` enforces identity and
never throws. Secret scan: none. PASS.
