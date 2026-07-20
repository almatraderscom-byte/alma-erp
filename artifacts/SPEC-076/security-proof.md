# SPEC-076 — Security proof
- A tool can never claim ownership inside ERP or a shared choke point: NOT_AGENT_ZONE
  / INTEGRATION_ONLY are hard, fail-closed violations (tests present). This upholds
  the CLAUDE.md one-way boundary at the tool-metadata layer.
- `checkToolOwnership` returns DENIED/POLICY_DENIED on any violation (fail-closed,
  INV-05), enforces identity, and never throws. Secret scan: none. PASS.
