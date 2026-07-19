# SPEC-002 Baseline — Architecture invariants and forbidden dependency rules

## Discovery commands (exact)

```
$ rg -n "@/agent" src/app src/lib | wc -l     # existing ERP/lib → agent imports
$ node scripts/architecture/inventory.mjs      # zone census (from SPEC-001)
```

## Current implementation and aliases

No machine-readable invariant registry existed. The one-way dependency rule was
prose-only in `CLAUDE.md`. No executable gate enforced it.

## Callers and downstream dependencies

The forbidden-import scanner reads the whole `src/**` tree. Nothing imports the
new `invariants.ts` in production (inert until later groups adopt it).

## Direct provider / model / tool / database calls

None introduced. The scanner is a static analyzer (node:fs/node:path only).

## Current tests

No prior test asserted the dependency direction. This spec adds the first.

## Cost / latency evidence

Zero model calls (see cost-before-after.md).

## Tenant / permission / audit propagation

N/A for this spec (dependency-direction governance).

## Likely bypass paths — MEASURED, not assumed

Running the scanner revealed **101 pre-existing violations across 44 files**
(erp-api 32, erp-app 18, shared-lib 51) — production code importing `@/agent/*`.
These predate the freeze and are OUT OF SCOPE to modify (CLAUDE.md hard rule:
never modify existing ERP code outside the phase's files). Handled via a frozen
baseline ratchet; documented in `docs/architecture/dependency-debt.md`.

## Proposed migration boundary

Additive. New: `invariants.ts`, the scanner, the baseline, invariants + debt
docs. No production file modified.

## Files expected to change

- `src/agent/contracts/invariants.ts` (+ test)
- `scripts/architecture/check-forbidden-imports.mjs`
- `docs/architecture/invariants.md`, `dependency-debt.md`, `forbidden-imports.baseline.json`
