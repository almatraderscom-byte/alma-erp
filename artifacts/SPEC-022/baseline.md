# SPEC-022 Baseline — Tokenizer abstraction & estimation
No pre-call token estimator existed. New: TokenEstimator seam + deterministic
heuristic default (chars/4, over-estimates safe). Feeds cost estimators (025/026).
Additive, no model call.
