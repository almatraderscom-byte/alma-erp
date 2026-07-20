# SPEC-127 — Baseline (execution adapter stage)
Parent: SPEC-126 (`ce94d832`). Owned zone: src/agent/tool-gateway.

Tool execution must happen ONLY behind an adapter seam so the gateway core never
touches a provider/network (INV-01) and there is a single choke point the bypass
gate (130) can enforce. The ExecutionAdapter seam was defined in SPEC-121; this
stage invokes it.
Migration boundary: the execution stage = adapter.execute; non-success propagated
verbatim (INV-06); success carries rawPayload + actual cost.
Files: stages/execution-adapter.ts, gateway.ts (edit), index.ts (edit), tests.
