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
 *  - A production deploy without DIRECT_URL fails closed. Shipping code before
 *    its additive schema is how approval/action queues disappear at runtime.
 *    Preview builds may still compile without a direct production credential.
 *  - If a migration actually fails, the build fails — better a blocked deploy
 *    than a broken page.
 *
 * Migrations are additive-only (project rule), so applying them to the shared DB
 * from any Vercel build (preview or production) is safe for the live app.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

// 1) Only run inside Vercel's build — keep local `npm run build` DB-free.
if (!process.env.VERCEL) {
  console.log('[migrate-on-deploy] not on Vercel — skipping migrate deploy')
  process.exit(0)
}

// 1b) The demo instance is not on this migration chain. The chain cannot build a
//     database from empty — its first migration adds a foreign key to "User" and no
//     migration in the repo creates that table — so the demo's schema comes from
//     `prisma db push` (once by hand, then nightly in demo-reset.yml). Running
//     `migrate deploy` there fails on migration 1 and would block every demo deploy.
//     See docs/DEMO_INSTANCE.md.
if (process.env.DEMO_MODE === 'true') {
  // A deployment that starts reading a new model would otherwise serve it against
  // last night's schema until the 02:00 reset caught up, so push here too — but only
  // over a session-mode connection. The demo's own DATABASE_URL is the transaction
  // pooler (pgbouncer), which cannot carry DDL; set DEMO_DIRECT_URL (port 5432) to
  // enable this. Without it the build continues and the nightly reset stays the only
  // sync — said loudly rather than silently.
  const demoDirect = process.env.DEMO_DIRECT_URL?.trim()
  if (!demoDirect) {
    console.warn(
      '[migrate-on-deploy] DEMO_MODE without DEMO_DIRECT_URL — schema sync deferred to the '
      + 'nightly reset. Set DEMO_DIRECT_URL (session pooler, port 5432) to sync on deploy.',
    )
    process.exit(0)
  }

  const guard = spawnSync('node', ['scripts/demo-assert-target.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: demoDirect },
  })
  if (guard.status !== 0) {
    console.error('[migrate-on-deploy] demo target check FAILED — refusing to touch that database')
    process.exit(guard.status ?? 1)
  }

  console.log('[migrate-on-deploy] DEMO_MODE — syncing schema with prisma db push…')
  const push = spawnSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: demoDirect },
  })
  process.exit(push.status ?? 1)
}

// 2) Need a direct (non-pooler) connection for DDL. Production must never ship
//    past this point without it; previews remain DB-free when the secret is not
//    intentionally exposed to that environment.
const directUrl = process.env.DIRECT_URL?.trim()
if (!directUrl) {
  const environment = process.env.VERCEL_ENV?.trim().toLowerCase()
  const detail =
    '[migrate-on-deploy] DIRECT_URL not set. Add the Supabase direct/session-pooler ' +
    'connection (port 5432) to the Vercel environment before deploying schema-dependent code.'
  if (environment === 'production') {
    console.error(`${detail}\n[migrate-on-deploy] refusing production deploy`)
    process.exit(1)
  }
  console.warn(`${detail}\n[migrate-on-deploy] non-production build — migration skipped`)
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

// 4) Fail closed on the exact additive contract this release reads. Prisma can
// report migrations applied while a manually repaired/partially restored
// database is still missing columns or the service-role receipt RPC; compiling
// that deployment would make the approval queue disappear or strand renders.
const smoke = new PrismaClient({ datasources: { db: { url: directUrl } } })
try {
  const [row] = await smoke.$queryRawUnsafe(`
    SELECT
      COUNT(*) FILTER (
        WHERE column_name = ANY (ARRAY[
          'image_model',
          'image_quote',
          'approval_claimed_at',
          'job_result_pending',
          'job_result_envelope',
          'job_result_claimed_at'
        ])
      )::int AS "columnCount",
      to_regprocedure(
        'public.record_agent_image_terminal_receipt(text,jsonb)'
      ) IS NOT NULL AS "receiptRpcPresent"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_pending_actions'
  `)
  if (Number(row?.columnCount) !== 6 || row?.receiptRpcPresent !== true) {
    throw new Error(
      `image action schema smoke failed (columns=${String(row?.columnCount)}, ` +
      `receiptRpc=${String(row?.receiptRpcPresent)})`,
    )
  }
  // Execute the RPC against a transaction-local probe row. This catches SQL
  // signature/operator mistakes (the action ID column is TEXT, even though
  // values are UUID-shaped) that an information_schema presence check cannot.
  const probeId = `schema-smoke-${randomUUID()}`
  const probeEnvelope = {
    version: 1,
    status: 'failed',
    error: 'schema_smoke_no_provider_call',
    receiptId: `schema-smoke-receipt-${randomUUID()}`,
    recordedAt: new Date().toISOString(),
  }
  await smoke.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO agent_pending_actions
        (id, type, payload, summary, status, "createdAt", job_result_pending)
       VALUES ($1, 'image_gen', '{}'::jsonb, 'image action schema smoke',
         'approved', CURRENT_TIMESTAMP, false)`,
      probeId,
    )
    const [receipt] = await tx.$queryRawUnsafe(
      `SELECT job_result_envelope AS "jobResultEnvelope"
         FROM record_agent_image_terminal_receipt($1::text, $2::jsonb)`,
      probeId,
      JSON.stringify(probeEnvelope),
    )
    if (receipt?.jobResultEnvelope?.receiptId !== probeEnvelope.receiptId) {
      throw new Error('image terminal receipt RPC execution smoke failed')
    }
    await tx.$executeRawUnsafe('DELETE FROM agent_pending_actions WHERE id = $1', probeId)
  })
  console.log('[migrate-on-deploy] image action schema smoke ✓')
} catch (error) {
  console.error('[migrate-on-deploy] post-migration schema smoke FAILED — blocking the build')
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await smoke.$disconnect()
}
