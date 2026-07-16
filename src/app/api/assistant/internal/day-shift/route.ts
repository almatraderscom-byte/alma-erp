/**
 * POST /api/assistant/internal/day-shift
 * VPS worker — start or tick the autonomous day shift.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { startDayShift, tickDayShift, sendMorningShiftBrief } from '@/agent/lib/day-shift'

export const runtime = 'nodejs'
export const maxDuration = 120

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

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!checkToken(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let action = 'tick'
  try {
    const body = await req.json() as { action?: string }
    if (body.action === 'start' || body.action === 'tick' || body.action === 'morning_brief') {
      action = body.action
    } else if (body.action) {
      console.warn(`[internal/day-shift] unknown action: ${body.action}, defaulting to tick`)
    }
  } catch (parseErr) {
    console.warn('[internal/day-shift] malformed request body, defaulting to tick:', parseErr instanceof Error ? parseErr.message : String(parseErr))
  }

  try {
    const result =
      action === 'start' ? await startDayShift()
      : action === 'morning_brief' ? await sendMorningShiftBrief()
      : await tickDayShift()
    // LG-9 slice 2: every day-shift decision lands on the day's duty thread
    // (fail-open inside) — one call site covers start/tick/morning-brief.
    const { mirrorDutyTick } = await import('@/agent/lib/graph/duty-run-graph')
    const { todayYmdDhaka } = await import('@/lib/agent-api/dhaka-date')
    const r = result as { ok?: boolean; detail?: string; conversationId?: string }
    await mirrorDutyTick('day_shift', todayYmdDhaka(), {
      decision: `${action}:${r.detail ?? 'ok'}`.slice(0, 80),
      outcome: r.ok === false ? 'error' : 'active',
      summary: r.detail ?? null,
      costUsd: 0,
      conversationId: r.conversationId ?? null,
    })
    return NextResponse.json(result)
  } catch (err) {
    console.error('[internal/day-shift]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
