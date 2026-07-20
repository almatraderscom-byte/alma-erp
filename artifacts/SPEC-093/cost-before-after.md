# SPEC-093 — Cost before/after
Runtime provider cost 0 → 0. This spec is a COST REDUCER: it lowers the tokens the
model pays for tool schemas (tokensAfter ≤ tokensBefore, measured per tool via the
finops estimator). Reduction is data-dependent (generated schemas are already
lean; verbose real schemas save more — the verbose-schema test shows annotation
drop + description trim). No model/provider/DB/network call (INV-01/03). PASS.
