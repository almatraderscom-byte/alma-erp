# SPEC-123 — Baseline (identity validation stage)
Parent: SPEC-122 (`28c6a755`). Owned zone: src/agent/tool-gateway.

The boundary validates identity on entry, but the pipeline itself must enforce
INV-02 (defense in depth) and tenant isolation for callers of runPipeline. No
in-pipeline identity/cross-tenant stage existed.
Migration boundary: a stage asserting the full ExecutionIdentity + a
resourceTenantId cross-tenant guard (new additive context field).
Files: contract.ts (edit: +resourceTenantId), stages/identity-validation.ts,
gateway.ts (edit), index.ts (edit), tests.
