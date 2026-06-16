/**
 * POST /api/assistant/internal/day-shift
 * VPS worker — start or tick the autonomous day shift.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { startDayShift, tickDayShift } from '@/agent/lib/day-shift'

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
    if (body.action === 'start' || body.action === 'tick') action = body.action
  } catch {
    /* default tick */
  }

  try {
    const result = action === 'start' ? await startDayShift() : await tickDayShift()
    return NextResponse.json(result)
  } catch (err) {
    console.error('[internal/day-shift]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
