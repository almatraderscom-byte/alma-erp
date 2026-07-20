# SPEC-020 Contract — Admission bypass gate
`isAdmissionBypass(fromFile, importSpec)` (pure), `ADMISSION_INTERNAL_MODULES`,
`ADMISSION_PUBLIC_ENTRYPOINTS`; runner `check-admission-bypass.mjs` (exit 1 on any
bypass). Verified: probe injection → FAIL, removal → PASS. Rollback: `git revert --no-edit <SPEC-020 commit>`.
