# SPEC-028 Baseline — Cost event ledger
Legacy cost-events.ts exists but no typed append-only priced ledger. New:
CostEvent + CostLedger interface + InMemoryCostLedger. Durable Prisma model is a
PROPOSED (not-applied) migration under prisma/agent-cost/ — live schema.prisma
UNTOUCHED, no migration run (owner decision / production safety). Legacy untouched.
