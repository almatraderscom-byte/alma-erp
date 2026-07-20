# SPEC-098 — Contract (normalize.ts, v1.0.0)
- MAX_ITEMS=10, MAX_SNIPPET_CHARS=300, MAX_TITLE_CHARS=200.
- `normalizeSearchResults(payload, maxItems=10): {items:{title,url?,snippet}[],
  total, truncated}` — detects rows in results/organic/data/items/hits/entries or
  a bare array; maps title/name/heading, url/link/href (http(s) only), snippet/
  description/text/…; trims + caps + bounds.
- Boundary `normalizeResults(raw): ComponentResult` — COMPLETED / FAILED_FINAL on
  empty-or-unrecognized; identity-enforced; never throws.
