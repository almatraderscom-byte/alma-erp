# SPEC-093 — Contract (schema-minimizer.ts, v1.0.0)
- MAX_DESCRIPTION_CHARS=200, MAX_PROP_DESCRIPTION_CHARS=80.
- `minimizeSchema(schema)` — keep type/properties/required/enum/items/…; drop
  examples/$comment/title/default/format/pattern/…; trim property descriptions.
- `minimizeToolSchema(name): MinimizedTool|null` — {name, description(capped),
  input_schema(minimized), tokensBefore, tokensAfter} via finops estimateTokens.
- `minimizeShortlist(names): {tools, tokensBefore, tokensAfter, tokensSaved≥0}`.
- Invariant: tokensAfter ≤ tokensBefore (never adds tokens).
- Boundary `minimizeToolSchemas(raw): ComponentResult` — identity-enforced; no throw.
