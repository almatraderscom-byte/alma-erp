import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
const migration = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260921120000_creative_composition_foundation/migration.sql',
  ),
  'utf8',
)

describe('Creative composition schema and migration', () => {
  it('defines every additive Phase 1 model and optimistic/idempotency constraint', () => {
    for (const model of [
      'CreativeComposition',
      'CreativeCompositionVersion',
      'CreativeCompositionNode',
      'CreativeEditOperation',
      'CreativeOperationBatch',
      'CreativeRollbackPoint',
    ]) {
      expect(schema).toContain(`model ${model} {`)
    }
    expect(schema).toContain('@@unique([ownerId, creationIdempotencyKey])')
    expect(schema).toContain('@@unique([compositionId, idempotencyKey])')
    expect(schema).toContain('@@unique([compositionId, version])')
    expect(schema).toContain('concurrencyToken')
    expect(schema).toContain('requestFingerprint')
  })

  it('keeps provider-specific configuration out of the core relational schema', () => {
    const foundation = schema.slice(
      schema.indexOf('model CreativeComposition {'),
      schema.indexOf('// ─── Creative Studio Enterprise CSE7'),
    )
    expect(foundation).not.toMatch(
      /\b(provider|engine|modelName|modelVersion|seed|fal|fashn|xai|gemini|openai|seedream)\b/i,
    )
    expect(foundation).toContain('assetVersionId')
    expect(foundation).toContain('jobId')
  })

  it('creates all tables, foreign keys, and append-only database triggers', () => {
    for (const table of [
      'creative_compositions',
      'creative_composition_versions',
      'creative_composition_nodes',
      'creative_edit_operations',
      'creative_operation_batches',
      'creative_rollback_points',
    ]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`)
    }
    expect(migration).toContain(
      'creative_operation_batches_composition_id_idempotency_key_key',
    )
    expect(migration).toContain(
      'creative_composition_versions_composition_id_version_key',
    )
    expect(migration.match(/BEFORE UPDATE OR DELETE/g)).toHaveLength(5)
    expect(migration).toContain('creative composition history is append-only')
    expect(migration).toContain('ON DELETE RESTRICT')
  })

  it('does not alter or drop legacy Studio tables', () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE)\b/i)
    expect(migration).not.toMatch(/\bALTER TABLE "creative_(projects|project_assets|asset_versions)"/)
    expect(migration).not.toContain('creative_publish_deliveries" ADD')
  })
})
