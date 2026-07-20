# SPEC-164 Contract — Measured model router
- `routeModel(request, {records, registry?, capabilities?, weights?})` →
  `ComponentResult<RouteDecision>`; identity-bearing (fail-closed on missing identity).
- **Frozen invariant:** `ROUTABLE_TIERS = [T1,T2,T3]`. T4 (frontier) → `DENIED`
  `ROUTE_FRONTIER_FORBIDDEN`; T0 → `ROUTE_TIER_NOT_ROUTABLE`. Frontier is reachable
  only via the explicit escalation path (SPEC-165/166), never here.
- Scores each tier candidate = weighted (SPEC-162 cost-quality + SPEC-163
  latency-availability) over SPEC-161 records; deterministic pick (tiebreak by model id).
- Fail-safe: no telemetry → registry PRIMARY (`basis:'default-primary'`, non-frontier).
  Capability filter empties set → `ROUTE_CAPABILITY_UNSUPPORTED`. `isFrontierTier` exported
  for the SPEC-170 regression gate.
