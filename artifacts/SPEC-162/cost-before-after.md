# SPEC-162 Cost — before / after

| Metric | Before | After |
| --- | --- | --- |
| Real model calls | 0 | 0 (routing is a deterministic decision; G16 FAKE adapter only) |
| Input / output / reasoning tokens | 0 | 0 |
| Estimated / actual USD | 0 | 0 |
| Latency | n/a | deterministic in-memory |

Routing consumes G03 cost estimates as INPUTS; it makes no provider call (INV-01).
