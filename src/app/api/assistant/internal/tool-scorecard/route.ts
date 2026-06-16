/**
 * POST /api/assistant/internal/tool-scorecard — weekly tool telemetry digest.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { aggregateToolEvents } from '@/agent/lib/tool-telemetry'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function POST(req: NextRequest) {
  const err = requireAgentEnabled()
  if (err) return err

  const token = req.headers.get('authorization')?.replace('Bearer ', '') ?? ''
  if (!verifyToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const days = Number(body.days) || 7
    const now = new Date()
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

    const scorecard = await aggregateToolEvents(start, now)

    return NextResponse.json({ ok: true, ...scorecard })
  } catch (err) {
    console.error('[tool-scorecard] error:', err)
    return NextResponse.json(
      { error: String(err instanceof Error ? err.message : err) },
      { status: 500 },
    )
  }
}
