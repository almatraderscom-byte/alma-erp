# SPEC-151 Cost — before / after

| Metric | Before | After |
| --- | --- | --- |
| Model calls | 0 | 0 (only deterministic FAKE adapter; no provider) |
| Input tokens | 0 | 0 |
| Cached input tokens | 0 | 0 |
| Output/reasoning tokens | 0 | 0 |
| Tool calls | 0 | 0 |
| Estimated USD | 0 | 0 |
| Actual USD | 0 | 0 |
| Latency | n/a | deterministic, in-memory (<1s suite) |
| Successful outcome rate | n/a | 27/27 tests |

No cost increase: the group forbids real provider calls (INV-01). Token
estimation reuses the G03 heuristic estimator (no new tokenizer).
