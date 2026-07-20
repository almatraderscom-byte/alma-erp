# SPEC-126 — Baseline (approval / obligation stage)
Parent: SPEC-125 (`2fdabf16`, post-rebase onto wave 479b6a58). Owned zone: src/agent/tool-gateway.

REBASE PERFORMED before this spec (per dependency note): `git fetch && git rebase
origin/aios/integration-wave`. The wave advanced (G09/G10 import fixes) and my 5
commits replayed cleanly; build re-verified green (28 tests, tsc 0). G12 autonomy
is STILL NOT folded into the wave (`ls src/agent/autonomy` → absent), so per the
instruction this stage is coded against the FROZEN interface
`AutonomyEngine.decide(input): ComponentResult<AutonomyDecisionValue>` (states
AUTONOMOUS/NEEDS_APPROVAL/DENIED), injected as a deps seam. The interface has NOT
changed (nothing to reconcile). When G12 lands, a real engine satisfies this
structural type with no gateway change.

G11 `applyObligations(payload, obligations): {value,...}` provides redact/mask.
Migration boundary: autonomy approval gate + obligation-application helper.
Files: stages/approval-obligation.ts, gateway.ts (edit), index.ts (edit), tests.
