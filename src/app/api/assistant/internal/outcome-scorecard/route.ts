/**
 * GET /api/assistant/internal/outcome-scorecard?days=7
 * Honest weekly scorecard of agent suggestion outcomes.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { buildOutcomeScorecard } from '@/lib/outcome-measure'

export const runtime = 'nodejs'

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
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!checkToken(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const days = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('days') ?? '7', 10) || 7, 1), 30)

  try {
    const text = await buildOutcomeScorecard(days)
    return NextResponse.json({ text, days })
  } catch (err) {
    console.error('[outcome-scorecard]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
