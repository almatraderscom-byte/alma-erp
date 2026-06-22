/**
 * Cost LOGS — owner-facing drill-down: every API spend event (all providers),
 * plus a per-conversation breakdown showing the full chat with what each message
 * cost. Answers "kon message e koto gelo, ar full chat-e total koto".
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { MODEL_REGISTRY } from '@/agent/lib/models/registry'
import { EFFECTIVE_PROVIDER_SQL } from '@/agent/lib/api-balances'
import { dhakaDayBounds } from '@/lib/agent-api/dhaka-date'

const MODEL_LABEL = new Map(MODEL_REGISTRY.map((m) => [m.id, m.label]))

/** Human label for a cost-event kind. */
const KIND_LABEL: Record<string, string> = {
  chat: 'চ্যাট',
  embedding: 'এম্বেডিং',
  transcribe: 'ভয়েস→টেক্সট',
  tts: 'টেক্সট→ভয়েস',
  image: 'ছবি',
  video: 'ভিডিও',
  call: 'ফোন কল',
  cs_chat: 'CS চ্যাট',
  cs_vision: 'CS ভিশন',
  qc_vision: 'QC ভিশন',
  cs_comment_classify: 'কমেন্ট শ্রেণি',
  web_research: 'ওয়েব রিসার্চ',
}

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind
}

/**
 * Effective cost-provider for a units payload — mirrors the SQL CASE in
 * api-balances so logs label OpenRouter (DeepSeek/Qwen) correctly even for
 * historical rows that were stored under 'openai'.
 */
function effectiveProvider(unitsProvider: string | undefined, column: string): string {
  if (unitsProvider === 'openrouter') return 'openrouter'
  if (unitsProvider === 'google') return 'gemini'
  if (unitsProvider === 'openai') return 'openai'
  if (unitsProvider === 'anthropic') return 'anthropic'
  return column
}

/** Pull readable text out of an Anthropic content-block array (or plain string). */
export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block)
      } else if (block && typeof block === 'object') {
        const obj = block as Record<string, unknown>
        if (obj.type === 'text' && typeof obj.text === 'string') parts.push(obj.text)
        else if (obj.type === 'tool_use' && typeof obj.name === 'string') parts.push(`🔧 ${obj.name}`)
        else if (obj.type === 'tool_result') parts.push('🔧 ফলাফল')
        else if (obj.type === 'image') parts.push('🖼️ ছবি')
      }
    }
    return parts.join(' ').trim()
  }
  return ''
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? `${clean.slice(0, n)}…` : clean
}

export type CostLogEvent = {
  id: string
  occurredAt: string
  provider: string
  model: string | null
  kind: string
  kindLabel: string
  costUsd: number
  inputTokens: number | null
  outputTokens: number | null
  conversationId: string | null
  conversationTitle: string | null
  source: string | null
  snippet: string | null
}

/**
 * Recent spend events across ALL APIs, newest first. Each chat row carries a
 * snippet of what was said + the conversation it belongs to, so the owner can
 * jump from a line item into the full chat breakdown.
 */
export async function getRecentCostEvents(limit = 100): Promise<CostLogEvent[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 300)
  const events = await prisma.agentCostEvent.findMany({
    orderBy: { occurredAt: 'desc' },
    take: safeLimit,
    select: {
      id: true, provider: true, kind: true, units: true, costUsd: true,
      conversationId: true, jobId: true, occurredAt: true,
    },
  })

  const convIds = [...new Set(events.map((e) => e.conversationId).filter((x): x is string => Boolean(x)))]
  const jobIds = [...new Set(events.map((e) => e.jobId).filter((x): x is string => Boolean(x)))]

  const [convs, msgs] = await Promise.all([
    convIds.length
      ? prisma.agentConversation.findMany({ where: { id: { in: convIds } }, select: { id: true, title: true, source: true } })
      : Promise.resolve([]),
    jobIds.length
      ? prisma.agentMessage.findMany({ where: { id: { in: jobIds } }, select: { id: true, content: true } })
      : Promise.resolve([]),
  ])

  const convMap = new Map(convs.map((c) => [c.id, c]))
  const msgMap = new Map(msgs.map((m) => [m.id, m]))

  return events.map((e) => {
    const units = (e.units ?? {}) as Record<string, unknown>
    const modelId = typeof units.model === 'string' ? units.model : null
    const conv = e.conversationId ? convMap.get(e.conversationId) : null
    const msg = e.jobId ? msgMap.get(e.jobId) : null
    const snippet = msg ? truncate(extractMessageText(msg.content), 120) : null
    return {
      id: e.id,
      occurredAt: e.occurredAt.toISOString(),
      provider: effectiveProvider(typeof units.provider === 'string' ? units.provider : undefined, e.provider),
      model: modelId ? (MODEL_LABEL.get(modelId) ?? modelId) : null,
      kind: e.kind,
      kindLabel: kindLabel(e.kind),
      costUsd: Number(e.costUsd) || 0,
      inputTokens: typeof units.input_tokens === 'number' ? units.input_tokens : null,
      outputTokens: typeof units.output_tokens === 'number' ? units.output_tokens : null,
      conversationId: e.conversationId,
      conversationTitle: conv?.title ?? null,
      source: conv?.source ?? null,
      snippet: snippet || null,
    }
  })
}

