# SPEC-094 — Contract (arg-validation.ts, v1.0.0)
- MAX_ARG_BYTES=65536.
- `validateToolArgs(toolName, args): {ok, code: unknown_tool|oversized_args|
  invalid_args|ok, error?}` — unknown tool / oversize / schema violation all fail;
  never throws.
- Boundary `admitToolCall(raw): ComponentResult` — ALLOWED only when tool exists
  AND args validate; else DENIED (OVERSIZED_INPUT for size, MALFORMED_INPUT
  otherwise); identity-enforced; never throws.
