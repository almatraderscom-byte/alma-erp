/**
 * Controlled-error endpoint for verifying Sentry plumbing in production.
 *
 *   GET  ?mode=event       → capture a tagged info-level event (no exception)
 *   GET  ?mode=warn        → capture a warning event
 *   GET  ?mode=throw       → throw, exercise withApiRoute capture path
 *   GET  ?mode=replay      → log a replay-trigger error visible in Session Replay
 *
 * Auth: SUPER_ADMIN only (via getWalletContext) OR Bearer ${CRON_SECRET}.
 * The endpoint NEVER returns PII; the response only echoes the event id and
 * normalized tags so an operator can locate the trace in Sentry.
 */
import { NextRequest, NextResponse } from 'next/server'
import { withApiRoute } from '@/lib/core/safe-api'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { captureStructuredEvent } from '@/lib/sentry/capture'
import { logEvent } from '@/lib/logger'

function authorizedViaCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET || ''
  if (!secret) return false
  const header = req.headers.get('authorization') || ''
  return header === `Bearer ${secret}`
}

export const GET = withApiRoute('debug.sentry_test', async (req: NextRequest) => {
  if (!authorizedViaCron(req)) {
    const ctx = await getWalletContext(req)
    if ('error' in ctx) return ctx.error
    if (ctx.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const url = new URL(req.url)
  const mode = (url.searchParams.get('mode') || 'event').toLowerCase()
  const requestId = req.headers.get('x-request-id') || `dbg-${Date.now()}`

  if (mode === 'throw') {
    logEvent('error', 'debug.sentry_test.thrown', {
      requestId,
      route: 'debug.sentry_test',
      probe: 'thrown',
    })
    throw new Error(`Sentry verification throw (rid=${requestId})`)
  }

  if (mode === 'replay') {
    await captureStructuredEvent('error', 'debug.sentry_test.replay', {
      requestId,
      route: 'debug.sentry_test',
      probe: 'replay',
      hint: 'Triggered from /api/debug/sentry-test?mode=replay',
    })
    return NextResponse.json({
      ok: true,
      mode,
      requestId,
      message: 'Replay-trigger error captured. Open Sentry → search request.id tag.',
    })
  }

  if (mode === 'warn') {
    logEvent('warn', 'debug.sentry_test.warn', { requestId, route: 'debug.sentry_test' })
    return NextResponse.json({ ok: true, mode, requestId })
  }

  logEvent('info', 'debug.sentry_test.info', { requestId, route: 'debug.sentry_test' })
  return NextResponse.json({ ok: true, mode, requestId })
})
