# SPEC-127 — Unresolved risks
1. The real adapter implementations (network) are wired at integration time; the
   gateway only depends on the seam. The bypass gate (SPEC-130) enforces that no
   side-effect skips this seam. Severity: low. Critical: 0.