export type ConversationCostMessage = {
  id: string
  role: string
  text: string
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  costUsd: number
  createdAt: string
}

export type ConversationCostDetail = {
  conversationId: string
  title: string | null
  source: string | null
  totalCostUsd: number
  totalTokensIn: number
  totalTokensOut: number
  messageCount: number
  messages: ConversationCostMessage[]
}

/**
 * Full chat breakdown for one conversation — every message with its model,
 * tokens, and cost, plus the conversation total. Per-message cost is read
 * straight off agent_messages (populated by both head paths).
 */
export async function getConversationCostDetail(conversationId: string): Promise<ConversationCostDetail | null> {
  const conv = await prisma.agentConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, title: true, source: true },
  })
  if (!conv) return null

  const messages = await prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true, tokensIn: true, tokensOut: true, costUsd: true, usage: true, createdAt: true },
  })

  let total = 0
  let totalTokensIn = 0
  let totalTokensOut = 0
  const rows: ConversationCostMessage[] = messages.map((m) => {
    const cost = m.costUsd != null ? Number(m.costUsd) : 0
    total += cost
    totalTokensIn += m.tokensIn ?? 0
    totalTokensOut += m.tokensOut ?? 0
    const usage = (m.usage ?? {}) as Record<string, unknown>
    const modelId = typeof usage.model === 'string' ? usage.model : null
    return {
      id: m.id,
      role: m.role,
      text: truncate(extractMessageText(m.content), 600),
      model: modelId ? (MODEL_LABEL.get(modelId) ?? modelId) : null,
      tokensIn: m.tokensIn ?? null,
      tokensOut: m.tokensOut ?? null,
      costUsd: cost,
      createdAt: m.createdAt.toISOString(),
    }
  })

  return {
    conversationId: conv.id,
    title: conv.title,
    source: conv.source,
    totalCostUsd: Math.round(total * 1_000_000) / 1_000_000,
    totalTokensIn,
    totalTokensOut,
    messageCount: rows.length,
    messages: rows,
  }
}

// ── Per-provider, date-ranged logs ────────────────────────────────────────────
// Drives the "Logs" drilldown beside each provider in the balance table: pick a
// date window (today / 7d / 30d / custom) and see, side by side, every spend
// event (left) and the per-conversation rollup (right) for that one provider.

export type ProviderLogMessage = {
  id: string
  occurredAt: string
  kind: string
  kindLabel: string
  model: string | null
  headline: string
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number
  conversationId: string | null
  source: string | null
}

export type ProviderLogConversation = {
  conversationId: string
  title: string | null
  source: string | null
  totalCostUsd: number
  totalTokensIn: number
  totalTokensOut: number
  messageCount: number
  lastAt: string
}

export type ProviderLogs = {
  provider: string
  from: string
  to: string
  totalCostUsd: number
  totalTokensIn: number
  totalTokensOut: number
  eventCount: number
  messages: ProviderLogMessage[]
  conversations: ProviderLogConversation[]
}

type RawProviderEvent = {
  id: string
  kind: string
  units: Record<string, unknown> | null
  cost: string
  conversation_id: string | null
  job_id: string | null
  occurred_at: Date
}

const MAX_MESSAGE_ROWS = 400

