import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { applySalahAutoMarkFromUserTexts } from '@/agent/lib/salah-auto-mark'

export const runtime = 'nodejs'

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

/** Telegram/worker: persist owner prayer confirmations before agent turn. */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: { texts?: string[]; text?: string }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const texts = Array.isArray(body.texts)
    ? body.texts.map(String)
    : body.text
      ? [String(body.text)]
      : []

  if (!texts.length) return Response.json({ error: 'text_required' }, { status: 400 })

  const result = await applySalahAutoMarkFromUserTexts(texts)
  return Response.json({ success: true, ...result })
}
