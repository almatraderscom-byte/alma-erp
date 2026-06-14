/**
 * POST /api/assistant/internal/morale-message
 * Generates a fresh personalized staff morale message (worker scheduler, adaptive days).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { composeStaffMoraleMessage } from '@/agent/lib/morale-message'

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

  let staffName = ''
  let recentContext = ''
  try {
    const body = await req.json().catch(() => ({}))
    staffName = typeof body?.staffName === 'string' ? body.staffName.trim() : ''
    recentContext = typeof body?.recentContext === 'string' ? body.recentContext.trim() : ''
  } catch {
    // defaults empty
  }

  if (!staffName) {
    return NextResponse.json({ error: 'staffName required' }, { status: 400 })
  }

  try {
    const message = await composeStaffMoraleMessage(staffName, recentContext)
    if (!message) {
      return NextResponse.json({ error: 'Failed to compose message' }, { status: 500 })
    }
    return NextResponse.json({ message })
  } catch (err) {
    console.error('[morale-message] failed:', err)
    return NextResponse.json({ error: 'Failed to compose message' }, { status: 500 })
  }
}
