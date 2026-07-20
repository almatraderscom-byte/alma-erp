# SPEC-124 — Contract (policy-decision.ts)
- `policyDecisionStage: GatewayStage` — fail-closed DENY if principal/resource
  missing; else `decidePolicy({identity, principal, action, resource, context},
  deps.policyLayers)`. Non-ALLOW decision returned verbatim (stops pipeline). ALLOW
  → advance with `obligations` from permitting layers.
- contract.ts additive: `GatewayContext.principal?/resource?/policyContext?`;
  `deps.policyLayers`. Wired third in DEFAULT_STAGES.
