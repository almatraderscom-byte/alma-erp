# SPEC-096 — Baseline (compact model-view contract)
Parent: SPEC-095 (`db5bd56c`). Owned zones: selection, results.

Evidence storage (095) retains full payloads but nothing produces the bounded,
sanitized VIEW the model actually receives, tied to an evidenceId. INV-07 wants
the model to see a bounded projection only.

Discovery:
```
$ grep -rn "buildModelView\|compactModelView" src/agent/tools/results  # none before
$ grep -n "boundedOutputView" src/agent/tools/registry/io-schema.ts    # G08 has a simpler bounded view
```
Migration boundary: store→redact→cap pipeline; fail-closed on oversize with an
evidence-referencing truncation marker.
Files: results/model-view.ts, tests, index.ts update.
