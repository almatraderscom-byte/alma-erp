/**
 * POST /api/assistant/internal/personal-checkin
 * Composes a warm evening personal check-in for the owner (worker scheduler).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { composePersonalCheckin } from '@/agent/lib/personal-checkin'

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

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let kind: 'evening' = 'evening'
  try {
    const body = await req.json().catch(() => ({}))
    if (body?.kind === 'evening') kind = 'evening'
  } catch {
    // default evening
  }

  try {
    const message = await composePersonalCheckin(kind)
    return NextResponse.json({ message })
  } catch (err) {
    console.error('[personal-checkin] failed:', err)
    return NextResponse.json({ error: 'Failed to compose check-in' }, { status: 500 })
  }
}
