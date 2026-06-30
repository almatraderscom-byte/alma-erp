/**
 * POST /api/assistant/internal/salah-jamaat   { answer: 'jamaat' | 'alone', waqt?, date? }
 *
 * Internal (worker) twin of the in-app jamaat quick-reply. The Telegram bot calls
 * this when the owner taps the জামাতে / একা button under the prayer-confirm message,
 * so the answer is captured DETERMINISTICALLY — no head/LLM turn (a free-typed Bangla
 * reply on Telegram used to be picked up by the head and sometimes mis-handled).
 *
 * Internal-token auth only (same Bearer AGENT_INTERNAL_TOKEN as the other worker
 * endpoints). Returns the warm canned reply the bot shows back to the owner.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { recordJamaatChoiceDirect } from '@/agent/lib/salah-jamaat'

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

  let body: { answer?: unknown; waqt?: unknown; date?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 })
  }
  const answer = body.answer === 'jamaat' || body.answer === 'alone' ? body.answer : null
  if (!answer) return NextResponse.json({ error: 'invalid_answer' }, { status: 400 })

  const waqt = typeof body.waqt === 'string' ? body.waqt : null
  const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null

  const { reply } = await recordJamaatChoiceDirect(answer, new Date(), { waqt, date })
  return NextResponse.json({ ok: true, reply })
}
