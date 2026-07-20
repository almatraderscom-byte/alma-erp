# SPEC-094 — Baseline (tool argument validation)
Parent: SPEC-093 (`a4b0a141`). Owned zones: selection, results.

G08 io-schema `validateInput` exists (fails closed on unknown schema id) but there
is no selection-side gate keyed by TOOL NAME that resolves the tool → schema and
bounds argument size before a handler runs.

Discovery:
```
$ grep -n "validateInput\|hasSchema" src/agent/tools/registry/io-schema.ts
$ grep -rn "validateToolArgs\|admitToolCall" src/agent/tools/selection  # none before
```
Migration boundary: name→schema resolution + size bound + Ajv validation, all
fail-closed, ALLOWED/DENIED boundary.
Files: selection/arg-validation.ts, tests, index.ts update.
