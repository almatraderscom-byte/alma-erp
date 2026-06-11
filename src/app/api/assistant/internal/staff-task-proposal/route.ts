/**
 * GET /api/assistant/internal/staff-task-proposal?date=YYYY-MM-DD
 * Builds proactive staff task proposal from ERP + FB data (worker + agent).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { buildStaffTaskProposal } from '@/agent/lib/staff-task-proposal'

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

  const date = req.nextUrl.searchParams.get('date') ?? undefined
  try {
    const result = await buildStaffTaskProposal(date)
    if (!result.success) return NextResponse.json(result, { status: 404 })
    return NextResponse.json(result)
  } catch (err) {
    console.error('[staff-task-proposal]', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
