# Proposed agent cost schema (G03 / SPEC-028)

`agent_cost_event.prisma.proposed` is an **additive** model for durable cost
persistence. It is intentionally NOT part of `prisma/schema.prisma` and NO
migration is run by G03 — the live production database is untouched.

The integration session (not a group runner) will, when ready:
1. append the model to `prisma/schema.prisma`,
2. `prisma migrate dev --name add_agent_cost_event` (additive, no existing table
   altered),
3. implement a `PrismaCostLedger` satisfying `CostLedger` from
   `src/agent/finops/ledger.ts`.

Until then the in-memory `InMemoryCostLedger` is the default.
