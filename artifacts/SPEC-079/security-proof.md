# SPEC-079 — Security proof
- Under `enforce` the registry excludes non-callable (removed) tools — a removed
  tool can never be exposed to the model (fail-closed, test present).
- Every entry carries its risk profile (requiresGateway/CostAuth/Approval), so the
  authoritative surface hands downstream the INV-03/04/05 obligations intact.
- The `enforce` switch is gated behind shadow parity (INV-09 migration evidence);
  `queryRuntimeRegistry` enforces identity and never throws. Secret scan: none. PASS.
