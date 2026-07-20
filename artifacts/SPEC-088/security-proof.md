# SPEC-088 — Security proof
Unpermitted and unavailable capabilities are EXCLUDED from the result (never
returned) and an empty resolution is a DENIED at the boundary — the caller cannot
proceed without a real, permitted, available capability (fail-closed, INV-05).
Diagnostics counters (deniedByPermission/unavailable) are counts only, no payload
leak. `resolveCapabilityRequest` enforces identity and never throws. Secret scan:
none. PASS.
