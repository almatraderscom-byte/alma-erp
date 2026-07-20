# SPEC-089 — Contract (broker.ts, v1.0.0)
- `callableTools(capabilityKey): string[]` — capability's tools filtered to G08-
  callable (removed excluded), ranked low-risk-first then name.
- `broker(input, overrides?): BrokerSelection|null` — resolves capabilities, walks
  them in rank order, returns { capabilityKey, toolName (primary), fallbacks[] };
  null (fail-closed) when nothing resolves or no callable tool exists. Honors the
  capability health override.
- Boundary `brokerCapabilityRequest(raw): ComponentResult` — COMPLETED with a
  selection, DENIED/POLICY_DENIED when none; identity-enforced; never throws.
