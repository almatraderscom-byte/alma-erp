# SPEC-081 — Security proof
- `queryCapabilities` enforces the full ExecutionIdentity (missing tenant →
  FAILED_FINAL, fail-closed, INV-05; test present) and never throws.
- The in-memory store fails closed on any corrupt/duplicate catalog entry (throws
  at construction) rather than serving partial data.
- Permission `defaultDecision` is fixed to 'deny' at the schema level (the
  fail-closed default SPEC-084 builds on).
- Secret scan of the owned zone: none. Capability records are metadata only, no
  payloads/secrets (INV-07). PASS.
