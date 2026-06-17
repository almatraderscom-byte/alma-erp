/**
 * Fetch current metric values for outcome measurement — real GAS/order data only.
 */
import { getLifestyleOrders } from '@/lib/lifestyle/read'
import { todayYmdDhaka, addDaysYmd } from '@/lib/agent-api/dhaka-date'
import { expandOrderProductLines } from '@/lib/product-size-breakdown'
import { normalizeOrderStatusKey, filterOrdersByDateRange } from '@/lib/order-analytics'
import { getAgentOrdersSummary } from '@/lib/agent-api/orders.service'
import { prisma } from '@/lib/prisma'
import { roundMoney } from '@/lib/money'
import type { Order } from '@/types'

async function fetchRecentOrders(): Promise<Order[]> {
  try {
    const raw = await getLifestyleOrders({ business_id: 'ALMA_LIFESTYLE', limit: '500' })
    return raw.orders ?? []
  } catch (err) {
    console.warn('[outcome-metrics] fetchRecentOrders failed:', err instanceof Error ? err.message : err)
    return []
  }
}

function countProductUnits(orders: Order[], productKey: string): number {
  let total = 0
  const keyLower = productKey.toLowerCase()
  for (const o of orders) {
    if (normalizeOrderStatusKey(String(o.status)) === 'CANCELLED') continue
    for (const line of expandOrderProductLines(o)) {
      const code = (line.code || '').toLowerCase()
      const label = (line.groupLabel || '').toLowerCase()
      if (code === keyLower || label === keyLower || code.includes(keyLower) || label.includes(keyLower)) {
        total += line.qty
      }
    }
  }
  return total
}

export async function getProductUnitsSold(productKey: string, days: number): Promise<number | null> {
  if (!productKey?.trim()) return null
  const today = todayYmdDhaka()
  const from = addDaysYmd(today, -(days - 1))
  const orders = await fetchRecentOrders()
  const filtered = filterOrdersByDateRange(orders, { start: from, end: today })
  if (!filtered.length) return null
  return countProductUnits(filtered, productKey)
}

export async function getSalesTotal7d(): Promise<number | null> {
  try {
    const week = await getAgentOrdersSummary('week')
    return roundMoney(week.totalRevenue)
  } catch (err) {
    console.warn('[outcome-metrics] getSalesTotal7d failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export async function getWinbackReturnCount(
  customerIds: string[],
  sinceIso: string,
): Promise<number | null> {
  if (!customerIds.length) return null
  const since = new Date(sinceIso)
  if (!Number.isFinite(since.getTime())) return null

  const rows = await prisma.csCustomer.findMany({
    where: { id: { in: customerIds } },
    select: { lastOrderAt: true },
  })
  if (!rows.length) return null

  let count = 0
  for (const r of rows) {
    if (r.lastOrderAt && r.lastOrderAt > since) count++
  }
  return count
}

export type MetricFetchResult = { value: number | null; note?: string }

export async function fetchOutcomeMetric(
  metric: string,
  outcome: {
    subjectId?: string | null
    subjectName?: string | null
    rationale?: string | null
    createdAt: Date
  },
): Promise<MetricFetchResult> {
  const productKey = outcome.subjectId || outcome.subjectName || ''

  switch (metric) {
    case 'units_sold_7d': {
      const v = await getProductUnitsSold(productKey, 7)
      return { value: v, note: v == null ? 'insufficient order data' : undefined }
    }
    case 'units_sold_14d': {
      const v = await getProductUnitsSold(productKey, 14)
      return { value: v, note: v == null ? 'insufficient order data' : undefined }
    }
    case 'sales_total_7d': {
      const v = await getSalesTotal7d()
      return { value: v, note: v == null ? 'sales summary unavailable' : undefined }
    }
    case 'winback_return_14d': {
      let ids: string[] = []
      try {
        const parsed = outcome.rationale ? JSON.parse(outcome.rationale) : null
        if (Array.isArray(parsed?.customerIds)) ids = parsed.customerIds
      } catch { /* ignore */ }
      const v = await getWinbackReturnCount(ids, outcome.createdAt.toISOString())
      return { value: v, note: !ids.length ? 'no cohort ids' : undefined }
    }
    default:
      return { value: null, note: `unknown metric: ${metric}` }
  }
}
