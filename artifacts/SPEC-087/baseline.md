# SPEC-087 — Baseline (capability health model)
Parent: SPEC-086 (`f6b25497`). Owned zones: capabilities, prisma/agent-capability.

The catalog carries a health block (status/killSwitch) but no state machine, no
fail-closed availability rule, and no runtime override path (an operator cannot
kill-switch a capability without editing generated data).

Discovery:
```
$ grep -n "health\|killSwitch" src/agent/capabilities/capability.schema.ts
$ grep -rn "isAvailable\|nextHealth\|HealthOverride" src/agent/capabilities  # none before
```
Migration boundary: a deterministic health state machine + fail-closed
availability + an in-memory override store behind an interface.
Files: health.ts, tests, index.ts update.
