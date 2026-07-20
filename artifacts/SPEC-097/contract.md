# SPEC-097 — Contract (summarize.ts, v1.0.0)
- DEFAULT_SUMMARIZE {maxItems:5, maxStringChars:200, maxDepth:4, maxKeys:40}.
- `summarize(value, opts?): {summary, meta{truncatedArrays,truncatedStrings,
  truncatedObjects,depthClipped}}` — arrays→head+_omitted+_total (+_digest for all-
  numeric); strings→{_str,_len}; objects→key-clip; depth clip. Per-field coalesce
  (explicit undefined never clobbers a default).
- Boundary `summarizeResult(raw): ComponentResult<SummarizeResult>` — identity-
  enforced; never throws.
