# SPEC-129 — Baseline (audit + cost finalization)
Parent: SPEC-128 (`57ba6318`). Owned zone: src/agent/tool-gateway.

SPEC-125 reserves worst-case cost; nothing yet reconciles ACTUAL usage to the G04
ledger (commit) nor emits a correlated audit event. And a stage aborting AFTER the
reservation would leak the reserved budget.
Discovery:
```
$ grep -n "commit(reservationId\|release(reservationId" src/agent/budgets/budget.ts
$ grep -n "interface AuditEvent" src/agent/contracts/*.ts
```
Migration boundary: commit actual (clamped) + one audit event on success; release
reservation on abort (safety-net in runPipeline).
Files: stages/audit-finalization.ts, contract.ts (edit: release-on-abort),
gateway.ts (edit), index.ts (edit), tests.
