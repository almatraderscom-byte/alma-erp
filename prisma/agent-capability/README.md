# prisma/agent-capability — PROPOSED (not-applied) capability schema

G09 owned zone for durable capability-catalog schema **proposals**. Files here are
NOT wired into the live migration system (`prisma/migrations`) and are NOT applied
to any database. The G09 runtime is deterministic and DB-free: it uses the
in-memory `CapabilityStore` (`src/agent/capabilities/store.ts`) seeded from the
generated catalog.

`0001_capability_catalog.proposed.sql` is the additive, reversible schema for when
a Postgres-backed store is adopted by the integration session with owner sign-off.
Applying it is out of G09's scope (the group never touches `prisma/schema.prisma`
or runs a migration on the live DB).
