/**
 * GET /api/assistant/internal/financial-health?days=30
 * CFO-lite snapshot for weekly review and worker jobs.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { analyzeFinancials, formatFinancialBrief } from '@/lib/financial-intelligence'

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

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  if (!checkToken(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const days = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get('days') ?? '30', 10) || 30, 7), 90)

  try {
    const health = await analyzeFinancials({ days })
    const text = formatFinancialBrief(health)
    return NextResponse.json({ health, text, days })
  } catch (err) {
    console.error('[financial-health]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
