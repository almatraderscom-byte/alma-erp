/**
 * Range-filtered usage logs — powers the native Credit Usage "Logs" explorer
 * (OpenRouter-style: pick a time window, see every spend event newest-first,
 * tap a row for the raw stored record). Read-only over agent_cost_events.
 *
 * RAW TRUTH RULE (owner): every event returns its full stored `units` JSON
 * verbatim, plus a few normalized convenience fields. Callers stored token
 * counts under differing names over time (input_tokens / tokens_in /
 * inputTokens …) — normalization checks all spellings but never invents data.
 * Cache tokens exist ONLY where the caller recorded them (Anthropic head path
 * + subagents: cache_read_input_tokens / cache_creation_input_tokens).
 * Latency / TTFT are NOT stored in this table, so they are never returned.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { MODEL_REGISTRY } from '@/agent/lib/models/registry'
import { kindLabel } from '@/agent/lib/cost-logs'

const MODEL_LABEL = new Map(MODEL_REGISTRY.map((m) => [m.id, m.label]))

export type UsageLogEvent = {
  id: string
  occurredAt: string
  /** Effective provider (units.provider wins over the column — same mapping as cost-logs). */
  provider: string
  kind: string
  kindLabel: string
  modelId: string | null
  /** Human label from the model registry (falls back to the raw id). */
  model: string | null
  /** Role/task tag when stored: units.role / subagent / purpose / via / tool. */
  taskLabel: string | null
  costUsd: number
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  /** Only present where the caller stored a success flag (e.g. Oxylabs). */
  ok: boolean | null
  conversationId: string | null
  jobId: string | null
  /** The full stored units JSON, verbatim — the detail sheet's source of truth. */
  units: Record<string, unknown>
}

export type UsageLogBucket = {
  start: string
  calls: number
  costUsd: number
}

export type UsageLogsPage = {
  from: string
  to: string
  events: UsageLogEvent[]
  nextCursor: string | null
  /** Only on the first page (no cursor): dense activity buckets over the window. */
  buckets?: UsageLogBucket[]
  bucketMs?: number
  totalCalls?: number
  totalCostUsd?: number
}

/** Same effective-provider mapping as cost-logs (historical rows stored under 'openai'). */
function effectiveProvider(unitsProvider: unknown, column: string): string {
  if (unitsProvider === 'openrouter') return 'openrouter'
  if (unitsProvider === 'google') return 'gemini'
  if (unitsProvider === 'openai') return 'openai'
  if (unitsProvider === 'anthropic') return 'anthropic'
  return column
}

