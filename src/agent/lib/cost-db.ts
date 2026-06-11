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
