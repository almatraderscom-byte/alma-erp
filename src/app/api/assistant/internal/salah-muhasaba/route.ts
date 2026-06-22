/**
 * POST /api/assistant/internal/salah-muhasaba
 * Nightly salah muhasaba (worker scheduler @ ~22:30 Dhaka).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runMuhasabaSend } from '@/agent/lib/salah-muhasaba'

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

  try {
    const result = await runMuhasabaSend()
    return NextResponse.json(result)
  } catch (err) {
    console.error('[salah-muhasaba] failed:', err)
    return NextResponse.json({ error: 'Failed to send muhasaba' }, { status: 500 })
  }
}
