# SPEC-086 — Baseline (capability runtime & owner metadata)
Parent: SPEC-085 (`a214f63b`). Owned zones: capabilities, prisma/agent-capability.

The catalog carries runtime.groups/pools + owner (seeded SPEC-081) but nothing
proves the runtime surface matches the capability's tools, nor that the owner zone
is a valid agent-side G01 zone.

Discovery:
```
$ grep -n "runtime\|owner" src/agent/capabilities/capability.schema.ts
$ grep -n "resolveOwner" src/agent/contracts/ownership.ts
$ grep -rn "expectedRuntime\|checkRuntimeOwner" src/agent/capabilities  # none before
```
Migration boundary: runtime = union of tool routing; owner validated vs G01 zones
(agent-side, team match).
Files: runtime-owner.ts, tests, index.ts update.
