# SPEC-093 — Baseline (tool schema token minimization)
Parent: SPEC-092 (`908a8570`). Owned zones: selection, results.

The model-facing tool definition today is `TOOL_DEFINITIONS = TOOLS.map(...)` — full
descriptions + full JSON schemas incl. verbose annotations. Nothing trims them for
the model, so every turn pays tokens for examples/titles/long descriptions. G05
provides a deterministic token estimator (`@/agent/finops/tokens`).

Discovery:
```
$ grep -n "estimateTokens" src/agent/finops/tokens.ts
$ grep -rn "minimize" src/agent/tools/selection  # none before this spec
```
Migration boundary: recursive annotation-strip + description caps, measured with
finops estimateTokens; after ≤ before invariant.
Files: selection/schema-minimizer.ts, tests, index.ts update.
