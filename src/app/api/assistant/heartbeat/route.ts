/**
 * GET /api/assistant/heartbeat — the owner-facing heartbeat feed (read-only).
 *
 * Powers the /agent UI Heartbeat panel: current settings + today's head-wake count
 * + the recent tick timeline (idle and active alike), so the owner can watch the
 * autonomous heartbeat the way they'd watch a scheduled wake-up fire.
 *
 * Owner-only (NextAuth session). Honors the AGENT_ENABLED kill switch.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getHeartbeatSettings, setHeartbeatSettings } from '@/agent/lib/heartbeat/heartbeat-settings'
import { listHeartbeats, headWakesToday } from '@/agent/lib/heartbeat/heartbeat-log'
import { runHeartbeatTick } from '@/agent/lib/heartbeat/brain'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit')) || 30, 1), 60)
  const [settings, entries, wakesToday] = await Promise.all([
    getHeartbeatSettings(),
    listHeartbeats(limit),
    headWakesToday(),
  ])

  return Response.json({ settings, wakesToday, entries, count: entries.length })
}

/**
 * POST /api/assistant/heartbeat — owner control from the UI panel.
 * Body: { action: 'enable' | 'disable' | 'set_cap' | 'test_now', dailyHeadWakeCap?: number }
 * Returns the same shape as GET (refreshed settings + feed) so the panel re-renders.
 */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { action?: string; dailyHeadWakeCap?: number }
  try {
    body = (await req.json()) as { action?: string; dailyHeadWakeCap?: number }
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const action = body.action ?? ''
  let testResult: Awaited<ReturnType<typeof runHeartbeatTick>> | null = null

  if (action === 'enable' || action === 'disable') {
    // Manual on = on + self-managing; manual off = a real stop (clear autoArm too,
    // so the agent won't immediately re-arm itself against the owner's explicit off).
    await setHeartbeatSettings({ enabled: action === 'enable', autoArm: action === 'enable' })
  } else if (action === 'set_cap') {
    if (typeof body.dailyHeadWakeCap !== 'number') {
      return Response.json({ error: 'dailyHeadWakeCap_required' }, { status: 400 })
    }
    await setHeartbeatSettings({ dailyHeadWakeCap: body.dailyHeadWakeCap })
  } else if (action === 'test_now') {
    // Forced tick: skips the enabled / office-hours / change / cap gates.
    testResult = await runHeartbeatTick({ force: true })
  } else if (action === 'tick_now') {
    // Natural tick: exactly what the cron runs (no force). Exercises self-arming —
    // if the heartbeat is resting (off + autoArm) and work is pending, it arms itself.
    testResult = await runHeartbeatTick({ force: false })
  } else {
    return Response.json({ error: 'unknown_action' }, { status: 400 })
  }

  const [settings, entries, wakesToday] = await Promise.all([
    getHeartbeatSettings(),
    listHeartbeats(30),
    headWakesToday(),
  ])
  return Response.json({ settings, wakesToday, entries, count: entries.length, testResult })
}
