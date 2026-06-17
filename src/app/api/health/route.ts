import { NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'
import { prisma } from '@/lib/prisma'
import { validateEnv } from '@/lib/env'
import { storageReadiness } from '@/lib/supabase-storage'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  const timestamp = new Date().toISOString()
  const gitCommit =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT ||
    null

  const { getBuildInfo } = await import('@/lib/runtime-build')
  const build = getBuildInfo()

  let gasPayload: Record<string, unknown> | null = null
  let gasError: string | null = null
  let dbOk = false
  let dbError: string | null = null
  let walletOk = false
  let notificationOk = false
  let cronConfigured = false
  try {
    gasPayload = (await serverGet<Record<string, unknown>>('api_health', {}, 0)) as Record<string, unknown>
  } catch (e) {
    gasError = e instanceof Error ? e.message : 'GAS health failed'
  }
  try {
    await prisma.$queryRaw`SELECT 1`
    dbOk = true
    await prisma.employeeLedgerEntry.count()
    walletOk = true
    await prisma.notification.count()
    notificationOk = true
    cronConfigured = Boolean(process.env.CRON_SECRET?.trim())
  } catch (e) {
    dbError = e instanceof Error ? e.message : 'Database health failed'
  }

  const gasOk =
    !gasError &&
    gasPayload &&
    gasPayload.ok !== false &&
    !gasPayload.error
  const storage = storageReadiness()

  return NextResponse.json(
    {
      ok: Boolean(gasOk && dbOk),
      timestamp,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
      env: validateEnv(),
      database: {
        ok: dbOk,
        error: dbError ? 'Database check failed' : null,
        wallet_ledger_ok: walletOk,
      },
      cron: { configured: cronConfigured },
      notifications: {
        database_ok: notificationOk,
        resend_configured: Boolean(process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim()),
        push_configured: Boolean(process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID?.trim() && process.env.ONESIGNAL_REST_API_KEY?.trim()),
      },
      storage: {
        expense_receipts_configured: storage.configured,
        expense_receipts_bucket: storage.bucket,
        private_signed_access: true,
      },
      frontend: {
        git_commit: gitCommit,
        commit_short: build.commitShort,
        message: build.message,
        branch: build.branch,
        build_info_url: '/api/build-info',
      },
      api: { gas_configured: Boolean(process.env.NEXT_PUBLIC_API_URL?.trim()) },
      /** Optional — set in Vercel to match clasp deploy "@NN" line after each deploy */
      gas_clasp_version: process.env.GAS_CLASP_VERSION?.trim() || null,
      gas: gasError
        ? { ok: false, error: 'GAS health check failed' }
        : { ok: Boolean(gasPayload?.ok), route: gasPayload?.route ?? 'api_health', gas_release_stamp: gasPayload?.gas_release_stamp ?? null },
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
