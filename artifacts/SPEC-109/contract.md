# SPEC-109 Contract — Policy obligations and redaction

## Public surface (`src/agent/policy/obligations.ts`)
- `parseObligation(raw)` — canonical strings: `redact:<path>`, `mask:<path>[:keepLast]`, `audit`, `deny_export` → `Obligation | null`.
- `maskValue(value, keepLast)` — keep last N chars; non-string → REDACTED.
- `applyObligations(payload, obligations[])` → `{ value, applied[], malformed[], auditRequired, denyExport }` — deep-cloned bounded view.
- `obligation` builder (`redact`/`mask`/`audit`/`denyExport`) for layers attaching obligations.
- Bounds: `MAX_OBLIGATIONS=128`, `MAX_PATH_DEPTH=16`. `REDACTED='[REDACTED]'`. `OBLIGATION_REASON_CODES`.

## Behavior (fail-closed, INV-05/INV-07)
- Obligations flow through the engine's `obligations: string[]` (SPEC-105) unchanged. Applier never mutates input, reports malformed instead of silently applying, never widens access. Deterministic.

## Failure / cost / security
- Never throws; malformed obligations surfaced. Cost: 0 model calls (INV-01). Redaction produces the bounded view models receive (INV-07).

## Rollback
`git revert --no-edit <SPEC-109 commit>` — restores exact pre-spec tree.
