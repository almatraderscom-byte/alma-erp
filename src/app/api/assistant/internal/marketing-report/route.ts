/**
 * GET /api/assistant/internal/marketing-report
 * Weekly funnel report — worker scheduler + diagnostics.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { buildMarketingReportText } from '@/agent/lib/marketing/report'

export const runtime = 'nodejs'
export const maxDuration = 120

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

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const days = Math.min(Number(req.nextUrl.searchParams.get('days') ?? 7), 30)
  const { report, data, recommendations } = await buildMarketingReportText(days)
  return Response.json({ report, data, recommendations, periodDays: days })
}
