/**
 * GET /api/assistant/internal/debug-tz — runtime timezone diagnostics.
 *
 * Added to root-cause the quiet-hours bug where the deployed hnd1 runtime
 * computed a Dhaka hour ahead of the real one (gate fired at ~21:52 Dhaka).
 * Reports what Intl actually resolves on this runtime alongside plain UTC
 * arithmetic so the two can be compared on production.
 * Auth: AGENT_INTERNAL_TOKEN only.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { dhakaHour, getQuietHoursConfig, isQuietHoursDhaka } from '@/agent/lib/quiet-hours'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const now = new Date()
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    hour12: false,
  })

  let quiet: unknown = null
  try {
    const config = await getQuietHoursConfig()
    quiet = { config, isQuietNow: isQuietHoursDhaka(now, config) }
  } catch (err) {
    quiet = { error: err instanceof Error ? err.message : String(err) }
  }

  return NextResponse.json({
    nowIso: now.toISOString(),
    epochMs: now.getTime(),
    dhakaHourCurrentImpl: dhakaHour(now),
    utcHour: now.getUTCHours(),
    utcArithmeticDhakaHour: (now.getUTCHours() + 6) % 24,
    formatToParts: fmt.formatToParts(now),
    fmtResolvedOptions: fmt.resolvedOptions(),
    defaultResolvedOptions: Intl.DateTimeFormat().resolvedOptions(),
    altEnUsH23: new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Dhaka',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(now),
    fullDhakaLocaleString: now.toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' }),
    supportedLocales: Intl.DateTimeFormat.supportedLocalesOf(['en-GB', 'en-US', 'bn']),
    envTZ: process.env.TZ ?? null,
    vercelRegion: process.env.VERCEL_REGION ?? null,
    nodeVersion: process.version,
    icuVersion: process.versions.icu ?? null,
    quiet,
  })
}
