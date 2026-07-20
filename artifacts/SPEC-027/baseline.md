# SPEC-027 Baseline — Actual usage reconciliation
No estimate-vs-actual reconciliation existed. New: reconcile(price, estimate,
actual|null) → variance + status; null usage → UNKNOWN (INV-06, reconcile not
guess). Additive.
