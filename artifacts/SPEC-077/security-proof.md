# SPEC-077 — Security proof
- Compatibility fails CLOSED on malformed input and refuses cross-MAJOR service,
  so a caller pinned to an old contract can never be silently handed a breaking one.
- `queryVersioning` enforces identity, never throws. Secret scan: none. PASS.
