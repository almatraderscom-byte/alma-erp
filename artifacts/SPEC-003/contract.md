# SPEC-003 Contract — Ownership zones

Module: `src/agent/contracts/ownership.ts`.

## Public contract
- `OWNERSHIP_ZONES` — ordered prefix→{owner, team, integrationOnly?} registry.
- `resolveOwner(path)` — boundary-safe zone lookup.
- `checkChangeSet(files, sessionOwner)` → `OwnershipViolation[]`. Fail-closed:
  unowned paths are reported, not allowed.
- `renderCodeowners()` — CODEOWNERS body from the registry.
- `OWNERSHIP_REASON_CODES` — OWNERSHIP_CONFLICT, UNOWNED_PATH, INTEGRATION_ONLY.

## Data ownership
Encodes who owns each path. Shared choke points (`prisma/schema.prisma`,
`package.json`, `.github`, legacy `src/app/api/agent`) are integration-only.

## Failure behaviour
Fail closed — any cross-owner or choke-point edit by a group session → violation.

## Cost / security
Zero model calls. `git`-read + fs only. No secrets.

## Rollback
`git revert --no-edit <SPEC-003 commit>`.
