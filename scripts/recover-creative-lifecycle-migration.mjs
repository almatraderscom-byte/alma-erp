#!/usr/bin/env node
/**
 * One-time recovery for the failed 20260921130000 lifecycle migration.
 *
 * This file is never imported by build/deploy scripts. It will not connect
 * unless an operator explicitly supplies --plan or --execute and a dedicated
 * LIFECYCLE_RECOVERY_DATABASE_URL. --validate-connection-url is offline.
 * --execute additionally requires the exact acknowledgement token below.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Prisma, PrismaClient } from '@prisma/client'

const execFileAsync = promisify(execFile)
const migrationName = '20260921130000_creative_lifecycle_production'
const failedIndexName = 'creative_lifecycle_feature_flags_exact_scope_key'
const executeAck = `${migrationName}:ROLLBACK_FAILED_RECORD`
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const newTables = [
  'creative_archive_verification_attempts',
  'creative_lifecycle_flag_audit_events',
  'creative_lifecycle_audit_events',
  'creative_lifecycle_receipts',
  'creative_lifecycle_feature_flags',
  'creative_lifecycle_jobs',
]

const newTypes = [
  'CreativeLifecycleJobKind',
  'CreativeLifecycleJobStatus',
  'CreativeLifecycleEffectClass',
]

const addedColumns = {
  creative_asset_review_events: [
    'composition_id',
    'composition_version_id',
    'composition_version',
    'composition_document_hash',
    'approved_artifact_version_id',
  ],
  creative_publish_deliveries: [
    'composition_id',
    'composition_version_id',
    'composition_version',
    'composition_document_hash',
    'operation_batch_id',
    'review_fingerprint',
    'render_fingerprint',
  ],
  creative_performance_snapshots: [
    'composition_id',
    'composition_version_id',
    'composition_version',
    'composition_document_hash',
    'operation_batch_id',
    'review_fingerprint',
    'render_fingerprint',
  ],
  creative_archive_receipts: [
    'composition_id',
    'composition_version_id',
    'composition_version',
    'composition_document_hash',
    'operation_batch_id',
    'operation_package_checksum',
    'artifact_checksum',
    'archive_checksum',
    'fetch_back_checksum',
    'fetch_back_verified_at',
    'playable_proxy_path',
    'original_storage_path',
    'render_storage_path',
    'lineage_manifest',
  ],
}

const requiredDefaults = {
  creative_lifecycle_jobs: {
    effect_class: "'ZERO_COST_LOCAL'",
    estimated_cost_bdt: '0',
    paid_execution_allowed: 'false',
    status: "'QUEUED'",
  },
  creative_lifecycle_feature_flags: {
    enabled: 'false',
    dual_read_enabled: 'false',
    legacy_fallback_enabled: 'true',
    canary_percent: '0',
  },
}

const postFailureSentinels = [
  'creative_lifecycle_flag_audit_events_owner_id_idempotency_key_key',
  'creative_compositions_id_owner_id_brand_profile_id_project_id_key',
  'creative_lifecycle_jobs_composition_scope_fkey',
  'creative_lifecycle_ready_receipt_validate',
  'creative_lifecycle_job_pin_validate',
  'creative_lifecycle_ready_evidence_consistency',
  'creative_lifecycle_ready_job_immutable',
  'creative_lifecycle_result_artifact_immutable',
]

function quoteIdentifier(value) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error(`unsafe SQL identifier: ${value}`)
  }
  return `"${value}"`
}

function safeDatabaseLabel(value) {
  const url = new URL(value)
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`
}

function assertDdlCapableDatabaseUrl(value) {
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('LIFECYCLE_RECOVERY_DATABASE_URL must be PostgreSQL')
  }
  const transactionMode = [
    url.searchParams.get('pool_mode'),
    url.searchParams.get('poolmode'),
    url.searchParams.get('proxy_mode'),
    url.searchParams.get('mode'),
  ].some((mode) => mode?.toLowerCase() === 'transaction')
  const pgbouncerTransactionSemantics = ['true', '1'].includes(
    url.searchParams.get('pgbouncer')?.toLowerCase() ?? '',
  )
  if (
    url.port === '6543'
    || pgbouncerTransactionSemantics
    || transactionMode
  ) {
    throw new Error(
      'Recovery requires a DDL-capable direct or session-pooler connection; transaction-pooler semantics are rejected',
    )
  }
}

async function migrationRecord(client) {
  const rows = await client.$queryRawUnsafe(
    `SELECT migration_name, started_at, finished_at, rolled_back_at,
            applied_steps_count, logs
       FROM "_prisma_migrations"
      WHERE migration_name = $1
      ORDER BY started_at`,
    migrationName,
  )
  if (rows.length !== 1) {
    throw new Error(`expected exactly one ${migrationName} record; found ${rows.length}`)
  }
  const row = rows[0]
  const logs = String(row.logs ?? '')
  if (row.finished_at !== null || row.rolled_back_at !== null) {
    throw new Error('migration record is not an unresolved failed attempt')
  }
  const hasSqlState = logs.includes('42P17')
  const hasImmutableIndexError =
    logs.includes('functions in index expression must be marked IMMUTABLE')
  if (!hasSqlState || !hasImmutableIndexError) {
    throw new Error(
      `failed migration log does not match the audited immutable-index failure `
      + `(sqlState42P17=${hasSqlState}, immutableIndexError=${hasImmutableIndexError})`,
    )
  }
  return {
    migrationName: row.migration_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    rolledBackAt: row.rolled_back_at,
    appliedStepsCount: row.applied_steps_count,
    errorProof: {
      sqlState42P17: true,
      immutableIndexError: true,
      failedIndexName,
      failedIndexConfirmedBySchemaBoundary: true,
    },
  }
}

async function tableExists(client, table) {
  const rows = await client.$queryRawUnsafe(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    `public.${table}`,
  )
  return Boolean(rows[0]?.present)
}

async function columnExists(client, table, column) {
  const rows = await client.$queryRawUnsafe(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS present`,
    table,
    column,
  )
  return Boolean(rows[0]?.present)
}

async function inspectState(client) {
  const tables = []
  for (const table of newTables) {
    const present = await tableExists(client, table)
    let rowCount = null
    if (present) {
      const rows = await client.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(table)}`,
      )
      rowCount = Number(rows[0]?.count ?? 0)
    }
    tables.push({ table, present, rowCount })
  }

  const defaults = []
  for (const [table, columns] of Object.entries(requiredDefaults)) {
    for (const [column, expectedPrefix] of Object.entries(columns)) {
      const rows = await client.$queryRawUnsafe(
        `SELECT column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        table,
        column,
      )
      const actual = rows[0]?.column_default ?? null
      defaults.push({
        table,
        column,
        present: rows.length === 1,
        expectedPrefix,
        actual,
        matches: rows.length === 0 || String(actual).startsWith(expectedPrefix),
      })
    }
  }

  const columns = []
  for (const [table, names] of Object.entries(addedColumns)) {
    for (const column of names) {
      const present = await columnExists(client, table, column)
      let nonDefaultRows = null
      if (present) {
        const predicate = column === 'lineage_manifest'
          ? `${quoteIdentifier(column)} IS DISTINCT FROM '{}'::jsonb`
          : `${quoteIdentifier(column)} IS NOT NULL`
        const rows = await client.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS count
             FROM ${quoteIdentifier(table)}
            WHERE ${predicate}`,
        )
        nonDefaultRows = Number(rows[0]?.count ?? 0)
      }
      columns.push({ table, column, present, nonDefaultRows })
    }
  }

  const typeRows = await client.$queryRawUnsafe(
    `SELECT typname
       FROM pg_type
      WHERE typname = ANY($1::text[])
      ORDER BY typname`,
    newTypes,
  )
  const indexRows = await client.$queryRawUnsafe(
    `SELECT indexname, tablename, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      ORDER BY tablename, indexname`,
    newTables,
  )
  const sentinelRows = await client.$queryRawUnsafe(
    `SELECT object_name, object_kind
       FROM (
         SELECT indexname AS object_name, 'index'::text AS object_kind
           FROM pg_indexes
          WHERE schemaname = 'public'
         UNION ALL
         SELECT conname, 'constraint'
           FROM pg_constraint
         UNION ALL
         SELECT proname, 'function'
           FROM pg_proc
         UNION ALL
         SELECT tgname, 'trigger'
           FROM pg_trigger
          WHERE NOT tgisinternal
       ) objects
      WHERE object_name = ANY($1::text[])
      ORDER BY object_kind, object_name`,
    postFailureSentinels,
  )

  return {
    tables,
    defaults,
    addedColumns: columns,
    types: typeRows.map((row) => row.typname),
    indexes: indexRows,
    postFailureObjects: sentinelRows,
  }
}

function assertSafePartialState(state) {
  const presentTables = state.tables.filter((entry) => entry.present)
  const presentColumns = state.addedColumns.filter((entry) => entry.present)
  const prefixIndexNames = new Set(state.indexes.map((entry) => entry.indexname))
  const fullyRolledBack =
    presentTables.length === 0
    && presentColumns.length === 0
    && state.types.length === 0
    && state.indexes.length === 0
  const missingPrefixTables = state.tables.filter((entry) => !entry.present)
  const exactPartialPrefix =
    missingPrefixTables.length === 0
    && prefixIndexNames.has('creative_lifecycle_feature_flags_updated_by_id_idx')
    && !prefixIndexNames.has(failedIndexName)
  if (!fullyRolledBack && !exactPartialPrefix) {
    throw new Error(
      'failed lifecycle schema is neither fully rolled back nor the exact audited partial prefix',
    )
  }
  const populated = state.tables.filter((entry) => entry.present && entry.rowCount !== 0)
  if (populated.length) {
    throw new Error(`lifecycle tables contain data: ${populated.map((entry) => entry.table).join(', ')}`)
  }
  const unsafeColumns = state.addedColumns.filter(
    (entry) => entry.present && entry.nonDefaultRows !== 0,
  )
  if (unsafeColumns.length) {
    throw new Error(
      `lifecycle columns contain non-default data: ${unsafeColumns.map(
        (entry) => `${entry.table}.${entry.column}`,
      ).join(', ')}`,
    )
  }
  const badDefaults = state.defaults.filter((entry) => entry.present && !entry.matches)
  if (badDefaults.length) {
    throw new Error(
      `lifecycle default-off contract mismatch: ${badDefaults.map(
        (entry) => `${entry.table}.${entry.column}`,
      ).join(', ')}`,
    )
  }
  if (state.postFailureObjects.length) {
    throw new Error(
      `objects created after the failed statement were found: ${state.postFailureObjects.map(
        (entry) => `${entry.object_kind}:${entry.object_name}`,
      ).join(', ')}`,
    )
  }
  return fullyRolledBack ? 'fully_rolled_back' : 'exact_partial_prefix'
}

async function removeKnownPartialPrefix(client) {
  for (const table of newTables) {
    await client.$executeRawUnsafe(`DROP TABLE IF EXISTS ${quoteIdentifier(table)} RESTRICT`)
  }
  for (const [table, columns] of Object.entries(addedColumns)) {
    for (const column of columns) {
      await client.$executeRawUnsafe(
        `ALTER TABLE ${quoteIdentifier(table)}
           DROP COLUMN IF EXISTS ${quoteIdentifier(column)} RESTRICT`,
      )
    }
  }
  for (const type of newTypes) {
    await client.$executeRawUnsafe(`DROP TYPE IF EXISTS ${quoteIdentifier(type)} RESTRICT`)
  }
}

function assertCleanupComplete(state) {
  const remaining = [
    ...state.tables.filter((entry) => entry.present).map((entry) => `table:${entry.table}`),
    ...state.addedColumns
      .filter((entry) => entry.present)
      .map((entry) => `column:${entry.table}.${entry.column}`),
    ...state.types.map((type) => `type:${type}`),
  ]
  if (remaining.length) {
    throw new Error(`known partial lifecycle objects remain after cleanup: ${remaining.join(', ')}`)
  }
}

async function resolveRolledBack(databaseUrl) {
  const prismaCli = join(repoRoot, 'node_modules/prisma/build/index.js')
  if (!existsSync(prismaCli)) {
    throw new Error('local lockfile-installed Prisma CLI is missing; run npm ci before recovery')
  }
  await execFileAsync(
    process.execPath,
    [
      prismaCli,
      'migrate',
      'resolve',
      '--rolled-back',
      migrationName,
      '--schema',
      join(repoRoot, 'prisma/schema.prisma'),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      maxBuffer: 1024 * 1024,
    },
  )
}

async function verifyRolledBack(client) {
  const rows = await client.$queryRawUnsafe(
    `SELECT finished_at, rolled_back_at
       FROM "_prisma_migrations"
      WHERE migration_name = $1`,
    migrationName,
  )
  if (rows.length !== 1 || rows[0].finished_at !== null || rows[0].rolled_back_at === null) {
    throw new Error('Prisma did not mark the exact failed migration as rolled back')
  }
  return { finishedAt: null, rolledBackAt: rows[0].rolled_back_at }
}

async function main() {
  const plan = process.argv.includes('--plan')
  const execute = process.argv.includes('--execute')
  const validateConnectionOnly = process.argv.includes('--validate-connection-url')
  if (Number(plan) + Number(execute) + Number(validateConnectionOnly) !== 1) {
    throw new Error(
      'explicitly choose exactly one mode: --plan, --execute, or --validate-connection-url',
    )
  }
  const databaseUrl = process.env.LIFECYCLE_RECOVERY_DATABASE_URL
  if (!databaseUrl) {
    throw new Error('LIFECYCLE_RECOVERY_DATABASE_URL is required; DATABASE_URL is intentionally ignored')
  }
  assertDdlCapableDatabaseUrl(databaseUrl)
  if (validateConnectionOnly) {
    console.log(JSON.stringify({
      mode: 'offline_connection_validation',
      database: safeDatabaseLabel(databaseUrl),
      ddlCapableConnectionShape: true,
      networkAccess: false,
    }, null, 2))
    return
  }
  if (execute && process.env.LIFECYCLE_MIGRATION_RECOVERY_ACK !== executeAck) {
    throw new Error(`--execute requires LIFECYCLE_MIGRATION_RECOVERY_ACK=${executeAck}`)
  }

  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  try {
    const failedMigration = await migrationRecord(client)
    const before = await inspectState(client)
    const recoveryShape = assertSafePartialState(before)
    const report = {
      mode: execute ? 'execute' : 'plan',
      database: safeDatabaseLabel(databaseUrl),
      failedMigration,
      recoveryShape,
      before,
      databaseMutation: execute
        ? 'guarded_schema_cleanup_and_prisma_migration_metadata_update'
        : 'none',
      businessRowMutation: false,
      foundationObjectsDropped: false,
    }
    if (plan) {
      console.log(JSON.stringify({
        ...report,
        eligibleForExplicitRecovery: true,
        nextStep: `Re-run with --execute and LIFECYCLE_MIGRATION_RECOVERY_ACK=${executeAck}`,
      }, null, 2))
      return
    }

    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        migrationName,
      )
      await migrationRecord(tx)
      const lockedState = await inspectState(tx)
      const lockedRecoveryShape = assertSafePartialState(lockedState)
      if (lockedRecoveryShape !== recoveryShape) {
        throw new Error('lifecycle recovery shape changed after acquiring the advisory lock')
      }
      await removeKnownPartialPrefix(tx)
      assertCleanupComplete(await inspectState(tx))
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000,
    })
    await client.$disconnect()

    await resolveRolledBack(databaseUrl)

    const verifier = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
    try {
      const resolved = await verifyRolledBack(verifier)
      console.log(JSON.stringify({
        ...report,
        cleanup: 'known-empty-partial-prefix-removed-transactionally',
        resolved,
        correctedMigrationDeployRun: false,
        nextStep:
          'After auditing this report and corrected commit, run the repository lockfile-installed `prisma migrate deploy` separately.',
      }, null, 2))
    } finally {
      await verifier.$disconnect()
    }
  } finally {
    await client.$disconnect()
  }
}

main().catch((error) => {
  console.error(`[lifecycle-migration-recovery] ${error.stack ?? error.message}`)
  process.exitCode = 1
})
