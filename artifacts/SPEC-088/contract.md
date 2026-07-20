# SPEC-088 — Contract (resolver.ts, v1.0.0)
- `resolveCapabilities({intentKey?|intentClass?, actor, requireAvailable?}, overrides?):
  ResolveResult{resolved, candidates[], considered, deniedByPermission, unavailable}`.
  Filters (fail-closed, exclude never include): permission ALLOW, availability.
  Rank: tier (light<standard<heavy) then key.
- Boundary `resolveCapabilityRequest(raw): ComponentResult` — COMPLETED when
  resolved, DENIED/POLICY_DENIED when nothing survives (fail-closed); requires
  intentKey|intentClass; identity-enforced; never throws.
