import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260921130000_creative_lifecycle_production/migration.sql',
  ),
  'utf8',
)
const heldValidationScript = readFileSync(
  join(
    process.cwd(),
    'docs/creative-studio-enterprise/sql/creative-lifecycle-validate-existing.sql',
  ),
  'utf8',
)

describe('Creative Studio V3 lifecycle production schema', () => {
  it('keeps every executable Prisma migration compatible with transaction-wrapped deploy', () => {
    const root = join(process.cwd(), 'prisma/migrations')
    const migrationSql = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readFileSync(join(root, entry.name, 'migration.sql'), 'utf8'))
      .join('\n')
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(migrationSql).not.toMatch(
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i,
    )
  })

  it('wraps the automatic lifecycle migration explicitly and holds operational DDL outside it', () => {
    expect(migration.indexOf('BEGIN;')).toBeLessThan(migration.indexOf('CREATE TYPE'))
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).not.toContain('CREATE INDEX CONCURRENTLY')
    expect(heldValidationScript).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS')
  })

  it('enforces null-aware exact feature-flag scopes without index expressions or enum casts', () => {
    const scopeIndexBlock = migration.slice(
      migration.indexOf(
        'CREATE UNIQUE INDEX "creative_lifecycle_feature_flags_exact_scope_key"',
      ),
      migration.indexOf(
        'creative_lifecycle_flag_audit_events_owner_id_idempotency_key_key',
      ),
    )
    expect(
      scopeIndexBlock.match(
        /CREATE UNIQUE INDEX "creative_lifecycle_feature_flags_exact_scope(?:_[a-z]+)*_key"/g,
      ),
    ).toHaveLength(6)
    expect(scopeIndexBlock).not.toMatch(/\bCOALESCE\s*\(/i)
    expect(scopeIndexBlock).not.toContain('::text')
    expect(scopeIndexBlock).not.toContain('NULLS NOT DISTINCT')
    expect(scopeIndexBlock.match(/\bWHERE\b/g)).toHaveLength(6)
    for (const statement of scopeIndexBlock.match(/CREATE UNIQUE INDEX[\s\S]*?;/g) ?? []) {
      const keys = statement.match(/\bON\s+"[^"]+"\s*\(([^)]*)\)/)?.[1] ?? ''
      expect(keys).toMatch(/^"[^"]+"(?:\s*,\s*"[^"]+")*$/)
    }
  })

  it('defines durable job, receipt, audit and scoped rollout models', () => {
    for (const model of [
      'CreativeLifecycleJob',
      'CreativeLifecycleReceipt',
      'CreativeLifecycleAuditEvent',
      'CreativeLifecycleFeatureFlag',
      'CreativeLifecycleFlagAuditEvent',
    ]) {
      expect(schema).toContain(`model ${model} {`)
    }
    expect(schema).toContain('@@unique([ownerId, idempotencyKey])')
    expect(schema).toContain('@@unique([ownerId, renderFingerprint])')
    expect(schema).toContain(
      'fields: [compositionVersionId, compositionId, compositionVersion, compositionDocumentHash]',
    )
  })

  it('uses restrictive relational joins for composition/version/batch and server identities', () => {
    for (const constraint of [
      'creative_lifecycle_jobs_composition_scope_fkey',
      'creative_lifecycle_jobs_exact_composition_version_fkey',
      'creative_lifecycle_jobs_operation_batch_fkey',
      'creative_lifecycle_jobs_owner_id_fkey',
      'creative_lifecycle_jobs_brand_scope_fkey',
      'creative_lifecycle_jobs_project_scope_fkey',
      'creative_lifecycle_jobs_created_by_id_fkey',
      'creative_lifecycle_jobs_result_artifact_version_id_fkey',
      'creative_compositions_brand_scope_fkey',
      'creative_compositions_project_scope_fkey',
      'creative_asset_review_events_exact_composition_version_fkey',
      'creative_publish_deliveries_exact_composition_version_fkey',
      'creative_performance_snapshots_exact_composition_version_fkey',
      'creative_archive_receipts_exact_composition_version_fkey',
    ]) {
      expect(migration).toContain(`"${constraint}"`)
    }
    expect(migration).toContain('ON DELETE RESTRICT')
    expect(migration).toContain(
      'creative_composition_versions_exact_identity_key',
    )
    expect(migration).toContain('creative_operation_batches_exact_result_key')
    expect(migration).toContain('creative_lifecycle_feature_flags_exact_scope_key')
    expect(migration).toContain('creative_lifecycle_feature_flags_project_scope_fkey')
    expect(migration).toContain('creative_lifecycle_flag_audit_events_owner_id_fkey')
  })

  it('guards duplicate execution and invalid lifecycle states in the database', () => {
    expect(migration).toContain(
      'creative_lifecycle_jobs_owner_id_render_fingerprint_key',
    )
    for (const check of [
      'creative_lifecycle_jobs_progress_check',
      'creative_lifecycle_jobs_ready_artifact_check',
      'creative_lifecycle_jobs_source_evidence_check',
      'creative_lifecycle_receipts_ready_artifact_check',
      'creative_lifecycle_feature_flags_canary_check',
      'creative_asset_review_events_composition_pin_check',
      'creative_archive_receipts_composition_pin_check',
    ]) {
      expect(migration).toContain(`"${check}"`)
    }
    expect(migration).toContain('"canary_percent" BETWEEN 0 AND 100')
    expect(migration).toContain(`"status" <> 'READY'`)
    expect(migration).toContain('"result_artifact_version_id" IS NOT NULL')
    expect(migration).toContain('"artifact_version_id" IS NOT NULL')
    expect(migration).toContain('creative_lifecycle_ready_receipt_validate')
    expect(migration).toContain('lifecycle READY artifact lineage mismatch')
    expect(migration).toContain('creative_lifecycle_receipts_single_ready_job_key')
    expect(migration).toContain('creative_lifecycle_ready_evidence_consistency')
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED')
  })

  it('keeps receipt and audit evidence append-only while the leased job remains mutable', () => {
    expect(migration).toContain('creative_lifecycle_receipts_append_only')
    expect(migration).toContain('creative_lifecycle_audit_events_append_only')
    expect(migration).toContain('creative_lifecycle_flag_audit_events_append_only')
    expect(migration).toContain('creative_archive_verification_attempts_append_only')
    expect(migration).toContain('creative_lifecycle_ready_job_immutable')
    expect(migration).toContain('creative_lifecycle_result_artifact_immutable')
    expect(migration).toContain('creative lifecycle execution pins are immutable')
    const triggerStart = migration.indexOf('BEFORE INSERT OR UPDATE OF')
    const triggerEnd = migration.indexOf('ON "creative_lifecycle_jobs"', triggerStart)
    const triggerColumns = migration.slice(triggerStart, triggerEnd)
    for (const column of [
      '"source_storage_path"',
      '"source_checksum"',
      '"source_bytes"',
    ]) {
      expect(triggerColumns).toContain(column)
    }
  })

  it('is additive and preserves nullable legacy fallback rows', () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE)\b/i)
    expect(migration).toContain('Existing CSE6/CSE7 rows intentionally remain NULL')
    expect(migration).toContain('legacy fallback')
  })

  it('stages populated-table constraints as NOT VALID and holds validation outside deploy migrations', () => {
    for (const table of [
      'creative_asset_review_events',
      'creative_publish_deliveries',
      'creative_performance_snapshots',
      'creative_archive_receipts',
    ]) {
      expect(migration).toContain(`ALTER TABLE "${table}"`)
      expect(heldValidationScript).toContain(`ALTER TABLE "${table}"`)
    }
    expect(migration.match(/NOT VALID/g)?.length).toBeGreaterThanOrEqual(17)
    expect(heldValidationScript.match(/VALIDATE CONSTRAINT/g)?.length).toBeGreaterThanOrEqual(19)
    expect(heldValidationScript).toContain('deliberately outside prisma/migrations')
    expect(migration).not.toMatch(
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i,
    )
    expect(heldValidationScript).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS')
  })
})
