# SPEC-057 Cost Before/After — Memory relevance scoring

This spec adds deterministic types / static scripts / docs only. Invariant #1
forbids an LLM call for validation, routing, permission or budget arithmetic;
this spec makes **zero** model and network calls.

| Metric | Before | After | Delta |
| --- | --- | --- | --- |
| model calls | 0 | 0 | 0 |
| input tokens | 0 | 0 | 0 |
| cached input tokens | 0 | 0 | 0 |
| output/reasoning tokens | 0 | 0 | 0 |
| tool calls | 0 | 0 | 0 |
| estimated USD | 0.00 | 0.00 | 0.00 |
| actual USD | 0.00 | 0.00 | 0.00 |
| test-suite latency | n/a | see test-results.md | — |
| successful outcome rate | n/a | 100% tests pass | — |

**No cost regression.** Measured, not asserted.

