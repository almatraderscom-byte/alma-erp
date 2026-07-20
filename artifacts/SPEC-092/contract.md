# SPEC-092 — Contract (shortlist.ts, v1.0.0)
- MAX_SHORTLIST=24, DEFAULT_SHORTLIST=12.
- `selectShortlist(candidates, max=12): Shortlist{toolNames[], total, truncated, cap}`
  — de-dupes, ranks read<stage<write then low<med<high risk then name, clamps cap
  to [1, MAX_SHORTLIST], slices.
- `shortlistForIntent(input, max)` — retrieval ∘ selectShortlist.
- Boundary `selectToolShortlist(raw): ComponentResult<Shortlist>` — COMPLETED
  bounded shortlist / DENIED when unresolved-or-empty; identity-enforced; no throw.
