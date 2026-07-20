# SPEC-126 — Unresolved risks
1. Coded against G12's FROZEN AutonomyEngine seam; G12 is not yet in the wave. On a
   future rebase that folds G12 in, verify the real `@/agent/autonomy` interface
   still matches this seam (states + decide shape). If it changed, STOP + flag per
   the runner note. Severity: low (seam is structural; injection needs no code change).
Critical risks: 0.
