# SPEC-098 — Unresolved risks
1. Row-key heuristics cover common search/browser shapes; a novel provider shape
   would yield 0 items (FAILED_FINAL) rather than a wrong mapping — fail-safe.
   New shapes are additive. Severity: low. Critical risks: 0.
