# SPEC-092 — Baseline (exact tool shortlist selection)
Parent: SPEC-091 (`af6378d8`). Owned zones: selection, results.

SPEC-091 retrieval returns all permitted domain tools (can be large for a broad
intentClass). Nothing bounds that to an exact model-visible shortlist with a hard
cap. Handing an unbounded set to the model wastes tokens and dilutes selection.

Discovery:
```
$ grep -rn "shortlist\|MAX_SHORTLIST" src/agent/tools/selection  # none before this spec
```
Migration boundary: deterministic "safest-first" ranking + hard cap (MAX_SHORTLIST).
Files: selection/shortlist.ts, tests, index.ts update.
