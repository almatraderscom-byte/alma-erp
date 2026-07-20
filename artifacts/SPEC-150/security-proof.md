# SPEC-150 security proof
Chaos is the bypass hunt and it passes:
- cross-tenant enqueue rejected; per-tenant fairness/concurrency isolation holds.
- crash + unknown outcome NEVER blind-retries (INV-06) — stays LEASED / UNKNOWN_OUTCOME; exhausted indeterminate dead-letters.
- browser action cannot target a non-present (hallucinated/injected) element.
- secrets never reach the compact model view; oversize view fail-closed.
- runaway replans/stalls/cost/steps all hard-stop fail-closed; float cost cannot slip a ceiling.
