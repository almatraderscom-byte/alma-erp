# SPEC-002 Contract — Invariants & forbidden-dependency rules

Module: `src/agent/contracts/invariants.ts`.

## Public contract
- `ARCHITECTURE_INVARIANTS` — the ten frozen invariants (stable ids INV-01..10).
- `Zone` — logical repo zones incl. agent-side `agent`, `agent-app`,
  `assistant-api`, `legacy-agent-api` (per CLAUDE.md the agent lives in
  `src/agent`, `src/app/agent`, `src/app/api/assistant`).
- `FORBIDDEN_IMPORT_RULES` — erp-app / erp-api / shared-lib must NOT import
  `agent` / `agent-contracts`.
- `zoneOf(path)`, `importTargetZone(spec)`, `checkImport(file, fromZone, spec)`
  → `ForbiddenImportViolation | null`. Pure, deterministic.
- `INVARIANT_REASON_CODES` — FORBIDDEN_IMPORT, UNKNOWN_ZONE.

## Enforcement
`scripts/architecture/check-forbidden-imports.mjs` — architecture ratchet with a
frozen baseline. Exit 0 on no new violations, exit 1 + list on regression.

## Failure behaviour
Fail closed: any new forbidden import → exit 1.

## Cost behaviour
Zero model calls.

## Security boundary
Static analysis only. No secrets, no network.

## Rollback command
`git revert --no-edit <SPEC-002 commit>` (see rollback-proof.md).
