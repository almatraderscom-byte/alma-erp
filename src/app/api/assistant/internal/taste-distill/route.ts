/**
 * POST /api/assistant/internal/taste-distill
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runTasteDistill } from '@/agent/lib/taste/distill'

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

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let days = 14
  try {
    const body = await req.json().catch(() => ({}))
    if (body?.days != null) days = Number(body.days)
  } catch { /* default */ }

  const result = await runTasteDistill({ days })
  return NextResponse.json(result)
}
