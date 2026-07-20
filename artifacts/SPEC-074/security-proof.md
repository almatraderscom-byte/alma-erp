# SPEC-074 — Security proof
- Unknown schema id → fail-CLOSED (a typo cannot skip validation) — test present.
- `boundedOutputView` redacts secret-looking keys and truncates oversized output
  so the model never receives secrets or an unbounded blob (INV-07) — tests
  assert `sk-123` / token never appear in the view.
- `validateToolIo` enforces the full ExecutionIdentity (missing actor →
  FAILED_FINAL, fail-closed) and never throws.
Secret scan of the module source: none. PASS.
