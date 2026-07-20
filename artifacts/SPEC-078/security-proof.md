# SPEC-078 — Security proof
- A `removed` tool is fail-CLOSED non-callable (test asserts callable=false); a
  caller is redirected to the replacement rather than silently succeeding/failing.
- Migration resolution is cycle-safe, so a malicious/broken replacedBy loop cannot
  hang the process (INV-06 spirit: unknown/looping outcomes are contained).
- `queryDeprecation` enforces identity, never throws. Secret scan: none. PASS.
