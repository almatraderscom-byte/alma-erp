# SPEC-200 cost before/after

| metric | before | after |
|---|---|---|
| model calls | 0 | 0 |
| input tokens | 0 | 0 |
| cached input tokens | 0 | 0 |
| output/reasoning tokens | 0 | 0 |
| tool calls | 0 | 0 |
| estimated USD | 0 | 0 |
| actual USD | 0 | 0 |
| latency | n/a | certification runner ≈ 30s CI-side (gate executions), 0 runtime cost |
| successful outcome rate | n/a | deterministic |

No LLM call anywhere in the certification path (invariant 1). Cost impact: zero at runtime; CI adds one deterministic gate run per PR.
