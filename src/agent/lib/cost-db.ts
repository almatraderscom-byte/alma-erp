/**
 * Cost dashboard DB helpers — schema checks + safe Prisma access.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

export function isAgentCostDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /agent_(cost_events|subscriptions|kv_settings)/i.test(msg)
    || /relation .* does not exist/i.test(msg)
    || /P2021|P2010/.test(msg)
    || /Cannot read properties of undefined.*findMany/i.test(msg)
}

/** Probe Phase 8 tables (cheap). */
export async function assertAgentCostSchemaReady(): Promise<void> {
  await prisma.$queryRaw(Prisma.sql`SELECT 1 FROM agent_cost_events LIMIT 1`)
  await prisma.$queryRaw(Prisma.sql`SELECT 1 FROM agent_subscriptions LIMIT 1`)
}

export async function queryCostSumBetween(start: Date, end: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: string | null }>>(
    Prisma.sql`SELECT COALESCE(SUM(cost_usd), 0)::text AS total
      FROM agent_cost_events
      WHERE occurred_at >= ${start} AND occurred_at < ${end}`,
  )
  return parseFloat(rows[0]?.total ?? '0') || 0
}

/** Sum recorded cost events for one conversation in a time window (duty attribution). */
export async function queryConversationCostBetween(
  conversationId: string,
  start: Date,
  end: Date,
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: string | null }>>(
    Prisma.sql`SELECT COALESCE(SUM(cost_usd), 0)::text AS total
      FROM agent_cost_events
      WHERE conversation_id = ${conversationId}
        AND occurred_at >= ${start}
        AND occurred_at <= ${end}`,
  )
  const raw = parseFloat(rows[0]?.total ?? '0') || 0
  return Math.round(raw * 1_000_000) / 1_000_000
}

/**
 * Chat token usage aggregated from cost-event units JSON — ALL chat providers.
 *
 * Was `WHERE provider = 'anthropic'` until the Phase 8 audit: the production head
 * is Grok, so the cache-hit ratio and the "caching broken" alarm never observed
 * the model serving most traffic. `byModel` carries the per-model split so savings
 * can be priced at each model's own rate instead of Sonnet's.
 */
export type PromptCacheUsageRow = {
  cacheReadTokens: number
  cacheCreationTokens: number
  inputTokens: number
  outputTokens: number
  chatTurns: number
  byModel: Array<{
    modelId: string
    cacheReadTokens: number
    inputTokens: number
  }>
}

export async function queryPromptCacheUsageBetween(start: Date, end: Date): Promise<PromptCacheUsageRow> {
  const rows = await prisma.$queryRaw<Array<{
    cache_read: string
    cache_creation: string
    input_tokens: string
    output_tokens: string
    chat_turns: string
  }>>(
    Prisma.sql`SELECT
      COALESCE(SUM(COALESCE((units->>'cache_read_input_tokens')::bigint, 0)), 0)::text AS cache_read,
      COALESCE(SUM(COALESCE((units->>'cache_creation_input_tokens')::bigint, 0)), 0)::text AS cache_creation,
      COALESCE(SUM(COALESCE((units->>'input_tokens')::bigint, 0)), 0)::text AS input_tokens,
      COALESCE(SUM(COALESCE((units->>'output_tokens')::bigint, 0)), 0)::text AS output_tokens,
      COUNT(*)::text AS chat_turns
    FROM agent_cost_events
    WHERE kind = 'chat'
      AND occurred_at >= ${start} AND occurred_at < ${end}`,
  )
  // Per-model split so savings are priced at each model's OWN cached rate.
  const modelRows = await prisma.$queryRaw<Array<{
    model_id: string | null
    cache_read: string
    input_tokens: string
  }>>(
    Prisma.sql`SELECT
      units->>'model' AS model_id,
      COALESCE(SUM(COALESCE((units->>'cache_read_input_tokens')::bigint, 0)), 0)::text AS cache_read,
      COALESCE(SUM(COALESCE((units->>'input_tokens')::bigint, 0)), 0)::text AS input_tokens
    FROM agent_cost_events
    WHERE kind = 'chat'
      AND occurred_at >= ${start} AND occurred_at < ${end}
      AND units->>'model' IS NOT NULL
    GROUP BY units->>'model'`,
  )
  const row = rows[0]
  return {
    cacheReadTokens: parseInt(row?.cache_read ?? '0', 10) || 0,
    cacheCreationTokens: parseInt(row?.cache_creation ?? '0', 10) || 0,
    inputTokens: parseInt(row?.input_tokens ?? '0', 10) || 0,
    outputTokens: parseInt(row?.output_tokens ?? '0', 10) || 0,
    chatTurns: parseInt(row?.chat_turns ?? '0', 10) || 0,
    byModel: modelRows.map((m) => ({
      modelId: m.model_id ?? '',
      cacheReadTokens: parseInt(m.cache_read ?? '0', 10) || 0,
      inputTokens: parseInt(m.input_tokens ?? '0', 10) || 0,
    })),
  }
}
