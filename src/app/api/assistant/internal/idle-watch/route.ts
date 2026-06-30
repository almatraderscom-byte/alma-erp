// Vercel cron entry for the staff idle-detection pilot. Fires every 5 minutes;
// the office-hours / lunch / prayer exclusions live inside runIdleWatch, so it is
// safe (and cheap — it early-exits) to call broadly. Authenticated with CRON_SECRET
// (same Bearer scheme as the ERP crons). Honors the AGENT_ENABLED kill switch.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runIdleWatch, runIdleWatchTest } from '@/agent/lib/idle-detection'
import { runAbsenceWatchTest } from '@/agent/lib/office-absence'

export const runtime = 'nodejs'
export const maxDuration = 60

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Optional override for manual testing of a specific camera.
  const deviceId = req.nextUrl.searchParams.get('deviceId') ?? undefined
  // ?test=1 → one-shot idle alert; ?test=absence → one-shot office-absence Card 1
  // (with live ✅/❌ buttons), both bypassing time windows / thresholds / episode
  // state. For verifying the full chain after setup.
  const testParam = req.nextUrl.searchParams.get('test')
  if (testParam === 'absence') {
    const result = await runAbsenceWatchTest(deviceId)
    return NextResponse.json({ ok: true, test: 'absence', ...result })
  }
  const isTest = testParam === '1'
  const result = isTest ? await runIdleWatchTest(deviceId) : await runIdleWatch(deviceId)
  return NextResponse.json({ ok: true, test: isTest, ...result })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
