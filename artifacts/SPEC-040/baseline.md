# SPEC-040 Baseline — Budget bypass & overspend test gate
No executable overspend guarantee existed. New: checkBudgetInvariant + deterministic fuzz (2000 ops) proving spent+reserved never exceeds limit; overspend structurally impossible via reserve/commit encapsulation. Additive.
