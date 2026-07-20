# SPEC-127 — Cost before/after
0 → 0 in the gateway core. Actual provider cost is incurred by the (real) adapter
and returned as actualCostNanoUsd for reconciliation (SPEC-129). Tests use a fake
adapter (cost 0). No model/provider/DB/network call in gateway logic (INV-01/03). PASS.
