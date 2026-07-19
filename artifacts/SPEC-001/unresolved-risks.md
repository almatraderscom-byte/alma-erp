# SPEC-001 Unresolved Risks

Critical unresolved risks: **0**.

Notes (non-blocking):
- Inventory counts are a point-in-time snapshot; re-run the scanner to refresh.
  This is by design — the map enumerates the migration surface, not fixed counts.
- The contract is not yet adopted by any runtime call-site; adoption is the job
  of later groups (G02+). Until then the module is inert (nothing imports it).
