# SPEC-007 Contract — ADR
`src/agent/contracts/adr.ts`: `ADR_STATUSES`, `ADR_REQUIRED_SECTIONS`,
`parseAdrFilename`, `lintAdrBody`. Gate `scripts/architecture/check-adr.mjs`
validates filename/sections/status/sequential numbering. ADR-0001 records the
architecture freeze. Zero model calls. Rollback: `git revert --no-edit <SPEC-007 commit>`.
