# SPEC-095 — Baseline (full evidence payload storage)
Parent: SPEC-094 (`6db1926c`). Owned zones: selection, results.

Tool results flow straight to the model today (bounded ad-hoc in the core loop);
there is no evidence store that retains the FULL payload while handing the model
only a reference. INV-07 wants full payloads in evidence, models bounded.

Discovery:
```
$ grep -rn "evidence\|EvidenceStore" src/agent/tools/results  # none before this spec
```
Migration boundary: content-addressed evidence store (interface + in-memory
default), deterministic ids, boundary returns id+size only (never the payload).
Files: results/evidence-store.ts, index.ts, tests.
