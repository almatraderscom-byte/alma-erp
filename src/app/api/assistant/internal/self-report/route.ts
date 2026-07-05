/**
 * POST /api/assistant/internal/self-report — P5 weekly agent QA digest.
 * Worker cron (weekly-self-report) fetches this and pushes the Bangla digest
 * to the owner. Internal-token auth, same pattern as tool-scorecard.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { buildWeeklySelfReport } from '@/agent/lib/self-report'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const gate = requireAgentEnabled()
  if (gate) return gate

  const token = req.headers.get('authorization')?.replace('Bearer ', '') ?? ''
  if (!verifyToken(token)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const days = Math.min(Math.max(Number(body.days) || 7, 1), 31)
    const report = await buildWeeklySelfReport(days)
    return NextResponse.json(report)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
