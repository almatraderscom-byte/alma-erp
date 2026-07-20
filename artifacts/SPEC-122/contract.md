# SPEC-122 — Contract (schema-validation.ts)
- `schemaValidationStage: GatewayStage` — runs G10 `validateToolArgs(ctx.toolName,
  ctx.args)`; ok → advance; oversized_args → DENIED(OVERSIZED_INPUT); unknown_tool /
  invalid_args → DENIED(MALFORMED_INPUT). Never throws.
- Wired first in `DEFAULT_STAGES`.
