# SPEC-015 Baseline — Intent classification adapter
No intent classifier existed. This spec adds a deterministic keyword classifier
behind an adapter seam (model-backed swap later, bounded + Cost-Governor-gated).
Additive, zero model calls now.
