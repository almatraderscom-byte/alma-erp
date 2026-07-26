/**
 * Auto-compact conversations when cumulative cost exceeds threshold.
 * Uses agent_cost_events as source of truth (falls back to totalCostUsd).
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { agentSmartText } from '@/agent/lib/llm-text'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

// Memory-safe compaction: a far-off SAFETY VALVE only. Folding a chat into a
// 5–8 line summary throws everything else away, so we do it as rarely as
// possible. There is deliberately NO day-boundary fold — that "fresh every
// morning" wipe erased the owner's memory every day. Full conversation history
// is preserved until a single chat crosses this cost threshold, matching the
// long-standing behaviour where the agent remembered everything within a chat.
export const COMPACT_THRESHOLD_USD = Number(process.env.AGENT_COMPACT_THRESHOLD_USD || '25')

/**
 * OWNER RULING 2026-07-26 — compact on the CONTEXT WINDOW, not on dollars.
 *
 * *"amr akhon compect system chilo $ doller diye, eta change kore … token er
 * upor hobe, mane model er token ja thakbe sheta cross korley usage e jokhn 100%
 * hobe auto compect hobe."*
 *
 * He is right, and this is how every serious agent app behaves. Cost and context
 * are different things: a cheap model can fill its window long before $25, and
 * an expensive one can cost $25 while barely a third full. Compaction exists to
 * stop a conversation OVERFLOWING, so the window is the only honest trigger.
 *
 * The dollar valve stays as a second, far-off backstop — if something pathological
 * spends $25 in one chat, folding it is still the right call.
 */
export const COMPACT_CONTEXT_PERCENT = Number(process.env.AGENT_COMPACT_CONTEXT_PERCENT || '100')

export async function getConversationCostUsd(conversationId: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: string | null }>>(
    Prisma.sql`SELECT COALESCE(SUM(cost_usd), 0)::text AS total
      FROM agent_cost_events
      WHERE conversation_id = ${conversationId}`,
  )
  const fromEvents = parseFloat(rows[0]?.total ?? '0') || 0
  const conv = await db.agentConversation.findUnique({
    where: { id: conversationId },
    select: { totalCostUsd: true },
  })
  const tracked = Number(conv?.totalCostUsd ?? 0) || 0
  return Math.max(fromEvents, tracked)
}

/**
 * Has this conversation filled the head's context window?
 *
 * Measured the same way the Usage meter measures it, so what Boss sees at 100%
 * is exactly what triggers the fold — no second opinion, no drift between the
 * number on screen and the number in the code.
 *
 * Fails CLOSED (returns false) if anything is unknown: an unmeasurable window
 * must never cause a surprise fold, since folding throws history away.
 */
export async function isContextWindowFull(
  conversationId: string,
  modelId: string | null,
  percentLimit = COMPACT_CONTEXT_PERCENT,
): Promise<boolean> {
  try {
    const { getModel, isKnownModelId } = await import('@/agent/lib/models/registry')
    const { readContextUsage } = await import('@/agent/lib/usage-intelligence')

    const latest = await db.agentMessage.findFirst({
      where: { conversationId, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
      select: { usage: true },
    })
    if (!latest?.usage) return false

    const usage = latest.usage as Record<string, unknown>
    const resolvedId = typeof usage.model === 'string' && isKnownModelId(usage.model)
      ? usage.model
      : (modelId && isKnownModelId(modelId) ? modelId : null)
    if (!resolvedId) return false

    const window = getModel(resolvedId)?.contextWindow
    if (!window || window <= 0) return false

    const used = readContextUsage(usage, true).tokens
    if (!used || used <= 0) return false

    return (used / window) * 100 >= percentLimit
  } catch {
    return false
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null && b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim()
}

async function summarizeForCompaction(messages: Array<{ role: string; content: unknown }>): Promise<string> {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'Owner' : 'Agent'}: ${extractText(m.content)}`)
    .filter((line) => line.length > 8)
    .join('\n')
    .slice(0, 16000)

  if (!transcript.trim()) return ''

  // Anthropic-or-Gemini (owner: Gemini replaces Sonnet for now).
  const raw = await agentSmartText({
    system:
      'You are summarizing a conversation for continuity. Extract:\n' +
      '- The user\'s main goal/topic\n' +
      '- Key decisions made\n' +
      '- Important facts/numbers mentioned\n' +
      '- Any open action items or pending questions\n' +
      'Output a tight Bangla summary (5-8 bullets). This will be used as context for a fresh conversation so the agent can keep helping seamlessly.',
    prompt: 'Summarize this owner↔agent conversation for seamless continuation:\n\n' + transcript,
    maxTokens: 400,
    costLabel: 'conversation_compact',
  })
  return raw.trim()
}

export type CompactResult = {
  newConversationId: string
  summary: string
  previousConversationId: string
  costUsd: number
}

export async function compactConversationIfNeeded(
  conversationId: string,
  thresholdUsd = COMPACT_THRESHOLD_USD,
): Promise<CompactResult | null> {
  const conv = await db.agentConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, projectId: true, source: true, modelId: true, title: true, compactedToId: true, archived: true, createdAt: true },
  })
  if (!conv || conv.compactedToId || conv.archived) return null

  // Never a day-boundary fold. Full history is kept until the chat genuinely
  // needs folding, so the agent keeps remembering inside a conversation.
  //
  // Context first (owner ruling 2026-07-26): fold when the conversation has
  // filled the head's window, because that is what compaction is FOR. Cost stays
  // as a far-off second valve for a pathological chat.
  const contextFull = await isContextWindowFull(conversationId, conv.modelId)
  const costUsd = await getConversationCostUsd(conversationId)
  if (!contextFull && costUsd < thresholdUsd) return null

  const messages = await db.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
    take: 100,
  })

  let summary = ''
  try {
    summary = await summarizeForCompaction(messages)
  } catch (err) {
    console.warn('[compact] summarization failed, skipping compaction:', err)
    return null
  }
  if (!summary) return null

  const newConv = await db.agentConversation.create({
    data: {
      title: conv.title ? `${conv.title} (cont.)` : null,
      modelId: conv.modelId,
      source: conv.source,
      projectId: conv.projectId,
      contextSummary: summary,
    },
    select: { id: true },
  })

  await db.agentConversation.update({
    where: { id: conversationId },
    data: { compactedToId: newConv.id, archived: true },
  })

  return {
    newConversationId: newConv.id,
    summary,
    previousConversationId: conversationId,
    costUsd,
  }
}

export async function compactConversationById(conversationId: string): Promise<CompactResult> {
  const conv = await db.agentConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, projectId: true, source: true, modelId: true, title: true, compactedToId: true },
  })
  if (!conv) throw new Error('not_found')
  if (conv.compactedToId) {
    return {
      newConversationId: conv.compactedToId,
      summary: '',
      previousConversationId: conversationId,
      costUsd: await getConversationCostUsd(conversationId),
    }
  }

  const messages = await db.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
    take: 100,
  })

  const summary = await summarizeForCompaction(messages)
  if (!summary) throw new Error('summary_empty')

  const newConv = await db.agentConversation.create({
    data: {
      title: conv.title ? `${conv.title} (cont.)` : null,
      modelId: conv.modelId,
      source: conv.source,
      projectId: conv.projectId,
      contextSummary: summary,
    },
    select: { id: true },
  })

  await db.agentConversation.update({
    where: { id: conversationId },
    data: { compactedToId: newConv.id, archived: true },
  })

  return {
    newConversationId: newConv.id,
    summary,
    previousConversationId: conversationId,
    costUsd: await getConversationCostUsd(conversationId),
  }
}
