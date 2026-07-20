# SPEC-075 — Security proof
- Approval is fail-closed (INV-05): staged/high-risk/non-low-write tools require
  approval by construction — test asserts staged always requires approval.
- Every external side effect is marked requiresGateway (INV-04) and unknown-
  outcome effects requiresReconciliation (INV-06) — no external effect can be
  classified as gateway-free.
- `classifyToolRisk` rejects inconsistent manifests fail-closed and enforces
  identity; never throws. Secret scan: none. PASS.
