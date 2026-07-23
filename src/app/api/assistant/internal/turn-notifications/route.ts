import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { processDueTurnCompletionNotifications } from '@/agent/lib/turn-completion-notify'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const actual = Buffer.from(provided, 'utf8')
    const wanted = Buffer.from(expected, 'utf8')
    return actual.length === wanted.length && timingSafeEqual(actual, wanted)
  } catch {
    return false
  }
}

/**
 * VPS retry driver for durable Agent completion pushes. This route owns no
 * schedule itself; the worker calls it periodically and the DB lease prevents
 * overlapping callers from double-processing a delivery.
 */
export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const result = await processDueTurnCompletionNotifications(20)
  return Response.json({ ok: true, ...result })
}
