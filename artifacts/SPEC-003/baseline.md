# SPEC-003 Baseline — Repository ownership zones and CODEOWNERS model

## Discovery commands
```
$ test -f .github/CODEOWNERS && echo present || echo absent
$ node scripts/architecture/inventory.mjs   # zone census
```

## Current state
No `.github/CODEOWNERS` and no machine-readable ownership registry existed. Zone
ownership was implicit in `.aios/G01/RUNNER.md` (owned zones) and CLAUDE.md.

## Callers / dependencies
`ownership.ts` is inert in production; the script is a static/git analyzer.

## Provider/model/db calls
None. Script uses `git` (read-only) + node built-ins.

## Cost/latency
Zero model calls.

## Bypass paths
Group session editing another group's zone or a shared choke point. Now an
executable gate (`check-ownership.mjs`).

## Migration boundary
Additive. The real `.github/CODEOWNERS` is a shared choke point — NOT written
here (integration-only). A **proposal** is emitted to
`docs/architecture/CODEOWNERS.proposed`.

## Files expected to change
- `src/agent/contracts/ownership.ts` (+test)
- `scripts/architecture/check-ownership.mjs`
- `docs/architecture/ownership-zones.md`, `docs/architecture/CODEOWNERS.proposed`
