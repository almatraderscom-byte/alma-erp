# SPEC-012 Baseline — Request source normalization
No canonical normalizer existed; each channel handled its own shape. This spec
adds a deterministic normalizer + first admission stage. Depends on G01 errors.
No provider/model/db calls, zero cost. Additive (owned zone control-plane).