function pickNum(u: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = u[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

function pickStr(u: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = u[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

/** Compound cursor "occurredAtISO_id" — occurredAt is not unique, id breaks ties. */
export function encodeCursor(occurredAt: Date, id: string): string {
  return `${occurredAt.toISOString()}_${id}`
}

export function decodeCursor(cursor: string): { occurredAt: Date; id: string } | null {
  const i = cursor.indexOf('_')
  if (i <= 0) return null
  const at = new Date(cursor.slice(0, i))
  const id = cursor.slice(i + 1)
  if (Number.isNaN(at.getTime()) || !id) return null
  return { occurredAt: at, id }
}

function toEvent(e: {
  id: string
  provider: string
  kind: string
  units: Prisma.JsonValue
  costUsd: Prisma.Decimal
  conversationId: string | null
  jobId: string | null
  occurredAt: Date
}): UsageLogEvent {
  const units = (e.units && typeof e.units === 'object' && !Array.isArray(e.units)
    ? (e.units as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const modelId = pickStr(units, ['model'])
  const successNum = pickNum(units, ['success'])
  const ok = typeof units.success === 'boolean'
    ? units.success
    : successNum != null ? successNum !== 0 : null
  return {
    id: e.id,
    occurredAt: e.occurredAt.toISOString(),
    provider: effectiveProvider(units.provider, e.provider),
    kind: e.kind,
    kindLabel: kindLabel(e.kind),
    modelId,
    model: modelId ? (MODEL_LABEL.get(modelId) ?? modelId) : null,
    taskLabel: pickStr(units, ['role', 'subagent', 'purpose', 'via', 'tool']),
    costUsd: Number(e.costUsd) || 0,
    inputTokens: pickNum(units, ['input_tokens', 'tokens_in', 'inputTokens']),
    outputTokens: pickNum(units, ['output_tokens', 'tokens_out', 'outputTokens']),
    cacheReadTokens: pickNum(units, ['cache_read_input_tokens']),
    cacheWriteTokens: pickNum(units, ['cache_creation_input_tokens']),
    ok,
    conversationId: e.conversationId,
    jobId: e.jobId,
    units,
  }
}

const TARGET_BUCKETS = 48
const MIN_BUCKET_MS = 60_000

/**
 * One page of usage-log events in [from..to], newest first, plus (first page
 * only) a dense calls-per-bucket histogram computed over the WHOLE window with
 * a single indexed aggregate — so the mini-chart and totals stay exact even
 * when the row list is paginated.
 */
export async function getUsageLogs(opts: {
  from: Date
  to: Date
  limit: number
  cursor?: string | null
}): Promise<UsageLogsPage> {
  const { from, to } = opts
  const limit = Math.min(Math.max(opts.limit, 1), 200)
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null

  const timeWhere: Prisma.AgentCostEventWhereInput = { occurredAt: { gte: from, lte: to } }
  const where: Prisma.AgentCostEventWhereInput = cursor
    ? {
        AND: [
          timeWhere,
          {
            OR: [
              { occurredAt: { lt: cursor.occurredAt } },
              { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
            ],
          },
        ],
      }
    : timeWhere

  const rows = await prisma.agentCostEvent.findMany({
    where,
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true, provider: true, kind: true, units: true, costUsd: true,
      conversationId: true, jobId: true, occurredAt: true,
    },
  })

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page[page.length - 1]
  const nextCursor = hasMore && last ? encodeCursor(last.occurredAt, last.id) : null

  const result: UsageLogsPage = {
    from: from.toISOString(),
    to: to.toISOString(),
    events: page.map(toEvent),
    nextCursor,
  }

  // Histogram + exact totals: first page only (load-more keeps the client's chart).
  if (!opts.cursor) {
    const spanMs = Math.max(to.getTime() - from.getTime(), MIN_BUCKET_MS)
    const bucketMs = Math.max(MIN_BUCKET_MS, Math.ceil(spanMs / TARGET_BUCKETS))
    const n = Math.max(1, Math.ceil(spanMs / bucketMs))
    const sec = bucketMs / 1000
    const fromEpoch = from.getTime() / 1000

    const raw = await prisma.$queryRaw<{ b: number; calls: number; cost: string }[]>(Prisma.sql`
      SELECT floor((extract(epoch FROM occurred_at) - ${fromEpoch}) / ${sec})::int AS b,
             count(*)::int AS calls,
             COALESCE(SUM(cost_usd), 0)::text AS cost
      FROM agent_cost_events
      WHERE occurred_at >= ${from} AND occurred_at <= ${to}
      GROUP BY 1
      ORDER BY 1
    `)

    const buckets: UsageLogBucket[] = Array.from({ length: n }, (_, i) => ({
      start: new Date(from.getTime() + i * bucketMs).toISOString(),
      calls: 0,
      costUsd: 0,
    }))
    let totalCalls = 0
    let totalCostUsd = 0
    for (const r of raw) {
      const idx = Math.min(Math.max(r.b, 0), n - 1) // clamp the occurred_at == to edge
      const cost = parseFloat(r.cost) || 0
      buckets[idx].calls += r.calls
      buckets[idx].costUsd = Math.round((buckets[idx].costUsd + cost) * 1_000_000) / 1_000_000
      totalCalls += r.calls
      totalCostUsd += cost
    }
    result.buckets = buckets
    result.bucketMs = bucketMs
    result.totalCalls = totalCalls
    result.totalCostUsd = Math.round(totalCostUsd * 1_000_000) / 1_000_000
  }

  return result
}
