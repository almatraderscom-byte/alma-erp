/**
 * VPS inbox poll → ingest customer messages when Meta webhooks do not fire.
 * Auth: AGENT_INTERNAL_TOKEN only.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { ingestInboundMessengerMessage } from '@/agent/lib/cs/messenger-ingest'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: {
    pageId?: string
    psid?: string
    mid?: string
    text?: string
    imageUrls?: string[]
    customerName?: string
  }
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const result = await ingestInboundMessengerMessage({
    pageId: String(body.pageId ?? ''),
    psid: String(body.psid ?? ''),
    mid: String(body.mid ?? ''),
    text: body.text,
    imageUrls: body.imageUrls,
    customerName: body.customerName,
  })

  return Response.json({ ok: true, ...result })
}
