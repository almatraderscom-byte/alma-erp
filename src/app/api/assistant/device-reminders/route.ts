import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Feed for the native app's OFFLINE reminders: the upcoming pending agent
 * reminders so the iOS shell can schedule LOCAL notifications that fire even if
 * push/network is down. Owner-only (same auth as /api/assistant/chat).
 *
 * iOS caps *pending* local notifications at 64 — we return at most 32 to leave
 * headroom for anything else the app may schedule, and only a 7-day window so the
 * list stays small and re-syncs often.
 */
export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const now = new Date()
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  const rows = await prisma.agentReminder.findMany({
      where: {
        status: 'pending',
        dueAt: { gte: now, lte: in7Days },
      },
      orderBy: { dueAt: 'asc' },
      take: 32,
      select: { id: true, title: true, body: true, dueAt: true },
    })

  const reminders = rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    dueAt: r.dueAt.toISOString(),
  }))

  return Response.json({ reminders })
}
