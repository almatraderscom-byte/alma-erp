// Internal endpoint: worker logs a sent notification to agent_notifications.
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

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

  let body: { tier?: number; category?: string; title?: string; message?: string; channels?: string[]; statuses?: Record<string, string> }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const { tier, category, title, message, channels, statuses } = body
  if (typeof tier !== 'number' || !title || !message) {
    return Response.json({ error: 'tier, title, message required' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const record = await db.agentNotification.create({
    data: {
      tier,
      category: category ?? null,
      title: String(title),
      message: String(message),
      channels: channels ?? [],
      statuses: statuses ?? {},
    },
  })

  return Response.json({ id: record.id })
}
