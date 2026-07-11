// Internal endpoint: the VPS worker asks Vercel to send a native OneSignal push to
// the owner's app. Keeps OneSignal credentials in Vercel only (not duplicated on the
// VPS). Owner-only via AGENT_INTERNAL_TOKEN. Fail-open on the worker side.
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { pushNativeToOwner } from '@/agent/lib/native-owner-push'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: {
    tier?: number
    title?: string
    message?: string
    category?: 'salah' | 'urgent' | 'task' | 'report'
    actionUrl?: string | null
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const tier = body.tier === 2 || body.tier === 3 ? body.tier : 1
  if (!body.title || !body.message) {
    return Response.json({ error: 'title, message required' }, { status: 400 })
  }

  const result = await pushNativeToOwner({
    tier,
    title: String(body.title),
    message: String(body.message),
    category: body.category,
    actionUrl: body.actionUrl ?? null,
  })

  return Response.json(result)
}
