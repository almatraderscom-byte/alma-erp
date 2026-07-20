# SPEC-125 — Baseline (cost authorization stage)
Parent: SPEC-124 (`110ae5b4`). Owned zone: src/agent/tool-gateway.

G04 Cost Governor = `@/agent/budgets/budget`: `BudgetStore.reserve(budget, amount)
→ Reservation|null` then commit/release. The gateway must reserve worst-case cost
before any spend and stop on BUDGET_EXCEEDED.
Discovery:
```
$ grep -n "reserve(budget\|InMemoryBudgetStore\|interface Reservation" src/agent/budgets/budget.ts
```
Migration boundary: reserve stage; null reservation ⇒ BUDGET_EXCEEDED; reservation
carried forward for SPEC-129 reconciliation.
Files: stages/cost-authorization.ts, gateway.ts (edit), index.ts (edit), tests.
