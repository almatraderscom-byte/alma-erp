/**
 * POST /api/assistant/internal/marketing-plan-run
 * On-demand marketing plan card (mirrors run-strategist pattern for worker/tests).
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { createMarketingPlanCard } from '@/agent/lib/marketing/planner'

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

  let weeks = 2
  try {
    const body = await req.json().catch(() => ({}))
    if (body?.weeks != null) weeks = Number(body.weeks)
  } catch { /* default */ }

  try {
    const result = await createMarketingPlanCard({ weeks })
    return NextResponse.json(result)
  } catch (err) {
    console.error('[marketing-plan-run]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
