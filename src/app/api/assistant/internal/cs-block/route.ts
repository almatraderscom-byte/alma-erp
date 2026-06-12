import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { blockCsCustomer } from '@/agent/lib/cs/guards'

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

  const body = await req.json() as { pageId?: string; psid?: string; reason?: string; blockedBy?: string }
  if (!body.pageId || !body.psid) {
    return Response.json({ error: 'pageId and psid required' }, { status: 400 })
  }

  await blockCsCustomer({
    pageId: body.pageId,
    psid: body.psid,
    reason: body.reason,
    blockedBy: body.blockedBy,
  })

  return Response.json({ ok: true })
}
