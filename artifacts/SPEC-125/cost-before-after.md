# SPEC-125 — Cost before/after
0 → 0 (the stage itself spends nothing). It GATES spend: a call is authorized only
if its worst-case cost fits the budget (reserve), else BUDGET_EXCEEDED. This is the
INV-03 pre-authorization point. No model/provider/DB/network call. PASS.
