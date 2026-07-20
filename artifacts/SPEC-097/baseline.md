# SPEC-097 — Baseline (large result summarization without LLM)
Parent: SPEC-096 (`57aac025`). Owned zones: selection, results.

The model view (096) caps bytes by truncating a serialized string — useful but
structure-blind. There is no deterministic, structure-preserving summarizer that
shrinks a large result WITHOUT a model call (INV-01 forbids an LLM here).

Discovery:
```
$ grep -rn "summarize" src/agent/tools/results  # none before this spec
```
Migration boundary: pure recursive summarizer (array head+count+digest, string
truncate+len, object key clip, depth clip) with a meta of what was truncated.
Files: results/summarize.ts, tests, index.ts update.
