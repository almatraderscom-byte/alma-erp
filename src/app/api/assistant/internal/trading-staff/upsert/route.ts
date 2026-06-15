/**
 * Phase 7 — Trading staff admin endpoint.
 *
 * Owner UI creates / updates AgentStaff rows scoped to ALMA_TRADING and links
 * them to an existing ERP User account (so TradingAccount.assignedUserId maps
 * back to the staff's chat ID for dispatch).
 *
 * Auth: NextAuth owner session OR internal bearer (Hermes-style).
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

function verifyInternal(provided: string): boolean {
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
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const isInternalCall = verifyInternal(bearer)

  if (!isInternalCall) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: {
    id?: string
    userId?: string
    name?: string
    role?: string
    telegramChatId?: string | null
    ntfyTopic?: string | null
    active?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (!body.userId && !body.id) {
    return Response.json({ error: 'userId_or_id_required' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  let user: { id: string; name: string; businessAccess: string } | null = null
  if (body.userId) {
    user = await db.user.findUnique({
      where: { id: body.userId },
      select: { id: true, name: true, businessAccess: true },
    })
    if (!user) return Response.json({ error: 'user_not_found' }, { status: 404 })
    if (!user.businessAccess?.includes('ALMA_TRADING')) {
      return Response.json(
        { error: 'user_not_in_trading', message: 'User-এর businessAccess-এ ALMA_TRADING নেই — User profile-এ access দিন।' },
        { status: 400 },
      )
    }
  }

  const staffData = {
    name: body.name?.trim() || user?.name || 'Trading Staff',
    role: body.role?.trim() || 'p2p_trader',
    telegramChatId: body.telegramChatId ? String(body.telegramChatId) : null,
    ntfyTopic: body.ntfyTopic ?? null,
    active: body.active !== false,
    businessId: 'ALMA_TRADING' as const,
    userId: body.userId ?? null,
  }

  let row: { id: string; name: string; telegramChatId: string | null; userId: string | null; active: boolean }
  if (body.id) {
    row = await db.agentStaff.update({
      where: { id: body.id },
      data: staffData,
      select: { id: true, name: true, telegramChatId: true, userId: true, active: true },
    })
  } else if (body.userId) {
    // Upsert by userId+businessId to avoid duplicates for the same trader.
    const existing = await db.agentStaff.findFirst({
      where: { userId: body.userId, businessId: 'ALMA_TRADING' },
      select: { id: true },
    })
    if (existing) {
      row = await db.agentStaff.update({
        where: { id: existing.id },
        data: staffData,
        select: { id: true, name: true, telegramChatId: true, userId: true, active: true },
      })
    } else {
      row = await db.agentStaff.create({
        data: staffData,
        select: { id: true, name: true, telegramChatId: true, userId: true, active: true },
      })
    }
  } else {
    return Response.json({ error: 'cannot_create_without_user' }, { status: 400 })
  }

  return Response.json({
    success: true,
    staff: row,
  })
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const staff = await db.agentStaff.findMany({
    where: { businessId: 'ALMA_TRADING' },
    select: {
      id: true, name: true, role: true, telegramChatId: true, ntfyTopic: true,
      active: true, userId: true,
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { name: 'asc' },
  })

  const eligible = await db.user.findMany({
    where: { active: true, businessAccess: { contains: 'ALMA_TRADING' } },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: 'asc' },
  })

  return Response.json({ staff, eligibleUsers: eligible })
}
