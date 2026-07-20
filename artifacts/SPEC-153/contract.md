# SPEC-153 Contract — Classifier and extractor T1 tier
- `createT1Handler()` — `TierHandler` for `T1`; registered in `defaultTierHandlers`.
- Admits only `taskKind ∈ {classify, extract}` and `responseFormat = json`
  (structured-only); otherwise `MALFORMED_INPUT`.
- Output bounded to `TIER_DEFINITIONS.T1.maxOutputTokens` (512).
- `finalize`: provider text must be valid JSON (`MODEL_OUTPUT_MALFORMED` otherwise);
  for `classify` with a closed `labels` set, the `label` must be a member.
- New optional contract field `labels?: string[]`.
