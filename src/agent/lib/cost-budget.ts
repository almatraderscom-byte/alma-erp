/**
 * Billable API spend for budget alerts (excludes Oxylabs prepaid credits).
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { queryCostSumBetween } from '@/agent/lib/cost-db'

export async function queryBillableCostSumBetween(start: Date, end: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: string | null }>>(
    Prisma.sql`SELECT COALESCE(SUM(cost_usd), 0)::text AS total
      FROM agent_cost_events
      WHERE occurred_at >= ${start} AND occurred_at < ${end}
        AND provider <> 'oxylabs'`,
  )
  return Math.round((parseFloat(rows[0]?.total ?? '0') || 0) * 1_000_000) / 1_000_000
}

export async function sumBillableCostUsdBetween(start: Date, end: Date): Promise<number> {
  return queryBillableCostSumBetween(start, end)
}

/** Legacy total including all providers (rarely used for owner-facing budget). */
export async function sumCostUsdBetween(start: Date, end: Date): Promise<number> {
  return queryCostSumBetween(start, end)
}

export function formatBudgetPct(spent: number, budget: number): number {
  if (!budget || budget <= 0) return 0
  return Math.round((spent / budget) * 1000) / 10
}
