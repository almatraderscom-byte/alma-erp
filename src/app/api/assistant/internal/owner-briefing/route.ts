/**
 * GET /api/assistant/internal/owner-briefing
 * Structured owner morning briefing data for the VPS worker scheduler.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { buildOwnerBriefingData } from '@/agent/lib/owner-briefing-data'

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
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const brief = await buildOwnerBriefingData()
    return NextResponse.json(brief)
  } catch (err) {
    console.error('[owner-briefing] internal API failed:', err)
    return NextResponse.json({ error: 'Failed to build briefing' }, { status: 500 })
  }
}
