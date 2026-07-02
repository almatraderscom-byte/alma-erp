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

  // Cost-only safety valve — never a day-boundary fold. Full history is kept
  // until a conversation gets genuinely expensive, so the agent keeps remembering.
  const costUsd = await getConversationCostUsd(conversationId)
  if (costUsd < thresholdUsd) return null

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
