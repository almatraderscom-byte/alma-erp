import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const scriptPath = join(root, 'scripts/recover-creative-lifecycle-migration.mjs')
const script = readFileSync(scriptPath, 'utf8')
const packageJson = readFileSync(join(root, 'package.json'), 'utf8')
const runbook = readFileSync(
  join(
    root,
    'docs/creative-studio-enterprise/v3-lifecycle-failed-migration-recovery.md',
  ),
  'utf8',
)

describe('Creative Studio lifecycle failed-migration recovery', () => {
  it('cannot connect without an explicit mode and dedicated URL', () => {
    const noMode = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      env: { NODE_ENV: 'test' },
      encoding: 'utf8',
    })
    expect(noMode.status).toBe(1)
    expect(noMode.stderr).toContain('explicitly choose exactly one mode')

    const noUrl = spawnSync(process.execPath, [scriptPath, '--plan'], {
      cwd: root,
      env: { NODE_ENV: 'test' },
      encoding: 'utf8',
    })
    expect(noUrl.status).toBe(1)
    expect(noUrl.stderr).toContain('LIFECYCLE_RECOVERY_DATABASE_URL is required')
  })

  it('allows the proven 5432 session pooler but rejects transaction-pooler semantics offline', () => {
    const validate = (databaseUrl: string) => spawnSync(
      process.execPath,
      [scriptPath, '--validate-connection-url'],
      {
        cwd: root,
        env: {
          NODE_ENV: 'test',
          LIFECYCLE_RECOVERY_DATABASE_URL: databaseUrl,
        },
        encoding: 'utf8',
      },
    )
    const session = validate(
      'postgresql://operator:super-secret@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres',
    )
    expect(session.status).toBe(0)
    expect(session.stdout).toContain(
      'postgresql://aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres',
    )
    expect(session.stdout).not.toContain('operator')
    expect(session.stdout).not.toContain('super-secret')
    expect(session.stdout).toContain('"networkAccess": false')

    for (const transactionUrl of [
      'postgresql://operator:secret@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres',
      'postgresql://operator:secret@db.example.com:5432/postgres?pgbouncer=true',
      'postgresql://operator:secret@db.example.com:5432/postgres?pool_mode=transaction',
      'postgresql://operator:secret@db.example.com:5432/postgres?proxy_mode=transaction',
    ]) {
      const rejected = validate(transactionUrl)
      expect(rejected.status).toBe(1)
      expect(rejected.stderr).toContain('transaction-pooler semantics are rejected')
      expect(rejected.stderr).not.toContain('secret')
    }
  })

  it('requires the exact failed migration and PostgreSQL error proof', () => {
    expect(script).toContain("'20260921130000_creative_lifecycle_production'")
    expect(script).toContain("'creative_lifecycle_feature_flags_exact_scope_key'")
    expect(script).toContain("logs.includes('42P17')")
    expect(script).toContain(
      "logs.includes('functions in index expression must be marked IMMUTABLE')",
    )
    expect(script).toContain('expected exactly one')
    expect(script).toContain('row.finished_at !== null || row.rolled_back_at !== null')
    expect(script).toContain("'fully_rolled_back'")
    expect(script).toContain("'exact_partial_prefix'")
    expect(script).toContain(
      'failed lifecycle schema is neither fully rolled back nor the exact audited partial prefix',
    )
  })

  it('proves empty/default-off state and aborts past the known failed prefix', () => {
    for (const table of [
      'creative_lifecycle_jobs',
      'creative_lifecycle_receipts',
      'creative_lifecycle_audit_events',
      'creative_lifecycle_feature_flags',
      'creative_lifecycle_flag_audit_events',
      'creative_archive_verification_attempts',
    ]) {
      expect(script).toContain(`'${table}'`)
    }
    expect(script).toContain("paid_execution_allowed: 'false'")
    expect(script).toContain("enabled: 'false'")
    expect(script).toContain("dual_read_enabled: 'false'")
    expect(script).toContain("canary_percent: '0'")
    expect(script).toContain('state.postFailureObjects.length')
    expect(script).toContain('nonDefaultRows !== 0')
    expect(script).toContain("'guarded_schema_cleanup_and_prisma_migration_metadata_update'")
    expect(script).toContain('businessRowMutation: false')
    expect(script).not.toContain('productionDataMutation: false')
  })

  it('uses a transactional restrictive whitelist and never drops Foundation objects', () => {
    expect(script).toContain('TransactionIsolationLevel.Serializable')
    expect(script).toContain('pg_advisory_xact_lock')
    expect(script).toContain('await tx.$executeRawUnsafe(')
    expect(script).toContain('DROP TABLE IF EXISTS ${quoteIdentifier(table)} RESTRICT')
    expect(script).toContain('DROP COLUMN IF EXISTS ${quoteIdentifier(column)} RESTRICT')
    expect(script).toContain('DROP TYPE IF EXISTS ${quoteIdentifier(type)} RESTRICT')
    expect(script).not.toContain('CASCADE')
    expect(script).not.toMatch(/DROP (?:TABLE|COLUMN).*creative_composition/i)
    expect(script).not.toMatch(/DROP (?:TABLE|COLUMN).*creative_operation_batch/i)
  })

  it('resolves only after cleanup and never performs migrate deploy', () => {
    expect(script.indexOf('await removeKnownPartialPrefix(tx)')).toBeLessThan(
      script.indexOf('await resolveRolledBack(databaseUrl)'),
    )
    expect(script).toContain("'--rolled-back'")
    expect(script).toContain('await verifyRolledBack(verifier)')
    expect(script).not.toMatch(/['"]deploy['"]/)
    expect(packageJson).not.toContain('recover-creative-lifecycle-migration.mjs')
    expect(runbook).toContain('does **not** run')
    expect(runbook).toContain('do not edit')
  })
})
