/**
 * GET /api/assistant/actions — list the owner's pending agent actions.
 *
 * Powers the "Agent" tab in the ERP Approval Center: one place where every
 * agent-proposed action (voice calls, dispatch, finance confirms, …) waits for
 * the owner's Approve / Reject instead of being buried in chat or Telegram.
 *
 * Owner-only (NextAuth session) OR the internal bearer token. Read-only; the
 * actual approve/reject happen on /actions/[id]/approve and /actions/[id]/reject.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { isPendingActionExpired } from '@/agent/lib/pending-action'

export const runtime = 'nodejs'

function verifyInternalToken(provided: string): boolean {
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

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const status = (searchParams.get('status') ?? 'pending').toLowerCase()
  const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 50, 1), 100)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const where = status === 'all' ? {} : { status }
  const rows = await db.agentPendingAction
    .findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        type: true,
        status: true,
        summary: true,
        costEstimate: true,
        conversationId: true,
        result: true,
        createdAt: true,
      },
    })
    .catch(() => [])

  // Flag transient cards that have aged past their TTL. Lifecycle-bound cards
  // like dispatch never expire — isPendingActionExpired handles that.
  const actions = rows.map(
    (r: { status: string; type: string; createdAt: Date | string } & Record<string, unknown>) => ({
      ...r,
      expired: r.status === 'pending' && isPendingActionExpired(r.createdAt, r.type),
    }),
  )

  // Proactively retire expired-but-still-pending cards. Without this they sit in
  // the queue forever as status='pending' — and the UI greys out both buttons on
  // an expired card, so the owner had no way to clear them ("remove hoy na").
  // Transition them to the terminal 'expired' status (same as the approve/reject
  // routes do on a 410) and drop them from the pending view so they disappear.
  const expiredIds = actions.filter((a: { expired: boolean }) => a.expired).map((a: { id: string }) => a.id)
  if (expiredIds.length) {
    await db.agentPendingAction
      .updateMany({
        where: { id: { in: expiredIds }, status: 'pending' },
        data: { status: 'expired', resolvedAt: new Date() },
      })
      .catch((err: unknown) => {
        console.warn('[assistant/actions] expired sweep failed:', err instanceof Error ? err.message : err)
      })
  }

  const visible = status === 'pending' ? actions.filter((a: { expired: boolean }) => !a.expired) : actions
  return Response.json({ count: visible.length, actions: visible })
}
