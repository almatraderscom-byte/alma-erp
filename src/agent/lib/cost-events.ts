/**
 * Unified cost event logging — all billable agent calls go through logCost().
 */
import { prisma } from '@/lib/prisma'
import type { CostKind, CostProvider } from '@/agent/lib/pricing'

export type LogCostInput = {
  provider: CostProvider
  kind: CostKind
  units: Record<string, number | string>
  costUsd: number
  conversationId?: string | null
  jobId?: string | null
  dedupKey?: string | null
  occurredAt?: Date
}

export async function logCost(input: LogCostInput): Promise<{ id: string } | null> {
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  try {
    if (input.dedupKey) {
      const existing = await db.agentCostEvent.findUnique({
        where: { dedupKey: input.dedupKey },
        select: { id: true },
      })
      if (existing) return { id: existing.id as string }
    }

    const row = await db.agentCostEvent.create({
      data: {
        provider: input.provider,
        kind: input.kind,
        units: input.units,
        costUsd: input.costUsd,
        conversationId: input.conversationId ?? null,
        jobId: input.jobId ?? null,
        dedupKey: input.dedupKey ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      },
      select: { id: true },
    })
    return { id: row.id as string }
  } catch (err) {
    // Unique violation on dedup_key — idempotent
    if (input.dedupKey && String(err).includes('Unique constraint')) {
      const existing = await db.agentCostEvent.findUnique({
        where: { dedupKey: input.dedupKey },
        select: { id: true },
      })
      if (existing) return { id: existing.id as string }
    }
    console.error('[cost-events] log failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Sum cost events in a date range (Asia/Dhaka calendar dates as UTC boundaries). */
export async function sumCostUsdBetween(start: Date, end: Date): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const rows: Array<{ total: string | null }> = await db.$queryRawUnsafe(
    `SELECT COALESCE(SUM(cost_usd), 0)::text AS total
     FROM agent_cost_events
     WHERE occurred_at >= $1 AND occurred_at < $2`,
    start,
    end,
  )
  return parseFloat(rows[0]?.total ?? '0') || 0
}

export const BUDGET_KEYS = {
  dailyUsd: 'cost.budget.dailyUsd',
  monthlyUsd: 'cost.budget.monthlyUsd',
} as const

export async function getBudgetSettings(): Promise<{ dailyUsd: number | null; monthlyUsd: number | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const rows = await db.agentKvSetting.findMany({
    where: { key: { in: [BUDGET_KEYS.dailyUsd, BUDGET_KEYS.monthlyUsd] } },
  })
  const map = new Map<string, string>(rows.map((r: { key: string; value: string }) => [r.key, r.value]))
  const daily = map.get(BUDGET_KEYS.dailyUsd)
  const monthly = map.get(BUDGET_KEYS.monthlyUsd)
  return {
    dailyUsd: daily ? parseFloat(daily) : null,
    monthlyUsd: monthly ? parseFloat(monthly) : null,
  }
}