/**
 * Every spend event for one effective provider within a Dhaka date window
 * [from .. to] (inclusive, yyyy-MM-dd), plus a per-conversation rollup. Totals
 * cover the whole window; the message list is capped for payload sanity while
 * the rollup is computed from all events so conversation totals stay exact.
 */
export async function getProviderLogs(
  provider: string,
  from: string,
  to: string,
): Promise<ProviderLogs> {
  const start = dhakaDayBounds(from).start
  const end = dhakaDayBounds(to).end

  const rows = await prisma.$queryRaw<RawProviderEvent[]>(Prisma.sql`
    SELECT id, kind, units, cost_usd::text AS cost,
           conversation_id, job_id, occurred_at
    FROM agent_cost_events
    WHERE occurred_at >= ${start} AND occurred_at < ${end}
      AND ${EFFECTIVE_PROVIDER_SQL} = ${provider}
    ORDER BY occurred_at DESC
  `)

  // Resolve headlines (from the assistant message keyed by job_id) and
  // conversation titles in two batched lookups.
  const jobIds = [...new Set(rows.map((r) => r.job_id).filter((x): x is string => Boolean(x)))]
  const convIds = [...new Set(rows.map((r) => r.conversation_id).filter((x): x is string => Boolean(x)))]
  const [msgs, convs] = await Promise.all([
    jobIds.length
      ? prisma.agentMessage.findMany({ where: { id: { in: jobIds } }, select: { id: true, content: true } })
      : Promise.resolve([]),
    convIds.length
      ? prisma.agentConversation.findMany({ where: { id: { in: convIds } }, select: { id: true, title: true, source: true } })
      : Promise.resolve([]),
  ])
  const msgMap = new Map(msgs.map((m) => [m.id, m]))
  const convMap = new Map(convs.map((c) => [c.id, c]))

  let totalCostUsd = 0
  let totalTokensIn = 0
  let totalTokensOut = 0
  const messages: ProviderLogMessage[] = []
  const convAgg = new Map<string, ProviderLogConversation>()

  for (const r of rows) {
    const units = r.units ?? {}
    const cost = parseFloat(r.cost) || 0
    const inTok = typeof units.input_tokens === 'number' ? units.input_tokens : null
    const outTok = typeof units.output_tokens === 'number' ? units.output_tokens : null
    const modelId = typeof units.model === 'string' ? units.model : null
    const model = modelId ? (MODEL_LABEL.get(modelId) ?? modelId) : null
    const conv = r.conversation_id ? convMap.get(r.conversation_id) : null
    const msg = r.job_id ? msgMap.get(r.job_id) : null
    const snippet = msg ? truncate(extractMessageText(msg.content), 100) : ''
    const occurredAt = r.occurred_at.toISOString()

    totalCostUsd += cost
    totalTokensIn += inTok ?? 0
    totalTokensOut += outTok ?? 0

    if (messages.length < MAX_MESSAGE_ROWS) {
      messages.push({
        id: r.id,
        occurredAt,
        kind: r.kind,
        kindLabel: kindLabel(r.kind),
        model,
        headline: snippet || kindLabel(r.kind),
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: cost,
        conversationId: r.conversation_id,
        source: conv?.source ?? null,
      })
    }

    if (r.conversation_id) {
      const existing = convAgg.get(r.conversation_id)
      if (existing) {
        existing.totalCostUsd += cost
        existing.totalTokensIn += inTok ?? 0
        existing.totalTokensOut += outTok ?? 0
        existing.messageCount += 1
        if (occurredAt > existing.lastAt) existing.lastAt = occurredAt
      } else {
        convAgg.set(r.conversation_id, {
          conversationId: r.conversation_id,
          title: conv?.title ?? null,
          source: conv?.source ?? null,
          totalCostUsd: cost,
          totalTokensIn: inTok ?? 0,
          totalTokensOut: outTok ?? 0,
          messageCount: 1,
          lastAt: occurredAt,
        })
      }
    }
  }

  const conversations = [...convAgg.values()]
    .map((c) => ({ ...c, totalCostUsd: Math.round(c.totalCostUsd * 1_000_000) / 1_000_000 }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd)

  return {
    provider,
    from,
    to,
    totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    totalTokensIn,
    totalTokensOut,
    eventCount: rows.length,
    messages,
    conversations,
  }
}
