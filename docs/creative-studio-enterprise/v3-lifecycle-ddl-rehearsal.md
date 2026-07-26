# Creative Studio V3 lifecycle DDL rehearsal

The repository preflight is static and non-mutating:

```sh
node scripts/creative-studio-lifecycle-ddl-preflight.mjs
```

It checks additive DDL, transaction compatibility for the exact
`prisma migrate deploy` path, `NOT VALID` staging for populated tables, a held
constraint-validation script outside `prisma/migrations`, held concurrent index declarations, exact
performance-version lineage, deferred READY evidence, and raw-column-only
automatic indexes (no function/cast index expressions). It does not connect
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
The automatic migration also carries explicit `BEGIN`/`COMMIT` markers, matching
the repository's transaction-wrapped Prisma deploy convention.

The nullable feature-flag scope is enforced by six function-free partial unique
indexes, one for each valid global/brand/project and optional-role shape.
Repository evidence does not establish the target PostgreSQL major version, so
the migration does not depend on PostgreSQL 15 `NULLS NOT DISTINCT`.

The one-time procedure for the audited failed `42P17` preview record is held in
`v3-lifecycle-failed-migration-recovery.md`. It is never part of an automatic
build or deploy.
