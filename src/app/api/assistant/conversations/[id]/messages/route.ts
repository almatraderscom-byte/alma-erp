import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { toolResultPreview } from '@/agent/lib/tool-labels'
import { decodeUnicodeEscapes } from '@/agent/lib/decode-unicode-escapes'
import { buildMessageCursorWhere, buildMessagesPagePlan } from '@/agent/lib/messages-page'
import { buildAgentPresentationV1 } from '@/agent/lib/presentation/build-presentation'
import {
  IMAGE_WORKER_CAPABILITY_KV_KEY,
  imageModelAvailability,
  selectionForImageAction,
} from '@/agent/lib/image-action-contract'
import {
  buildImageRenderSelection,
  IMAGE_CONTROLS_V2_KV_KEY,
  imageRenderConfigForAction,
} from '@/agent/lib/image-render-config'
import { readKv } from '@/lib/creative-studio/taste'

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

  // Roadmap 4.1 — additive pagination/delta params; absent params = legacy full
  // history so existing clients keep identical behavior.
  const beforeId = req.nextUrl.searchParams.get('before')
  const afterId = req.nextUrl.searchParams.get('after')
  let beforeAnchor: { createdAt: Date; id: string } | null = null
  let afterAnchor: { createdAt: Date; id: string } | null = null
  if (beforeId) {
    const anchor = await prisma.agentMessage.findUnique({
      where: { id: beforeId },
      select: { id: true, createdAt: true, conversationId: true },
    })
    if (anchor && anchor.conversationId === id) beforeAnchor = anchor
  }
  if (afterId) {
    const anchor = await prisma.agentMessage.findUnique({
      where: { id: afterId },
      select: { id: true, createdAt: true, conversationId: true },
    })
    if (anchor && anchor.conversationId === id) afterAnchor = anchor
  }
  const plan = buildMessagesPagePlan({
    limit: req.nextUrl.searchParams.get('limit'),
    since: req.nextUrl.searchParams.get('since'),
    beforeCreatedAt: beforeAnchor?.createdAt,
    afterCreatedAt: afterAnchor?.createdAt,
  })

  const cursorWhere = beforeAnchor
    ? buildMessageCursorWhere('before', beforeAnchor)
    : afterAnchor
      ? buildMessageCursorWhere('after', afterAnchor)
      : plan.createdAt
        ? { createdAt: plan.createdAt }
        : {}
  const direction = plan.fetchDescThenReverse ? 'desc' : 'asc'

  let messages = await prisma.agentMessage.findMany({
    where: { conversationId: id, ...cursorWhere },
    orderBy: [{ createdAt: direction }, { id: direction }],
    ...(plan.take ? { take: plan.take } : {}),
    select: {
      id: true,
      clientRequestId: true,
      role: true,
      content: true,
      tokensIn: true,
      tokensOut: true,
      costUsd: true,
      usage: true,
      createdAt: true,
    },
  })
  if (plan.fetchDescThenReverse) messages = messages.reverse()

  // Confirm cards are persisted inside assistant message content as breadcrumbs so
  // they survive a page reload. Their interactive vs. resolved state depends on the
  // CURRENT pending-action status, so resolve those live (a card approved earlier
  // must render as "✅ অনুমোদিত", not a fresh actionable card).
  const cardIds = new Set<string>()
  const askCardIds = new Set<string>()
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []
    for (const b of blocks) {
      if (b?.type === 'confirm_card' && typeof b.pendingActionId === 'string') cardIds.add(b.pendingActionId)
      if (b?.type === 'ask_card' && typeof b.askCardId === 'string') askCardIds.add(b.askCardId)
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
    select: {
      id: true,
      type: true,
      summary: true,
      costEstimate: true,
      status: true,
      createdAt: true,
      result: true,
      ownerDecided: true,
      payload: true,
      imageModel: true,
      imageQuote: true,
      imageConfig: true,
      imageConfigRevision: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  const statusById = new Map<string, string>()
  const summaryById = new Map<string, string>()
  // Failure reason (owner rule: a failed approval must NEVER be silent — always
  // show WHY). Executors store their error in result.error / result.message.
  const failReasonById = new Map<string, string>()
  // Did BOSS decide this, or did it run under standing authority and never reach
  // him? Only the approve/reject routes set ownerDecided, and both refuse a row
  // that is not 'pending' — so a row created already-approved (a read-only
  // crawl, a queued generation) can never be marked his. NULL is UNKNOWN, not
  // false: history written before the column keeps the old wording rather than
  // being relabelled by a guess. (resolvedAt looked like the signal and is not:
  // the worker's job-result callback stamps it on completion.)
  const ownerDecidedById = new Map<string, boolean | null>()
  const [workerCapabilities, genericLaneKill, xaiEnabled] = await Promise.all([
    readKv(IMAGE_WORKER_CAPABILITY_KV_KEY),
    readKv('cs_engine_kill:gemini'),
    readKv('cs_xai_enabled'),
  ])
  const imageAvailability = imageModelAvailability({
    workerCapabilities,
    genericLaneKilled: genericLaneKill === '1',
    xaiConfigured: xaiEnabled === '1',
  })
  const imageControlsV2 = (await readKv(IMAGE_CONTROLS_V2_KV_KEY)) === '1'
  const imageSelectionById = new Map<string, unknown>()
  const imageRenderSelectionById = new Map<string, unknown>()
  for (const a of allActions) {
    statusById.set(a.id, a.status)
    summaryById.set(a.id, a.summary ?? '')
    ownerDecidedById.set(a.id, a.ownerDecided ?? null)
    if (a.type === 'image_gen') {
      imageSelectionById.set(a.id, selectionForImageAction({
        ...a,
        availability: imageAvailability,
      }))
      // Cold history carries the SAME v2 projection the live edit echo used,
      // so a reloaded card renders identically to its settled live state.
      if (imageControlsV2) {
        const config = imageRenderConfigForAction(a)
        if (config) {
          try {
            imageRenderSelectionById.set(a.id, buildImageRenderSelection({
              config,
              revision: a.imageConfigRevision ?? 0,
              availability: imageAvailability,
            }))
          } catch { /* a malformed row keeps its v1 card */ }
        }
      }
    }
    if (a.status === 'failed' && a.result && typeof a.result === 'object') {
      const r = a.result as Record<string, unknown>
      const reason = [r.error, r.message, r.detail].find((v) => typeof v === 'string' && v.trim())
      if (reason) failReasonById.set(a.id, String(reason).slice(0, 300))
    }
  }

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
      // Decode any literal `\uXXXX` escapes a relayed summary may carry, so an
      // astral emoji (e.g. 🎯) renders as the glyph, not its escape text.
      summary: decodeUnicodeEscapes(a.summary ?? ''),
      actionType: a.type,
      status: a.status,
      ownerDecided: a.ownerDecided ?? undefined,
      failReason: a.status === 'failed' ? failReasonById.get(a.id) : undefined,
    }
    if (a.costEstimate != null) block.costEstimate = a.costEstimate
    if (a.type === 'image_gen') block.imageModelSelection = imageSelectionById.get(a.id)
    if (a.type === 'image_gen' && imageRenderSelectionById.has(a.id)) {
      block.imageRenderSelection = imageRenderSelectionById.get(a.id)
    }
    const list = syntheticByMsg.get(target.id) ?? []
    list.push(block)
    syntheticByMsg.set(target.id, list)
  }

  // ASK-CARD RECONSTRUCTION (mirrors the confirm-card pattern above): the ask_user
  // question card used to live only in client memory (SSE event), so the 12s
  // message poll / visibilitychange resync / reload wiped it within seconds. The
  // durable source of truth is the agent_ask_cards table — pull every card for
  // this conversation; it supplies live status/answer for breadcrumbed cards AND
  // lets us synthesize cards that were never breadcrumbed into a saved message.
  const askRows: Array<{
    id: string
    question: string
    options: string
    status: string
    selectedOption: string | null
    createdAt: Date
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }> = await (prisma as any).agentAskCard.findMany({
    where: { conversationId: id },
    select: { id: true, question: true, options: true, status: true, selectedOption: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  const parseOptions = (raw: string): string[] => {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch { return [] }
  }
  const askById = new Map(askRows.map((a) => [a.id, a]))

  // For any ask card with no breadcrumb anywhere in the saved messages, attach a
  // synthetic ask_card block to the earliest assistant message at/after the card's
  // creation time (the turn that asked). Fallback: the last assistant message.
  const syntheticAskByMsg = new Map<string, Array<Record<string, unknown>>>()
  for (const a of askRows) {
    // A newer owner instruction supersedes an unanswered question. Keep the row
    // for audit, but do not resurrect its dead card into the live conversation.
    if (a.status === 'superseded') continue
    if (askCardIds.has(a.id)) continue
    const target =
      assistantMsgs.find((m) => m.createdAt >= a.createdAt) ??
      assistantMsgs[assistantMsgs.length - 1]
    if (!target) continue
    const list = syntheticAskByMsg.get(target.id) ?? []
    list.push({
      type: 'ask_card',
      askCardId: a.id,
      question: decodeUnicodeEscapes(a.question ?? ''),
      options: parseOptions(a.options),
      status: a.status,
      selectedOption: a.selectedOption ?? undefined,
    })
    syntheticAskByMsg.set(target.id, list)
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
      ? (m.content as Array<Record<string, unknown>>).flatMap((b) => {
          if (b?.type === 'confirm_card' && typeof b.pendingActionId === 'string') {
            return [{
              ...b,
              status: statusById.get(b.pendingActionId) ?? 'expired',
              ownerDecided: ownerDecidedById.get(b.pendingActionId) ?? undefined,
              failReason: failReasonById.get(b.pendingActionId),
              imageModelSelection: imageSelectionById.get(b.pendingActionId) ?? b.imageModelSelection,
              imageRenderSelection: imageRenderSelectionById.get(b.pendingActionId) ?? b.imageRenderSelection,
              // The action summary changes when the owner switches image model.
              // Canonical action state wins over the old breadcrumb so a reload
              // cannot revert the live card's "Model:" line.
              summary: decodeUnicodeEscapes(
                summaryById.get(b.pendingActionId)
                  ?? (typeof b.summary === 'string' ? b.summary : ''),
              ),
            }]
          }
          if (b?.type === 'ask_card' && typeof b.askCardId === 'string') {
            // Inject the CURRENT ask-card state onto the persisted breadcrumb.
            // Missing/purged/superseded cards are audit-only and stay hidden.
            const row = askById.get(b.askCardId)
            // Superseded questions remain in the audit table, not as duplicate
            // cards in the chat transcript.
            if (!row || row.status === 'superseded') return []
            return [{
              ...b,
              status: row.status,
              selectedOption: row.selectedOption ?? undefined,
              ...(typeof b.question === 'string'
                ? { question: decodeUnicodeEscapes(b.question) }
                : {}),
            }]
          }
          return [b]
        })
      : m.content
    // Append any synthetic cards reconstructed from agent_pending_actions /
    // agent_ask_cards for cards never breadcrumbed into this message's content.
    const synthetic = [
      ...(syntheticByMsg.get(m.id) ?? []),
      ...(syntheticAskByMsg.get(m.id) ?? []),
    ]
    const content =
      synthetic.length > 0 && Array.isArray(baseContent)
        ? [...baseContent, ...synthetic]
        : baseContent
    const toolCalls = toolsByMsg.get(m.id) ?? []
    const cacheCreation = num(u.cache_creation_input_tokens)
    const cacheRead = num(u.cache_read_input_tokens)
    const apiRounds = num(u.api_rounds) ?? undefined
    const roundCostsUsd = Array.isArray(u.round_costs_usd)
      ? (u.round_costs_usd as unknown[]).filter((n): n is number => typeof n === 'number')
      : undefined
    const timeline = Array.isArray(u.timeline) ? u.timeline : undefined
    return {
      ...m,
      clientMessageId: m.clientRequestId ?? undefined,
      content,
      toolCalls,
      cacheCreation,
      cacheRead,
      // One reply = several provider API calls (one per tool round) = several rows
      // on the OpenRouter Logs page. Surface the round count + per-round billed
      // costs so the cost badge can show "· N ধাপ" with a breakdown.
      apiRounds,
      roundCostsUsd,
      // Surface the extended-thinking trace (persisted in usage metadata) so the
      // "Thought for Ns" block survives reload, not just the live stream.
      thinking: typeof u.reasoning === 'string' && u.reasoning ? u.reasoning : undefined,
      thinkingMs: typeof u.reasoningMs === 'number' ? u.reasoningMs : undefined,
      // How long the agent actually WORKED on this reply (owner ask 2026-07-26:
      // "reply শেষ হলেও time টা যেন show করে token এর সাথে").
      durationMs: typeof u.duration_ms === 'number' ? u.duration_ms : undefined,
      // P1-9 — WHY this head answered, not just which one ("routine_kw",
      // "task_pin", "deny_kw"). Persisted on the turn; surfaced here so a
      // surprising model choice has an answer that survives a reload, instead
      // of living only in code and cost logs (audit §F).
      headVia: typeof u.headVia === 'string' ? u.headVia : undefined,
      headTier: typeof u.headTier === 'string' ? u.headTier : undefined,
      // Ordered, display-only activity timeline (reasoning ↔ tool, execution order)
      // that drives the unified Claude-style stream after reload.
      timeline,
      // ONE canonical, versioned presentation projection (parity roadmap §5) —
      // additive next to every legacy field; both clients converge on this.
      presentation:
        m.role === 'assistant'
          ? buildAgentPresentationV1({
              messageId: m.id,
              content,
              timeline,
              toolCalls: toolCalls as Array<{ id?: string; name?: string; success?: boolean; result?: string }>,
              tokensIn: m.tokensIn,
              tokensOut: m.tokensOut,
              cacheCreation,
              cacheRead,
              costUsd: m.costUsd != null ? Number(m.costUsd) : null,
              apiRounds: apiRounds ?? null,
              roundCostsUsd: roundCostsUsd ?? null,
            })
          : undefined,
    }
  })

  return Response.json(withCache)
}
