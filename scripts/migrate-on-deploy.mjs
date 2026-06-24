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

// 3) Apply pending migrations over the direct connection. Prisma reads
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
