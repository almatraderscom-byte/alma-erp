import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { toolResultPreview } from '@/agent/lib/tool-labels'

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

  // ROBUST RECONSTRUCTION: the in-content breadcrumb is fragile — for some tools
  // (notably the two-way agent call) it never lands in the saved message, so the
  // approve/reject decision vanished on reload. The durable source of truth is the
  // agent_pending_actions table, which ALWAYS carries conversationId. Pull every
  // action for this conversation; this both supplies live status for existing
  // breadcrumbs AND lets us synthesize cards that were never breadcrumbed.
  const allActions = await prisma.agentPendingAction.findMany({
    where: { conversationId: id },
    select: { id: true, type: true, summary: true, costEstimate: true, status: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  const statusById = new Map<string, string>()
  for (const a of allActions) statusById.set(a.id, a.status)

  // For any action with no breadcrumb anywhere in the saved messages, attach a
  // synthetic confirm-card block to the earliest assistant message at/after the
  // action's creation time (the turn that asked for confirmation). Fallback: the
  // last assistant message, so the card is never lost.
  const assistantMsgs = messages.filter((m) => m.role === 'assistant')
  const syntheticByMsg = new Map<string, Array<Record<string, unknown>>>()
  for (const a of allActions) {
    if (cardIds.has(a.id)) continue
    const target =
      assistantMsgs.find((m) => m.createdAt >= a.createdAt) ??
      assistantMsgs[assistantMsgs.length - 1]
    if (!target) continue
    const block: Record<string, unknown> = {
      type: 'confirm_card',
      pendingActionId: a.id,
      summary: a.summary ?? '',
      actionType: a.type,
      status: a.status,
    }
    if (a.costEstimate != null) block.costEstimate = a.costEstimate
    const list = syntheticByMsg.get(target.id) ?? []
    list.push(block)
    syntheticByMsg.set(target.id, list)
  }

  // Reconstruct the per-message tool activity (Claude-style expandable cards) from
  // the durable agent_tool_calls rows, so the cards survive the background message
  // poll / page reload instead of only existing during the live stream.
  const toolCallRows = await prisma.agentToolCall.findMany({
    where: { messageId: { in: messages.map((m) => m.id) } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, messageId: true, toolName: true, input: true, output: true, status: true, error: true },
  })
  const toolsByMsg = new Map<string, Array<Record<string, unknown>>>()
  for (const t of toolCallRows) {
    if (!t.messageId) continue
    const out = (t.output ?? null) as { data?: unknown } | null
    const success = t.status === 'success'
    const resultPreview = toolResultPreview({ success, data: out?.data, error: t.error ?? undefined })
    const list = toolsByMsg.get(t.messageId) ?? []
    list.push({ id: t.id, name: t.toolName, success, input: t.input ?? undefined, result: resultPreview })
    toolsByMsg.set(t.messageId, list)
  }

  // Surface cache tokens (hidden inside the usage JSON) so the UI can show the
  // real per-message token count, not just the tiny non-cached input_tokens.
  const withCache = messages.map((m) => {
    const u = (m.usage ?? {}) as Record<string, unknown>
    const num = (v: unknown) => (typeof v === 'number' ? v : null)
    // Inject the live status onto each persisted confirm-card block. A missing
    // action row (purged) is treated as 'expired' so the card settles, never
    // re-arming an approve/reject for an action that no longer exists.
    const baseContent = Array.isArray(m.content)
      ? (m.content as Array<Record<string, unknown>>).map((b) =>
          b?.type === 'confirm_card' && typeof b.pendingActionId === 'string'
            ? { ...b, status: statusById.get(b.pendingActionId) ?? 'expired' }
            : b,
        )
      : m.content
    // Append any synthetic cards reconstructed from agent_pending_actions for
    // actions that were never breadcrumbed into this message's saved content.
    const synthetic = syntheticByMsg.get(m.id)
    const content =
      synthetic && Array.isArray(baseContent)
        ? [...baseContent, ...synthetic]
        : baseContent
    return {
      ...m,
      content,
      toolCalls: toolsByMsg.get(m.id) ?? [],
      cacheCreation: num(u.cache_creation_input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      // Surface the extended-thinking trace (persisted in usage metadata) so the
      // "Thought for Ns" block survives reload, not just the live stream.
      thinking: typeof u.reasoning === 'string' && u.reasoning ? u.reasoning : undefined,
      thinkingMs: typeof u.reasoningMs === 'number' ? u.reasoningMs : undefined,
    }
  })

  return Response.json(withCache)
}
