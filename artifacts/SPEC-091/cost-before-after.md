# SPEC-091 — Cost before/after
0 → 0 runtime. Retrieval is index+union in memory. Its PURPOSE is cost reduction:
it narrows the model-visible tool surface from 326 to a domain-scoped subset, cutting
tokens downstream (measured by SPEC-093). No model/provider/DB/network call
(INV-01/03). PASS.
