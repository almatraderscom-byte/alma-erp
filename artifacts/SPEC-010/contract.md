# SPEC-010 Contract — Freeze baseline gate
`freeze.ts`: `FREEZE_GATE_STEPS` (6 steps across typecheck/test/dependency/
ownership/adr/proof), `coversAllKinds`, `freezeHolds`. `index.ts` barrel exports
the whole frozen surface. Runner `scripts/architecture/freeze-gate.mjs` — exit 0
only if all steps pass. Zero model calls. Rollback: `git revert --no-edit <SPEC-010 commit>`.
