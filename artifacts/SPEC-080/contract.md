# SPEC-080 — Contract  (removal-gate.ts, contract v1.0.0)

- `evaluateRemovalGate(opts?): GateReport{canRemove, checks, blockers, summary}`
  Checks (all must PASS; fail-closed): PARITY, SCHEMA, CLASSIFY, OWNERSHIP,
  DEPRECATION, IO, BUILDABLE, CUTOVER. `canRemove` true only when blockers empty.
  CUTOVER (operational; `enforceCutoverDone`) defaults FALSE.
- `PROPOSED_REMOVAL_PLAN: readonly string[]` — the NON-applied removal steps.
- Boundary `queryRemovalGate(raw): ComponentResult<GateReport>` — identity-enforced;
  never throws; never deletes anything.
