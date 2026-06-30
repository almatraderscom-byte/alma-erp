import { NextRequest } from 'next/server'
import { unstable_cache } from 'next/cache'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { apiFailure, apiDataSuccess } from '@/lib/safe-api-response'
import { withApiRoute } from '@/lib/core/safe-route-helpers'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { getInventoryWithSales } from '@/lib/inventory-with-sales'
import { buildReorderSuggestions } from '@/lib/inventory-forecast'
import { analyzeFinancials } from '@/lib/financial-intelligence'
import { buildCustomerLifetimeDigest } from '@/lib/customer-lifetime'

/**
 * GET /api/insights — Business Intelligence dashboards for the owner.
 *
 * Surfaces three analyzers that already exist in src/lib but were only ever
 * consumed by the agent's tools — never shown as ERP screens:
 *  - inventory-forecast  → reorder urgency + idle (slow-moving) stock
 *  - financial-intelligence → revenue / profit / margin + WoW trends + flags
 *  - customer-lifetime   → VIPs, churn risk, new customers
 *
 * Owner-only (SUPER_ADMIN / ADMIN). Each analyzer is isolated so one slow/failed
 * source still renders the rest. Cached by the Dhaka business date (revalidate
 * 30m); `?refresh=1` recomputes. Pure src/lib — the ERP→agent boundary holds.
 */
async function buildInsights() {
  const [inventoryRes, finance, customers] = await Promise.all([
    getInventoryWithSales().then(products => {
      const reorder = buildReorderSuggestions(products, { leadDays: 7 })
      // Idle capital: in stock but no sales in the last 30 days (heaviest first).
      const slowMovers = products
        .filter(p => p.currentStock > 0 && (p.sales30d ?? 0) === 0)
        .sort((a, b) => b.currentStock - a.currentStock)
        .slice(0, 8)
        .map(p => ({ id: p.id, name: p.name, currentStock: p.currentStock, sales90d: p.sales90d ?? 0 }))
      return { reorder, slowMovers }
    }).catch(() => ({ reorder: [], slowMovers: [] })),
    analyzeFinancials({ days: 30 }).catch(() => null),
    buildCustomerLifetimeDigest().catch(() => null),
  ])

  return {
    reorder: inventoryRes.reorder,
    slowMovers: inventoryRes.slowMovers,
    finance: finance && {
      period: finance.period,
      revenue: finance.revenue,
      expensesTotal: finance.expenses.total,
      adSpend: finance.adSpend,
      grossProfit: finance.grossProfit,
      netProfit: finance.netProfit,
      marginPct: finance.marginPct,
      revenueWoW: finance.trends.revenueWoW ?? null,
      expenseWoW: finance.trends.expenseWoW ?? null,
      flags: finance.flags,
      costDataMissing: finance.costDataMissing,
      topProducts: finance.productBreakdown.slice(0, 5),
    },
    customers: customers && {
      vipCount: customers.vipCount,
      highChurnCount: customers.highChurnCount,
      newThisWeekCount: customers.newThisWeekCount,
      highChurn: customers.highChurn.slice(0, 6),
      topVips: customers.topVips.slice(0, 6),
      notes: customers.notes,
    },
    generatedAt: new Date().toISOString(),
  }
}

const getCachedInsights = unstable_cache(
  async (_date: string) => buildInsights(),
  ['owner-insights'],
  { revalidate: 1800, tags: ['owner-insights'] },
)

export const GET = withApiRoute('insights.get', async (req: NextRequest) => {
  const token = await getJwt(req)
  if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
  const role = normalizeAlmaRole(token.role as string)
  if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
    return apiFailure('forbidden', 'These insights are owner-only', { status: 403 })
  }

  const fresh = new URL(req.url).searchParams.get('refresh') === '1'
  const data = fresh ? await buildInsights() : await getCachedInsights(todayYmdDhaka())

  return apiDataSuccess({ ...data, cached: !fresh }, { headers: { 'Cache-Control': 'private, no-store' } })
})
