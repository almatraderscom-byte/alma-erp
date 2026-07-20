# SPEC-084 — Baseline (capability permission metadata)
Parent: SPEC-083 (`4e3e8036`). Owned zones: capabilities, prisma/agent-capability.

The SPEC-081 schema carries a permission block (scope/minRole/defaultDecision=deny)
but no evaluation logic. Today authorization is scattered across handlers /
turn-authorization; there is no capability-level, fail-closed authorize.

Discovery:
```
$ grep -rn "scope\|minRole\|defaultDecision" src/agent/capabilities/capability.schema.ts
$ grep -rn "evaluatePermission\|authorizeCapability" src/agent/capabilities  # none before
```
Migration boundary: a fail-closed privilege-lattice evaluator + metadata integrity
check + an ALLOWED/DENIED boundary.
Files: permission.ts, tests, index.ts update.
