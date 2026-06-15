// Binds a staff member's Telegram chat ID. Called by owner via /staff link command.
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

  let body: { name?: string; telegramChatId?: string; businessId?: string }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const { name, telegramChatId, businessId } = body
  if (!name || !telegramChatId) {
    return Response.json({ error: 'name and telegramChatId required' }, { status: 400 })
  }

  // Optional businessId filter — Phase 7. Default to Lifestyle for backward compat
  // so existing /staff link callers keep working.
  const filterBusinessId =
    businessId === 'ALMA_TRADING' || businessId === 'ALMA_LIFESTYLE'
      ? businessId
      : 'ALMA_LIFESTYLE'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  // Find staff by name (case-insensitive partial match), scoped to business.
  const staff = await db.agentStaff.findFirst({
    where: {
      name: { contains: name, mode: 'insensitive' },
      active: true,
      businessId: filterBusinessId,
    },
  })

  if (!staff) {
    return Response.json({ error: `Staff member "${name}" not found` }, { status: 404 })
  }

  const updated = await db.agentStaff.update({
    where: { id: staff.id },
    data: { telegramChatId: String(telegramChatId), updatedAt: new Date() },
  })

  return Response.json({ id: updated.id, name: updated.name, telegramChatId: updated.telegramChatId })
}
