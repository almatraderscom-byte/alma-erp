# SPEC-166 Contract — Escalation budget enforcement
- `createInMemoryEscalationBudget({maxEscalationsPerDay, maxFrontierPerDay})` — per-actor
  per-day counters; day bucket from an INJECTED clock (INV-01). Frontier consumes BOTH
  the general and the frontier counter; stricter frontier cap checked first.
- `enforceEscalation(req, {budget, clock})` → validate (SPEC-165) THEN consume budget;
  over cap → `BUDGET_EXCEEDED` (`ESCALATION_DAILY_CAP_EXCEEDED` /
  `ESCALATION_FRONTIER_DAILY_CAP_EXCEEDED`). A reason failure passes through without
  consuming budget. Caps are per-actor; reset on a new day.
