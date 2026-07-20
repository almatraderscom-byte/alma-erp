# SPEC-078 — Contract  (deprecation.ts, contract v1.0.0)

- `callability(m): Callability` — active/preview callable; deprecated callable+warn;
  removed NOT callable (fail-closed) + points at replacement.
- `resolveMigration(name, lookup?): MigrationResolution{target,chain,cycle,unresolved}`
  — follows replacedBy to the terminal successor; cycle-safe; unresolved target flagged.
- `checkDeprecation(m, lookup?) / checkAllDeprecations(set)` — integrity:
  BAD_REMOVE_ORDER (removeAfter ≤ since), MISSING_REPLACEMENT, MIGRATION_CYCLE.
- Boundary `queryDeprecation(raw): ComponentResult` — callability|resolveMigration;
  identity-enforced; never throws.
