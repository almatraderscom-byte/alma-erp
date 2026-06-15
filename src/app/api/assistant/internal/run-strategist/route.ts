/**
 * POST /api/assistant/internal/run-strategist
 * Daily cross-domain strategy pass — owner-gated proposals only.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runDailyStrategist } from '@/lib/strategist-run'

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

  try {
    const result = await runDailyStrategist()
    return NextResponse.json(result)
  } catch (err) {
    console.error('[run-strategist]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
