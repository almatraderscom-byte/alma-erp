# SPEC-155 Contract — Standard reasoner T3 tier
- `createT3Handler()` registered as `T3`; requires `taskKind = reason`; text or
  json (json validated); large context/output ceilings (200k/16k). Head class:
  gemini-3.1-pro by default.
- `createGovernorCostPort({ store, budgetsFor })` — concrete `CostAuthorizationPort`
  binding the real G04 Cost Governor (`authorize`/`settle`/`cancel`) + G03
  pricing (`getPrice`) + estimator (`estimateWorstCaseCost`/`estimateNormalCost`).
  Fail-closed: no price → DENIED; over-budget → BUDGET_EXCEEDED (provider never
  called); failure → reservation released. Pure arithmetic, no network.
