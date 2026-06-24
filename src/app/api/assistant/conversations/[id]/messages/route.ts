import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!isSystemOwner(token)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const { id } = await Promise.resolve(params)

  const conversation = await prisma.agentConversation.findUnique({
    where: { id },
    select: { id: true },
  })
  if (!conversation) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  const messages = await prisma.agentMessage.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      role: true,
      content: true,
      tokensIn: true,
      tokensOut: true,
      costUsd: true,
      usage: true,
      createdAt: true,
    },
  })

  // Confirm cards are persisted inside assistant message content as breadcrumbs so
  // they survive a page reload. Their interactive vs. resolved state depends on the
  // CURRENT pending-action status, so resolve those live (a card approved earlier
  // must render as "✅ অনুমোদিত", not a fresh actionable card).
  const cardIds = new Set<string>()
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []
    for (const b of blocks) {
      if (b?.type === 'confirm_card' && typeof b.pendingActionId === 'string') cardIds.add(b.pendingActionId)
    }
  }
  const statusById = new Map<string, string>()
  if (cardIds.size > 0) {
    const actions = await prisma.agentPendingAction.findMany({
      where: { id: { in: [...cardIds] } },
      select: { id: true, status: true },
    })
    for (const a of actions) statusById.set(a.id, a.status)
  }

  // Surface cache tokens (hidden inside the usage JSON) so the UI can show the
  // real per-message token count, not just the tiny non-cached input_tokens.
  const withCache = messages.map((m) => {
    const u = (m.usage ?? {}) as Record<string, unknown>
    const num = (v: unknown) => (typeof v === 'number' ? v : null)
    // Inject the live status onto each persisted confirm-card block. A missing
    // action row (purged) is treated as 'expired' so the card settles, never
    // re-arming an approve/reject for an action that no longer exists.
    const content = Array.isArray(m.content)
      ? (m.content as Array<Record<string, unknown>>).map((b) =>
          b?.type === 'confirm_card' && typeof b.pendingActionId === 'string'
            ? { ...b, status: statusById.get(b.pendingActionId) ?? 'expired' }
            : b,
        )
      : m.content
    return {
      ...m,
      content,
      cacheCreation: num(u.cache_creation_input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
    }
  })

  return Response.json(withCache)
}
