#!/usr/bin/env node
/**
 * Auto-apply pending Prisma migrations during a Vercel deploy.
 *
 * Wired into the build (`prisma generate && node scripts/migrate-on-deploy.mjs
 * && next build`) so production never ships code that needs a DB column/table the
 * database doesn't have yet — the cause of the office-page outage.
 *
 * Safe by design:
 *  - Local builds (no VERCEL env) are skipped — never touches a DB from a laptop.
 *  - Migrations run over a DIRECT connection (DIRECT_URL), because the runtime
 *    DATABASE_URL is Supabase's transaction pooler (pgbouncer:6543) and Prisma
 *    `migrate deploy` can't run DDL reliably through it.
 *  - If DIRECT_URL isn't set yet, we WARN and skip instead of failing the deploy
 *    (graceful rollout: behaves exactly like today until the env var is added).
 *  - If a migration actually fails, the build fails — better a blocked deploy
 *    than a broken page.
 *
 * Migrations are additive-only (project rule), so applying them to the shared DB
 * from any Vercel build (preview or production) is safe for the live app.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const lifecycleRecoveryMarker = join(
  repoRoot,
  'docs/creative-studio-enterprise/LIFECYCLE_MIGRATION_RECOVERY_ONCE',
)

// 1) Only run inside Vercel's build — keep local `npm run build` DB-free.
if (!process.env.VERCEL) {
  console.log('[migrate-on-deploy] not on Vercel — skipping migrate deploy')
  process.exit(0)
}

// 2) Need a direct (non-pooler) connection for DDL. Skip gracefully if absent.
const directUrl = process.env.DIRECT_URL?.trim()
if (!directUrl) {
  console.warn(
    '[migrate-on-deploy] DIRECT_URL not set — skipping auto-migrate.\n' +
      '  Add DIRECT_URL (Supabase session pooler / direct, port 5432) in Vercel\n' +
      '  env to enable automatic migrations on deploy.',
  )
  process.exit(0)
}

// 3) One-time, branch-locked recovery for the audited failed lifecycle preview
// migration. The marker is removed immediately after the recovery deployment.
// It can never run on production or another branch.
if (existsSync(lifecycleRecoveryMarker)) {
  const isExactRecoveryPreview =
    process.env.VERCEL_ENV === 'preview'
    && process.env.VERCEL_GIT_COMMIT_REF === 'codex/cs-v3-lifecycle'
  if (!isExactRecoveryPreview) {
    console.error(
      '[migrate-on-deploy] lifecycle recovery marker is present outside its exact preview branch — refusing',
    )
    process.exit(1)
  }
  console.log(
    '[migrate-on-deploy] running audited one-time lifecycle failed-migration recovery…',
  )
  const recovery = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts/recover-creative-lifecycle-migration.mjs'), '--execute'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        LIFECYCLE_RECOVERY_DATABASE_URL: directUrl,
        LIFECYCLE_MIGRATION_RECOVERY_ACK:
          '20260921130000_creative_lifecycle_production:ROLLBACK_FAILED_RECORD',
      },
    },
  )
  if (recovery.status !== 0) {
    console.error(
      '[migrate-on-deploy] audited lifecycle recovery FAILED — normal migrations remain blocked',
    )
    process.exit(recovery.status ?? 1)
  }
  console.log('[migrate-on-deploy] audited lifecycle recovery completed ✓')
}

// 4) Apply pending migrations over the direct connection. Prisma reads
//    DATABASE_URL, so override just it for this command — schema.prisma is
//    untouched, avoiding any generate-time env requirement.
console.log('[migrate-on-deploy] applying pending migrations (prisma migrate deploy)…')
const r = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: directUrl },
})

if (r.status !== 0) {
  console.error('[migrate-on-deploy] migrate deploy FAILED — blocking the build')
  process.exit(r.status ?? 1)
}
console.log('[migrate-on-deploy] migrations up to date ✓')
