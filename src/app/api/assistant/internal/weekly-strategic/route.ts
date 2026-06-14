/**
 * POST /api/assistant/internal/weekly-strategic
 * Strategic altitude + honest agent self-review for Friday weekly review / on-demand tool.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { buildWeeklyStrategicReview } from '@/lib/weekly-strategic-data'

export const runtime = 'nodejs'
export const maxDuration = 60

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

  try {
    const { message, data } = await buildWeeklyStrategicReview()
    return NextResponse.json({ message, period: data.period, generatedAt: new Date().toISOString() })
  } catch (err) {
    console.error('[weekly-strategic]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
