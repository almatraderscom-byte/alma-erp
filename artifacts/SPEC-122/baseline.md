# SPEC-122 — Baseline (schema validation stage)
Parent: SPEC-121 (`53532649`). Owned zone: src/agent/tool-gateway.

G10 provides `validateToolArgs(toolName,args)` (fail-closed on unknown/oversize/
invalid). The gateway needs its FIRST stage to gate tool args before any other
stage. Discovery:
```
$ grep -n "validateToolArgs\|MAX_ARG_BYTES" src/agent/tools/selection/arg-validation.ts
```
Migration boundary: a GatewayStage wrapping G10 arg validation; wired first in
DEFAULT_STAGES.
Files: stages/schema-validation.ts, gateway.ts (edit), index.ts (edit), tests.
