# SPEC-099 — Baseline (tool result provenance)
Parent: SPEC-098 (`a49433a9`). Owned zones: selection, results.

Model views (096) carry an evidenceId but no full provenance envelope (tool,
tenant, correlation, source, truncation). A model result is not yet traceable
end-to-end.

Discovery:
```
$ grep -rn "provenance\|Provenance" src/agent/tools/results  # none before this spec
```
Migration boundary: stamp the model view with a provenance envelope + a fail-
closed completeness check.
Files: results/provenance.ts, tests, index.ts update.
