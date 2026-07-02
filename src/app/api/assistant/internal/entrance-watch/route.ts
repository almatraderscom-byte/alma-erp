// Vercel cron entry for the entrance watch (who came in / went out / stranger).
// Fires every minute; the enable flag, active window and entrance-device checks
// live inside runEntranceWatch so it early-exits cheaply when idle. Same
// CRON_SECRET Bearer scheme + AGENT_ENABLED kill switch as idle-watch.
import { type NextRequest, NextResponse } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runEntranceWatch, runEntranceWatchTest } from '@/agent/lib/entrance-watch'

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

  const deviceId = req.nextUrl.searchParams.get('deviceId') ?? undefined
  // ?test=1 → one-shot capture + identify + owner Telegram card, bypassing
  // window/cooldown/state — for verifying the chain after setup.
  if (req.nextUrl.searchParams.get('test') === '1') {
    const result = await runEntranceWatchTest(deviceId)
    return NextResponse.json({ ok: true, test: true, ...result })
  }
  const result = await runEntranceWatch(deviceId)
  return NextResponse.json({ ok: true, ...result })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
