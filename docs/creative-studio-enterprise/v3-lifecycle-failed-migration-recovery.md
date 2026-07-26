# Creative Studio V3 lifecycle failed-migration recovery

This is a held, one-time operator procedure for the failed preview migration
record created by deployment `dpl_8PyC4...` and observed as P3009 by
`dpl_BY1KezeCPMSERnFiJBxFx3CYGe7V`.

The audited failure is migration
`20260921130000_creative_lifecycle_production`, PostgreSQL SQLSTATE `42P17`, at
index `creative_lifecycle_feature_flags_exact_scope_key`. The failed definition
cast the `CreativeStudioRole` enum to text inside `COALESCE`; PostgreSQL does not
consider that cast immutable enough for an index expression.

The corrected migration uses six function-free partial unique indexes over raw
scope columns. This avoids relying on PostgreSQL 15 `NULLS NOT DISTINCT` because
the target database major version has not been proven from repository evidence
and this recovery must not connect merely to discover it.

## Safety boundary

The recovery program is not referenced by `build`, `postinstall`, Prisma
migrations, or Vercel configuration. It ignores ordinary `DATABASE_URL` and
connects only when an operator explicitly provides:

- exactly one of `--plan` or `--execute`;
- a DDL-capable direct or session-pooler `LIFECYCLE_RECOVERY_DATABASE_URL`;
- for execution, the exact acknowledgement token.

It aborts unless all of these invariants hold:

1. `_prisma_migrations` contains exactly one unresolved failed record with the
   exact migration name, `42P17`, and PostgreSQL's immutable-index error. The
   live schema must then match exactly one of two fail-closed shapes: either the
   entire failed batch was rolled back and none of its tables, columns, types or
   indexes exist, or every table and the final index created before the failed
   statement exists while the failed index and first later index remain absent.
   Mixed state is rejected. This proves the recovery boundary without assuming
   Prisma copied the SQL index name into its internal log text.
2. Every lifecycle table created by this migration is absent or contains zero
   rows.
3. Paid execution and rollout defaults, if their partial tables exist, remain
   default-off (`paid_execution_allowed=false`, `enabled=false`,
   `dual_read_enabled=false`, `canary_percent=0`); legacy fallback remains true.
4. Every lifecycle column partially added to existing review, delivery,
   performance, or archive tables contains only its migration default
   (`NULL`, or `{}` for `lineage_manifest`).
5. No post-failure sentinel index, FK, function, or trigger exists. Finding one
   means the observed state is not the audited failed-prefix state and recovery
   stops for manual investigation.

On `--execute`, the program repeats those checks under a Serializable
transaction and advisory lock. It removes only the known empty lifecycle tables,
the known default-only columns added to the four existing child tables, and the
three lifecycle enum types. Every DDL statement uses `RESTRICT`; any unexpected
dependency aborts and rolls back the entire cleanup.

It never drops or alters Foundation composition tables, versions, operation
batches, their pre-existing columns, or any object created before this lifecycle
migration. It does not use `CASCADE`.

## Operator commands

Freeze automatic preview deployments before beginning. From the audited
recovery commit, install exactly the lockfile dependencies:

```sh
npm ci
```

Set a DDL-capable direct or session-pooler URL in the dedicated variable. The
repository's proven Supabase session-pooler endpoint
`aws-1-ap-northeast-1.pooler.supabase.com:5432` is allowed. Port 6543,
`pgbouncer=true`, and explicit transaction-mode parameters are rejected:

```sh
export LIFECYCLE_RECOVERY_DATABASE_URL='postgresql://...session-or-direct-host:5432/postgres'
```

Validate the connection shape offline before any connection is opened. Output
contains only protocol, hostname, port, and database path—never credentials:

```sh
node scripts/recover-creative-lifecycle-migration.mjs --validate-connection-url
```

Run the read-only inventory first and retain its JSON output:

```sh
node scripts/recover-creative-lifecycle-migration.mjs --plan \
  > lifecycle-migration-recovery-plan.json
```

An independent reviewer must confirm `eligibleForExplicitRecovery: true`, the
exact error proof, zero table row counts, matching defaults, zero non-default
column counts, and an empty `postFailureObjects` array.

Then explicitly authorize the same audited script:

```sh
export LIFECYCLE_MIGRATION_RECOVERY_ACK='20260921130000_creative_lifecycle_production:ROLLBACK_FAILED_RECORD'
node scripts/recover-creative-lifecycle-migration.mjs --execute \
  > lifecycle-migration-recovery-execution.json
```

The program transactionally cleans only the safe partial prefix and invokes the
lockfile-installed equivalent of:

```sh
DATABASE_URL="$LIFECYCLE_RECOVERY_DATABASE_URL" \
  npx prisma migrate resolve \
  --rolled-back 20260921130000_creative_lifecycle_production \
  --schema prisma/schema.prisma
```

It verifies `rolled_back_at` afterward. It deliberately does **not** run
`prisma migrate deploy`.

After the recovery report is independently accepted and the corrected commit is
pushed, run or allow the normal corrected migration deployment. For a manual,
DDL-capable direct/session connection invocation:

```sh
DATABASE_URL="$LIFECYCLE_RECOVERY_DATABASE_URL" \
  node node_modules/prisma/build/index.js migrate deploy \
  --schema prisma/schema.prisma
```

Finally confirm migration status and retain the plan, execution, deploy, and
status output in the release evidence:

```sh
DATABASE_URL="$LIFECYCLE_RECOVERY_DATABASE_URL" \
  node node_modules/prisma/build/index.js migrate status \
  --schema prisma/schema.prisma
```

If any invariant fails, do not run `migrate resolve`, do not edit
`_prisma_migrations` manually, and do not broaden the cleanup list. Escalate the
inventory output for a separate database-specific recovery review.
