/**
 * GET /api/assistant/internal/office-accounting?days=7
 * Recent office-miss reasons (owner-given), formatted Bangla section for the weekly review.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { buildMissReasonsSection, getRecentMissReasons } from '@/agent/lib/yesterday-accounting'

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
    const [formatted, reasons] = await Promise.all([
      buildMissReasonsSection(days),
      getRecentMissReasons(days),
    ])
    return NextResponse.json({ formatted, reasons, days })
  } catch (err) {
    console.error('[office-accounting]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
