# SPEC-011 Contract — Admission gateway
`admit(raw, stages): ComponentResult<AdmissionReceipt>` — the single door.
- Validates envelope + identity via G01 `validateRequest` (fail-closed).
- `AdmissionStage` interface: pure `run(ctx) -> {ok,ctx} | {ok:false,failure}`.
- `AdmissionContext` threads identity+input+annotations+evidenceIds.
- `ADMISSION_STAGES` registry (empty baseline; later specs append).
Interface with G01: component (ComponentResult/validateRequest), execution-identity.
No model/provider/db call. Rollback: `git revert --no-edit <SPEC-011 commit>`.
