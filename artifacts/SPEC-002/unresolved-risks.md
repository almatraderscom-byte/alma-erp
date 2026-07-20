# SPEC-002 Unresolved Risks

Critical unresolved risks: **0**.

Tracked (non-blocking) debt:
- 101 pre-existing ERP/shared → agent imports across 44 files, frozen in the
  baseline and documented in `docs/architecture/dependency-debt.md`. Out of G01
  scope to fix (would require modifying live ERP code). The ratchet prevents any
  NEW violation; later groups own the inversion.
