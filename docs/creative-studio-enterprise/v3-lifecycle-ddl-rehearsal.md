# Creative Studio V3 lifecycle DDL rehearsal

The repository preflight is static and non-mutating:

```sh
node scripts/creative-studio-lifecycle-ddl-preflight.mjs
```

It checks additive DDL, transaction compatibility for the exact
`prisma migrate deploy` path, `NOT VALID` staging for populated tables, a held
constraint-validation script outside `prisma/migrations`, held concurrent index declarations, exact
performance-version lineage, and deferred READY evidence. It does not connect
to PostgreSQL, execute DDL, measure locks, or prove production latency.

Before production scheduling, restore a representative production backup into
a disposable database, verify that its URL cannot resolve to production, and
run the additive migration, then execute the held validation script separately
under a controlled release procedure. Capture:

- per-statement and total duration;
- row counts and orphan/preflight queries for review, delivery, performance,
  and archive tables;
- `pg_stat_activity` and `pg_locks` during index creation and constraint
  validation;
- application read/write latency during the rehearsal;
- migration rollback procedure and legacy-fallback smoke results.

This branch has not run that representative restored-database rehearsal.
Accordingly, it makes no low-lock, duration, or production-readiness claim.

The automatic migration contains no executable `CREATE INDEX CONCURRENTLY`;
required identity indexes use ordinary transactional `CREATE INDEX` because
the Foundation/lifecycle tables are new and default-off. Optional child-table
indexes remain in the held script and must never be sent through Prisma deploy.
