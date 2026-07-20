# SPEC-142 unresolved risks
- FairnessState counters grow unboundedly over a long run; a production wiring should periodically renormalize (subtract the min). No correctness impact on the deterministic core. 0 critical risks.
