# SPEC-098 — Baseline (search & browser result normalization)
Parent: SPEC-097 (`c1cfa75c`). Owned zones: selection, results.

Search/browser tools (research, seo, live-browser) return heterogeneous shapes;
the model sees inconsistent structure and raw urls. No canonical, sanitized
normalizer exists.

Discovery:
```
$ grep -rn "normalize" src/agent/tools/results  # none before this spec
```
Migration boundary: shape detection ({results|organic|data|items|hits|entries} /
bare array / strings) → canonical {title,url?,snippet}, http(s)-only urls, bounded.
Files: results/normalize.ts, tests, index.ts update.
