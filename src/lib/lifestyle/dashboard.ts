/**
 * Phase 5 — Dashboard/analytics from Postgres orders (replaces GAS getDashboard_ for lifestyle KPIs).
 * Finance/HR/payroll slices still come from GAS (out of migration scope).
 */
import { fetchLifestyleOrdersForMetrics } from '@/lib/lifestyle/read'
import { aggregateDashboardMetrics } from '@/lib/order-analytics'
import { serverGet } from '@/lib/server-api'
import type { DashboardData, Order } from '@/types'

type QueryParams = Record<string, string>

function metricsToDashboard(orders: Order[]): DashboardData {
  const metrics = aggregateDashboardMetrics(orders)
  // Keep pending_count (the native dashboard's "Pending" KPI reads it); only cod_amount
  // is dropped from the wire payload. daily_trend + top_products are additive fields the
  // native Daily-Sales / Top-Products blocks consume (the web '/' page aggregates these
  // client-side, so it never fetched them here).
  const { cod_amount: _cod, ...kpis } = metrics.kpis
  return {
    kpis,
    by_status: metrics.by_status,
    by_source: metrics.by_source,
    by_payment: metrics.by_payment,
    by_category: metrics.by_category,
    sla_breaches: metrics.sla_breaches,
    recent_orders: metrics.recent_orders,
    monthly_trend: metrics.monthly_trend,
    daily_trend: metrics.daily_trend,
    top_products: metrics.top_products,
    generated_at: new Date().toISOString(),
  }
}

const EMPTY_DASHBOARD: DashboardData = {
  kpis: {
    total_orders: 0, total_revenue: 0, total_profit: 0, total_cogs: 0,
    gross_margin: 0, avg_order_value: 0, delivered_count: 0,
    delivery_rate: 0, return_rate: 0, sla_breaches: 0, pending_action: 0,
    returned_count: 0, cancelled_count: 0, failed_delivery_count: 0,
    total_realized_profit: 0, pending_profit: 0, reversed_profit: 0, loss_orders: 0,
    total_returns_loss: 0, net_business_profit: 0,
    returned_paid_count: 0, returned_unpaid_count: 0,
    return_rate_paid: 0, return_rate_refused: 0,
  },
  by_status: {},
  by_source: {},
  by_payment: {},
  by_category: {},
  sla_breaches: [],
  recent_orders: [],
  generated_at: new Date().toISOString(),
}

export async function getLifestyleDashboard(p: QueryParams = {}): Promise<DashboardData> {
  const orders = await fetchLifestyleOrdersForMetrics(p)
  if (!orders.length) return { ...EMPTY_DASHBOARD, generated_at: new Date().toISOString() }
  return metricsToDashboard(orders)
}

export async function getLifestyleAnalytics(p: QueryParams = {}): Promise<DashboardData> {
  const [dash, financeRaw, hrDash] = await Promise.all([
    getLifestyleDashboard(p),
    serverGet<{
      by_category?: Record<string, number>
      total_expenses?: number
      cash_balance?: number
    }>('finance', p, 60).catch(() => null),
    serverGet<{ kpis?: Record<string, number> }>('hr_dashboard', p, 60).catch(() => ({ kpis: {} })),
  ])
  const finance = financeRaw ?? {}
  const hrKpis = (hrDash.kpis ?? {}) as Record<string, number | undefined>
  return {
    ...dash,
    expense_by_cat: finance.by_category,
    total_expenses: finance.total_expenses,
    cash_balance: finance.cash_balance,
    employee_cost_roll: hrKpis.monthly_payroll_budget ?? hrKpis.total_monthly_salary,
    net_business_after_opex: hrKpis.net_business_profit_hint,
    payroll_kpis: Object.fromEntries(
      Object.entries(hrKpis).filter(([, v]) => v != null) as Array<[string, number]>,
    ),
  }
}
