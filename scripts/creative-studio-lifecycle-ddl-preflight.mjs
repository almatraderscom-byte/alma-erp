#!/usr/bin/env node
/**
 * Static DDL preflight only. This script reads migration SQL and never opens a
 * database connection. It deliberately does not claim a representative restore
 * rehearsal or low-lock proof.
 */
import { readFile } from 'node:fs/promises'

const addPath = new URL(
  '../prisma/migrations/20260921130000_creative_lifecycle_production/migration.sql',
  import.meta.url,
)
const validatePath = new URL(
  '../docs/creative-studio-enterprise/sql/creative-lifecycle-validate-existing.sql',
  import.meta.url,
)
const [addSql, validateSql] = await Promise.all([
  readFile(addPath, 'utf8'),
  readFile(validatePath, 'utf8'),
])

const validationNames = [...validateSql.matchAll(/VALIDATE CONSTRAINT "([^"]+)"/g)]
  .map((match) => match[1])
const missingFromAdd = validationNames.filter(
  (name) => !addSql.includes(`CONSTRAINT "${name}"`),
)
const checks = {
  additiveOnly: !/\bDROP\s+(TABLE|COLUMN|TYPE|CONSTRAINT)\b/i.test(addSql),
  automaticMigrationTransactionCompatible:
    !/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(addSql),
  populatedConstraintsStagedNotValid: validationNames.every((name) => {
    const start = addSql.indexOf(`CONSTRAINT "${name}"`)
    if (start < 0) return false
    const end = addSql.indexOf(';', start)
    return addSql.slice(start, end < 0 ? undefined : end).includes('NOT VALID')
  }),
  validationHeldOutsideDeploy:
    validationNames.length >= 19
    && missingFromAdd.length === 0
    && validateSql.includes('deliberately outside prisma/migrations'),
  heldPopulatedIndexesConcurrent: [
    'creative_asset_review_events',
    'creative_publish_deliveries',
    'creative_performance_snapshots',
    'creative_archive_receipts',
  ].every((table) => validateSql.includes(
    `INDEX CONCURRENTLY IF NOT EXISTS "creative_${table.slice(9)}`,
  )),
  requiredCompositeIndexesBeforeForeignKeys: [
    'creative_compositions_id_owner_id_brand_profile_id_project_id_key',
    'creative_brand_profiles_id_owner_id_key',
    'creative_projects_id_owner_id_brand_profile_id_key',
    'creative_composition_versions_exact_identity_key',
    'creative_operation_batches_exact_result_key',
  ].every((name) => {
    const indexPosition = addSql.indexOf(`INDEX "${name}"`)
    const firstForeignKey = addSql.indexOf('FOREIGN KEY (')
    return indexPosition >= 0 && indexPosition < firstForeignKey
  }),
  exactPerformanceVersionProof:
    addSql.includes('"creative_performance_snapshots_exact_composition_version_fkey"')
    && addSql.includes('FOREIGN KEY ("composition_version_id", "composition_id", "composition_version", "composition_document_hash")'),
  readyEvidenceDeferred:
    addSql.includes('DEFERRABLE INITIALLY DEFERRED')
    && addSql.includes('creative_lifecycle_receipts_single_ready_job_key'),
}

const report = {
  ok: Object.values(checks).every(Boolean),
  mode: 'static_ddl_preflight',
  productionMutation: false,
  networkAccess: false,
  representativeDatabaseRehearsal: 'not_run',
  lowLockProof: false,
  checks,
  validationConstraintCount: validationNames.length,
  missingFromAdd,
  requiredNextStep:
    'Run the documented migration on a disposable representative restored database and capture timing/locks before production scheduling.',
}

console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1
