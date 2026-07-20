# SPEC-130 — Security proof
Enforces the INV-04 architecture rule (no direct side-effect bypass around the Tool
Gateway): the gateway core cannot make a raw provider/network call (only the adapter
seam may), and any code that routes through the gateway cannot also bypass it. The
gate is false-positive-free (scoped; legacy out-of-scope) so it can run in CI without
noise. Runner exits non-zero on any bypass. Secret scan: none. PASS.
