# SPEC-124 — Unresolved risks
1. principal + resource are supplied by the (auth-aware) caller; wiring the real
   role source is the core-loop's job. The fail-closed default (no principal ⇒ DENY)
   holds until then. Severity: low. Critical: 0.
